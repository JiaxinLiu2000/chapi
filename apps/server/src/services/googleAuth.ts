import { query } from '@anthropic-ai/claude-agent-sdk';
import type { GoogleConnectResponse } from '@chapi/shared';
import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';

const log = createLogger('google-auth');

/**
 * Proactively start Google Workspace authorization from Settings (instead of
 * waiting for the first agent task). Runs a short, tool-only probe through the
 * google_workspace MCP — if auth is needed the MCP yields a consent URL, which
 * we surface so the UI can open it; if access already works it reports connected.
 *
 * Reuses the exact MCP/OAuth path the agent uses, so success here means the
 * agent will be authorized too. Requires real OAuth credentials in Settings.
 */
export async function connectGoogle(): Promise<GoogleConnectResponse> {
  const g = await settings.getGoogleOAuth();
  if (!g.clientId || !g.clientSecret) {
    return { status: 'error', message: '请先在设置里填写 Google OAuth Client ID 与 Secret。' };
  }
  const email = await settings.getGoogleUserEmail();
  const anthropicKey = await settings.getAnthropicKey();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 150_000);

  try {
    const q = query({
      prompt:
        `Establish Google Workspace access${email ? ` for ${email}` : ''}. ` +
        `If a Google auth tool is available (e.g. start_google_auth), call it and output the ` +
        `authorization URL on its own line prefixed EXACTLY with "AUTHURL: ". ` +
        `If access already works (you can list Drive or read the profile), reply EXACTLY "ALREADY_CONNECTED". ` +
        `Do not ask the user anything; be terse.`,
      options: {
        model: (await settings.getModels()).subagent,
        systemPrompt:
          'You are a setup assistant. Only initiate Google authorization and report the consent URL ' +
          '(prefixed "AUTHURL: ") or "ALREADY_CONNECTED". Keep replies under 2 sentences.',
        settingSources: [],
        mcpServers: {
          google_workspace: {
            type: 'stdio',
            command: 'uvx',
            // keep in sync with mcpRegistry: 'extended' exposes Gmail drafts
            args: ['workspace-mcp', '--tool-tier', 'extended'],
            env: {
              GOOGLE_OAUTH_CLIENT_ID: g.clientId,
              GOOGLE_OAUTH_CLIENT_SECRET: g.clientSecret,
              ...(email ? { USER_GOOGLE_EMAIL: email } : {}),
            },
          },
        },
        canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
        maxTurns: 6,
        includePartialMessages: false,
        abortController: abort,
        env: anthropicKey ? { ...process.env, ANTHROPIC_API_KEY: anthropicKey } : process.env,
      },
    });

    let textOut = '';
    for await (const message of q) {
      if (message.type === 'assistant') {
        const content = (message as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<{ type?: string; text?: string }>) {
            if (block?.type === 'text') textOut += block.text ?? '';
          }
        }
      }
    }

    const urlMatch = textOut.match(/AUTHURL:\s*(https?:\/\/\S+)/i);
    if (urlMatch?.[1]) {
      return {
        status: 'authorizing',
        authUrl: urlMatch[1],
        message: '已生成授权链接，请在打开的页面完成 Google 授权后返回。',
      };
    }
    if (/ALREADY_CONNECTED/i.test(textOut)) {
      await settings.setGoogleConnected(true);
      return { status: 'connected', message: 'Google 已连接，可直接使用。' };
    }
    return {
      status: 'error',
      message:
        (textOut.trim().slice(0, 400) || '未能启动 Google 授权。') +
        '（请确认 OAuth 客户端已在 Google Cloud 配置好重定向 URI，且 uvx/workspace-mcp 可运行。）',
    };
  } catch (err) {
    log.warn('google connect failed', err);
    return {
      status: 'error',
      message: `启动 Google 授权失败：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

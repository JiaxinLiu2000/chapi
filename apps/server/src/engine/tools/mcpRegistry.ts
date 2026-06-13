import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { settings } from '../../secrets.js';

const log = createLogger('mcp-registry');

/**
 * Build the external MCP servers to attach to a run, based on settings/env.
 * Each is gated (off by default) because they require installs/credentials.
 * Failed/unavailable servers degrade gracefully (the SDK marks them failed).
 *
 *   CHAPI_ENABLE_CONTEXT7=1   docs lookup (npx @upstash/context7-mcp)
 *   CHAPI_ENABLE_BROWSER=1    cloakbrowser via Playwright MCP over CDP
 *   Google Workspace         auto-enabled when OAuth client id+secret are set in Settings
 *   Settings.canvaEnabled     Canva remote MCP
 */
export async function buildExternalMcpServers(): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {};

  if (process.env.CHAPI_ENABLE_CONTEXT7 === '1') {
    servers.context7 = { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
  }

  // Playwright MCP is OFF by default: its `npx @playwright/mcp` startup is slow
  // and has been observed to hang on init. The agent drives cloakbrowser directly
  // over CDP via the `chapi_browser.py` sandbox helper instead (reliable, scriptable,
  // shown live). Set CHAPI_ENABLE_BROWSER_MCP=1 to also expose the mcp__browser__* tools.
  if ((await settings.getBrowserEnabled()) && process.env.CHAPI_ENABLE_BROWSER_MCP === '1') {
    servers.browser = {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@playwright/mcp@latest',
        '--cdp-endpoint',
        `http://127.0.0.1:${config.cloakbrowserCdpPort}`,
      ],
    };
  }

  // Google Workspace: enabled whenever OAuth credentials are configured (Settings
  // or env). No separate enable flag — configuring credentials IS the opt-in.
  // First Google tool call triggers the browser OAuth consent flow.
  {
    const google = await settings.getGoogleOAuth();
    if (google.clientId && google.clientSecret) {
      const userEmail = await settings.getGoogleUserEmail();
      servers.google_workspace = {
        type: 'stdio',
        command: 'uvx',
        // --single-user: use the cached OAuth credentials directly (no per-session
        // mapping) so tools work in normal agent runs.
        // --tool-tier extended: registers Gmail's draft_gmail_message (not in 'core').
        // Sending is still blocked by permissions.ts + disallowedToolsFor.
        args: ['workspace-mcp', '--single-user', '--tool-tier', 'extended'],
        env: {
          GOOGLE_OAUTH_CLIENT_ID: google.clientId,
          GOOGLE_OAUTH_CLIENT_SECRET: google.clientSecret,
          ...(userEmail ? { USER_GOOGLE_EMAIL: userEmail } : {}),
        },
      };
    }
  }

  if (await settings.getCanvaEnabled()) {
    servers.canva = { type: 'http', url: 'https://mcp.canva.com/mcp' };
  }

  if (Object.keys(servers).length > 0) {
    log.info(`external MCP servers enabled: ${Object.keys(servers).join(', ')}`);
  }
  return servers;
}

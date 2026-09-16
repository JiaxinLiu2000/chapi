import { query } from '@anthropic-ai/claude-agent-sdk';
import { settings } from '../secrets.js';
import { chooseActiveAccount } from './accounts.js';

/**
 * One-shot LLM completion for summaries & consolidation.
 *
 * Routed through the Agent SDK `query()` (not the raw Anthropic API SDK) so it
 * uses the same auth as the engine — including this machine's existing Claude
 * Code credentials. No explicit ANTHROPIC_API_KEY is required; if one is set in
 * Settings it is used, otherwise the subprocess inherits the machine login.
 */
export async function llmAvailable(): Promise<boolean> {
  // Generally available via machine credentials; callers degrade gracefully on error.
  return true;
}

export async function complete(opts: {
  prompt: string;
  system?: string;
  model?: string;
}): Promise<string> {
  const key = await settings.getAnthropicKey();
  const acct = await chooseActiveAccount();
  const model = opts.model ?? (await settings.getModels()).subagent;
  const authEnv = acct.token
    ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: acct.token }
    : key
      ? { ...process.env, ANTHROPIC_API_KEY: key }
      : process.env;

  const q = query({
    prompt: opts.prompt,
    options: {
      model,
      ...(opts.system ? { systemPrompt: opts.system } : {}),
      settingSources: [],
      tools: [],
      allowedTools: [],
      mcpServers: {},
      maxTurns: 1,
      includePartialMessages: false,
      env: authEnv,
    },
  });

  let text = '';
  for await (const message of q) {
    if (message.type === 'assistant') {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block?.type === 'text') text += block.text ?? '';
        }
      }
    }
  }
  return text.trim();
}

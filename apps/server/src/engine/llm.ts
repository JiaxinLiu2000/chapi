import { query } from '@anthropic-ai/claude-agent-sdk';
import { prisma } from '../db/client.js';
import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';
import { chooseActiveAccount } from './accounts.js';

const log = createLogger('engine:llm');

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
  accountMode?: 'auto' | 'primary' | 'fallback';
  sessionId?: string; // when set, this call is logged to the usage ledger
  trigger?: 'summarize' | 'consolidate';
}): Promise<string> {
  const key = await settings.getAnthropicKey();
  const acct = await chooseActiveAccount(opts.accountMode);
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
  let usage: { input_tokens?: number; output_tokens?: number } = {};
  let costUsd = 0;
  for await (const message of q) {
    if (message.type === 'assistant') {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block?.type === 'text') text += block.text ?? '';
        }
      }
    } else if (message.type === 'result') {
      const rm = message as { usage?: typeof usage; total_cost_usd?: number };
      usage = rm.usage ?? {};
      costUsd = rm.total_cost_usd ?? 0;
    }
  }

  if (opts.sessionId && acct.name !== 'machine') {
    await prisma.usageEvent
      .create({
        data: {
          sessionId: opts.sessionId,
          account: acct.name,
          trigger: opts.trigger ?? 'summarize',
          model,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          costUsd,
        },
      })
      .catch((err) => log.warn('usage event create failed', err));
  }

  return text.trim();
}

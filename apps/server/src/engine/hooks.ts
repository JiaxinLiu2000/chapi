import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../logger.js';
import type { RunMonitor } from './monitoring.js';

const log = createLogger('hooks');

const CONTINUE: HookJSONOutput = { continue: true };

/** Second-level local clock, e.g. "20:33:07". */
const clock = (): string => new Date().toTimeString().slice(0, 8);

/** Hooks that feed the monitoring layer + keep the model time-aware. */
export function buildHooks(
  monitor: RunMonitor,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guard = async (fn: () => Promise<void>): Promise<HookJSONOutput> => {
    try {
      await fn();
    } catch (err) {
      log.warn('hook handler error', err);
    }
    return CONTINUE;
  };

  return {
    UserPromptSubmit: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'UserPromptSubmit') return CONTINUE;
            const now = new Date();
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext:
                  `[现在 ${now.toISOString()}（本地 ${clock()} ${tz}）] ` +
                  '注意时间：调用任何工具都要设合理超时；简单操作十几秒还没结果就怀疑卡住，' +
                  '不要干等——果断中止/重试或换方法。',
              },
            };
          },
        ],
      },
    ],
    PreToolUse: [
      {
        hooks: [
          (input) =>
            guard(async () => {
              if (input.hook_event_name === 'PreToolUse') await monitor.onPreTool(input);
            }),
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === 'PostToolUse') {
              try {
                await monitor.onPostTool(input);
              } catch (err) {
                log.warn('hook handler error', err);
              }
            }
            // Running clock after each tool so the model notices long gaps/hangs.
            return {
              continue: true,
              hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[现在 ${clock()}]` },
            };
          },
        ],
      },
    ],
    SubagentStart: [
      {
        hooks: [
          (input) =>
            guard(async () => {
              if (input.hook_event_name === 'SubagentStart') await monitor.onSubagentStart(input);
            }),
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          (input) =>
            guard(async () => {
              if (input.hook_event_name === 'SubagentStop') await monitor.onSubagentStop(input);
            }),
        ],
      },
    ],
  };
}

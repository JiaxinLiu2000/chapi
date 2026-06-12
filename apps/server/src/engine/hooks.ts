import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '../logger.js';
import type { RunMonitor } from './monitoring.js';

const log = createLogger('hooks');

const CONTINUE: HookJSONOutput = { continue: true };

/** Hooks that feed the monitoring layer. They observe only — never block. */
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
          (input) =>
            guard(async () => {
              if (input.hook_event_name === 'PostToolUse') await monitor.onPostTool(input);
            }),
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

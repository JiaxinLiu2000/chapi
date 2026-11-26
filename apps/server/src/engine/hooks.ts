import type {
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { prisma } from '../db/client.js';
import { recallBlock, toolFamily } from '../knowledge/recall.js';
import { createLogger } from '../logger.js';
import type { RunMonitor } from './monitoring.js';
import { countToolSincePlan } from './plan.js';
import { workflowEngine } from '../workflow/engine.js';
import { decideBoardTool, decideMemoryAccess, decideSubmit, decideTask, extractToken, takeTaskPrompt } from '../workflow/guards.js';
import { sessionPaths } from '../config.js';
import { SUBMIT_TOOL, SUBSTEP_TOOL } from '../workflow/tools.js';

const log = createLogger('hooks');

const CONTINUE: HookJSONOutput = { continue: true };
const deny = (reason: string): HookJSONOutput => ({
  continue: true,
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/** Second-level local clock, e.g. "20:33:07". */
const clock = (): string => new Date().toTimeString().slice(0, 8);

/** Remind about the task flow after this many main-agent tool calls without a plan update. */
const PLAN_NUDGE_EVERY = 15;
const PLAN_TOOLS = new Set(['mcp__chapi__set_plan', 'mcp__chapi__update_plan_step']);

/**
 * Hooks that feed the monitoring layer, keep the model time-aware, enforce the
 * task-flow discipline (the learning agent learns from step transitions, so the
 * plan must stay current) and push knowledge-graph recall at the right moments:
 * first use of a tool family, and every sub-agent start.
 */
export function buildHooks(
  monitor: RunMonitor,
  sessionId: string,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guard = async (fn: () => Promise<void>): Promise<HookJSONOutput> => {
    try {
      await fn();
    } catch (err) {
      log.warn('hook handler error', err);
    }
    return CONTINUE;
  };

  const recalledFamilies = new Set<string>(); // per run: inject tool knowledge once per family
  const memoryModes = new Map<string, 'none' | 'skills' | null>(); // sub-agent → its stage's memory policy
  const memoryModeOf = async (agentId: string | undefined) => {
    if (!agentId) return null;
    if (!memoryModes.has(agentId)) memoryModes.set(agentId, await workflowEngine.memoryModeOf(sessionId, agentId).catch(() => null));
    return memoryModes.get(agentId) ?? null;
  };
  const taskPrompts: string[] = []; // Task prompts waiting for their SubagentStart

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
          async (input) => {
            if (input.hook_event_name !== 'PreToolUse') return CONTINUE;
            try {
              await monitor.onPreTool(input);
            } catch (err) {
              log.warn('hook handler error', err);
            }
            // Workflow: during a run, sub-agents must carry the current stage token,
            // and only the sub-agent a token was bound to may submit its evidence.
            if (input.tool_name === SUBMIT_TOOL || input.tool_name === SUBSTEP_TOOL) {
              const ti = (input.tool_input ?? {}) as Record<string, unknown>;
              const token = String(ti.token ?? '').trim();
              const owner = await workflowEngine.tokenOwner(sessionId, token).catch(() => null);
              const why = decideSubmit({ agentId: input.agent_id, token, owner });
              if (why) return deny(why);
              return {
                continue: true,
                hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, _agentId: input.agent_id } },
              };
            }
            const boardWhy = decideBoardTool({ toolName: input.tool_name, agentId: input.agent_id });
            if (boardWhy) return deny(boardWhy);
            if (input.tool_name === 'Task' || input.tool_name === 'Agent') {
              const ti = input.tool_input as { prompt?: string; description?: string; subagent_type?: string; run_in_background?: boolean } | null;
              if (!input.agent_id) {
                const run = await workflowEngine.activeRun(sessionId).catch(() => null);
                const current = run?.pendingToken ? await workflowEngine.tokenOwner(sessionId, run.pendingToken).catch(() => null) : null;
                const why = decideTask({ run, prompt: ti?.prompt ?? '', subagentType: ti?.subagent_type, current, background: ti?.run_in_background === true });
                if (why) return deny(why);
              }
              taskPrompts.push((ti?.prompt ?? ti?.description ?? '').trim());
            }
            // SOP stages set to "no memory" are pure tools: no knowledge graph, no memory dir.
            const memMode = await memoryModeOf(input.agent_id);
            const memWhy = decideMemoryAccess({ mode: memMode, toolName: input.tool_name, input: input.tool_input, memoryDir: sessionPaths(sessionId).memory });
            if (memWhy) return deny(memWhy);
            // First use of a tool family in this run → what the graph knows about it
            // (stage sub-agents: tool know-how only, and nothing for memory-free stages).
            const fam = memMode === 'none' ? null : toolFamily(input.tool_name, input.tool_input);
            const famKey = fam ? `${input.agent_id ?? 'main'}:${fam.key}` : '';
            if (fam && !recalledFamilies.has(famKey)) {
              recalledFamilies.add(famKey);
              const recall = await recallBlock(fam.query, {
                heading: `[知识图谱·使用 ${fam.key} 前的已有经验]`,
                kinds: memMode === 'skills' ? ['skill'] : ['skill', 'preference'],
                k: 5,
                minRelevance: 0.3,
              }).catch(() => null);
              if (recall) return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: recall } };
            }
            return CONTINUE;
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'PostToolUse') return CONTINUE;
            try {
              await monitor.onPostTool(input);
            } catch (err) {
              log.warn('hook handler error', err);
            }
            let ctx = `[现在 ${clock()}]`;
            // Workflow: a stage's sub-agent just returned → hand the main AI its review sheet.
            if (!input.agent_id && (input.tool_name === 'Task' || input.tool_name === 'Agent')) {
              const sheet = await workflowEngine.reviewSheet(sessionId).catch(() => null);
              if (sheet) ctx += `\n${sheet}`;
            }
            // Plan discipline (main agent only; sub-agents don't own the plan).
            if (!input.agent_id && !PLAN_TOOLS.has(input.tool_name) && !input.tool_name.startsWith('mcp__chapi__')) {
              const n = countToolSincePlan(sessionId);
              if (n === 3 || n % PLAN_NUDGE_EVERY === 0) {
                const plan = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } }).catch(() => []);
                if (!plan.length) {
                  ctx += ' [任务流] 还没有任务流：先用 set_plan 建一个（左侧面板实时展示，学习代理也靠它学习）。';
                } else if (n % PLAN_NUDGE_EVERY === 0 && (await workflowEngine.activeRun(sessionId).catch(() => null))) {
                  const st = await workflowEngine.statusText(sessionId).catch(() => '');
                  ctx += ` [工作流] 已连续 ${n} 次工具调用。当前进度：${st.split('\n')[0]}。阶段工作交给带令牌的副 AI，你负责领取、派发、审核。`;
                } else if (n % PLAN_NUDGE_EVERY === 0) {
                  const cur = plan.find((t) => t.status === 'in_progress');
                  ctx += ` [任务流] 已连续 ${n} 次工具调用没有更新任务流。${cur ? `当前进行中：「${cur.text}」。` : '没有标为进行中的步骤。'}请用 update_plan_step 如实更新：完成→done；遇到问题→problem；失败→failed；在等→blocked；换方案→replaced（写 reason 和 replacement）。`;
                }
              }
            }
            return { continue: true, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: ctx } };
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'Stop') return CONTINUE;
            // A running SOP isn't finished: keep the turn going (engine caps it at 2 nudges per stage).
            const wf = await workflowEngine.turnEndReminder(sessionId).catch(() => null);
            if (wf) return { continue: true, hookSpecificOutput: { hookEventName: 'Stop', additionalContext: wf } };
            if (input.stop_hook_active) return CONTINUE;
            // Ending the turn with steps still open: remind once (the turn continues so it can fix the plan).
            const open = await prisma.planTask
              .findMany({ where: { sessionId, status: 'in_progress', locked: false }, orderBy: { ordinal: 'asc' } })
              .catch(() => []);
            if (!open.length) return CONTINUE;
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'Stop',
                additionalContext: `[任务流] 你要结束这一轮了，但这些步骤仍是"进行中"：${open.map((t) => `「${t.text}」`).join('、')}。请先用 update_plan_step 如实更新（已完成→done；在等用户→blocked 并写原因；失败/换方案也要标），然后再结束。`,
              },
            };
          },
        ],
      },
    ],
    SubagentStart: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'SubagentStart') return CONTINUE;
            try {
              await monitor.onSubagentStart(input);
            } catch (err) {
              log.warn('hook handler error', err);
            }
            // A sub-agent starts with an empty context → hand it the relevant knowledge.
            const run = await workflowEngine.activeRun(sessionId).catch(() => null);
            const task = takeTaskPrompt(taskPrompts, run?.pendingToken ?? null, input.agent_type);
            if (!task) return CONTINUE;
            // A workflow stage's sub-agent gets its stage card (SOP text, inputs, criteria, evidence fields).
            if (extractToken(task)) {
              const card = await workflowEngine.bindAgent(sessionId, input.agent_id, task).catch((err) => {
                log.warn('workflow bind failed', err);
                return null;
              });
              if (card) return { continue: true, hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: card } };
              log.warn(`workflow bind miss: agent ${input.agent_id} (${input.agent_type}) task token ${extractToken(task)} pending ${run?.pendingToken ?? '-'}`);
            }
            const recall = await recallBlock(task, { heading: '[知识图谱·与这个子任务相关的已有知识点]', k: 8 }).catch(() => null);
            if (!recall) return CONTINUE;
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'SubagentStart',
                additionalContext: `${recall}\n需要更多时可调用 mcp__chapi__wiki_search / wiki_read。`,
              },
            };
          },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== 'SubagentStop') return CONTINUE;
            // A workflow stage's sub-agent may not stop before submitting evidence.
            const nudge = await workflowEngine.onSubagentStop(sessionId, input.agent_id).catch(() => null);
            if (nudge) return { continue: true, hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: nudge } };
            return guard(async () => {
              await monitor.onSubagentStop(input);
            });
          },
        ],
      },
    ],
  };
}

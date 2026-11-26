import type { WorkflowRunDTO } from '@chapi/shared';

/** Pure allow/deny decisions the SDK hooks apply while a workflow run is active. */

export const TOKEN_RE = /\[(WF-[a-z0-9]{6})\]/;
const ANY_TOKEN_RE = /\[WF-[a-z0-9]{6}\]/;

export function extractToken(text: string): string | null {
  return TOKEN_RE.exec(text ?? '')?.[1] ?? null;
}

/** Read-only helpers the main AI may still spawn mid-run; never bound to a stage. */
export const FREE_SUBAGENT_TYPES = new Set(['Explore']);

/** Main AI calling Task/Agent: during a run every sub-agent must carry the current stage token. */
export function decideTask(a: {
  run: WorkflowRunDTO | null;
  prompt: string;
  subagentType?: string;
  /** The current stage's node run (status + bound sub-agent). */
  current?: { status: string; agentId: string | null } | null;
  background?: boolean;
}): string | null {
  if (!a.run) return null;
  if (a.subagentType && FREE_SUBAGENT_TYPES.has(a.subagentType)) return null;
  const name = `工作流「${a.run.workflowName}」`;
  if (!a.run.pendingToken) {
    return `${name}进行中：派副 AI 之前先调用 workflow_next_stage 领取阶段，拿到令牌后 prompt 第一行写 [令牌]。（只读查找可用 subagent_type="Explore"。）`;
  }
  const t = extractToken(a.prompt);
  if (t !== a.run.pendingToken) {
    return `${name}进行中：这个 Task 的 prompt 第一行必须是当前阶段的令牌 [${a.run.pendingToken}]${t ? `（你写的是 ${t}，已过期）` : ''}。阶段工作只能交给带令牌的副 AI。`;
  }
  if (a.current && a.current.status === 'submitted') {
    return `${name}：这个阶段已经提交了证据，不能再派副 AI。请用 workflow_status 看审核对照表，再调用 workflow_review_stage。`;
  }
  if (a.current && (a.current.status !== 'dispatched' || a.current.agentId)) {
    return `${name}：令牌 [${a.run.pendingToken}] 已经派给一个副 AI 了，一个令牌只能派一次。如果那个副 AI 已经异常结束、不会再提交，调用 workflow_next_stage({force:true}) 领取新令牌后再派。`;
  }
  if (a.background) {
    return `${name}：阶段副 AI 不能用 run_in_background 后台运行（你需要等它交完证据再审核）。去掉 run_in_background 重新调用。`;
  }
  return null;
}

/**
 * SubagentStart: pick which queued Task prompt belongs to the sub-agent that just
 * started. A stage agent takes the entry carrying the pending token (wherever it
 * sits — parallel Explore Tasks may start in any order) and stale token entries
 * from Tasks that never started are dropped. Explore agents never take a token
 * entry. With no run, plain FIFO.
 */
export function takeTaskPrompt(queue: string[], pendingToken: string | null, agentType: string | undefined): string | undefined {
  if (!pendingToken) return queue.shift();
  if (agentType && FREE_SUBAGENT_TYPES.has(agentType)) {
    const i = queue.findIndex((q) => !ANY_TOKEN_RE.test(q));
    return i >= 0 ? queue.splice(i, 1)[0] : undefined;
  }
  const i = queue.findIndex((q) => q.includes(`[${pendingToken}]`));
  if (i < 0) return queue.shift();
  const hit = queue[i]!;
  // Drop the hit and any stale token entries (older tokens can never bind again).
  for (let j = queue.length - 1; j >= 0; j--) {
    if (j === i || (ANY_TOKEN_RE.test(queue[j]!) && !queue[j]!.includes(`[${pendingToken}]`))) queue.splice(j, 1);
  }
  return hit;
}

const WIKI_READ_TOOLS = new Set(['mcp__chapi__wiki_search', 'mcp__chapi__wiki_read']);
const PATH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'Bash', 'PowerShell', 'NotebookRead']);

/** A memory-free stage's sub-agent may not read the knowledge graph or the session memory dir. */
export function decideMemoryAccess(a: {
  mode: 'none' | 'skills' | null;
  toolName: string;
  input: unknown;
  memoryDir: string;
}): string | null {
  if (a.mode !== 'none') return null;
  const why = '本阶段不使用记忆（SOP 节点设为纯工具）：只依据 SOP 原文、输入材料和这次实际查到的事实判断。';
  if (WIKI_READ_TOOLS.has(a.toolName)) return `${why}不能查知识库。`;
  if (PATH_TOOLS.has(a.toolName)) {
    // JSON-escaped Windows paths double their backslashes: collapse any run of separators.
    const norm = (s: string) => s.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    if (norm(JSON.stringify(a.input ?? {})).includes(norm(a.memoryDir))) return `${why}不能读会话记忆目录。`;
  }
  return null;
}

/** workflow_submit_stage: only the sub-agent the token was bound to may submit. */
export function decideSubmit(a: {
  agentId?: string;
  token: string;
  owner: { agentId: string | null; status: string } | null;
}): string | null {
  if (!a.agentId) return '只有执行该阶段的副 AI 才能提交证据。主 AI 请用 Task 派副 AI 执行，副 AI 结束后你用 workflow_review_stage 审核。';
  if (!a.owner) return `令牌 ${a.token} 无效或已过期（本阶段可能已被返工或重新派发）。停止工作，在最后回复里说明情况。`;
  if (a.owner.agentId !== a.agentId) return `令牌 ${a.token} 不是派给你的，不能提交。`;
  return null;
}

/**
 * The automation-registry tools (/board) are for the main AI only: a sub-agent
 * (an SOP stage agent in particular) must never schedule, delete or start tasks.
 */
export function decideBoardTool(a: { toolName: string; agentId: string | undefined }): string | null {
  if (!a.agentId || !a.toolName.startsWith('mcp__chapi__automation_')) return null;
  return '自动化面板工具（automation_*）只能由主 AI 使用，副 AI（包括 SOP 阶段的副 AI）不能调用。需要的话在提交的证据/总结里说明，由主 AI 处理。';
}

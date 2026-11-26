/**
 * Workflow (SOP) runs and the task flow, rendered for a phone-sized Discord thread.
 * Pure functions: the bridge decides when to post / edit.
 */
import type { NodeRunStatus, PlanTaskDTO, WorkflowNodeDef, WorkflowNodeRunDTO, WorkflowRunDTO } from '@chapi/shared';
import { toPlainText } from '../remote/format.js';

export const STAGE_LABEL: Record<NodeRunStatus, string> = {
  pending: '未开始',
  dispatched: '副 AI 执行中',
  submitted: '待主 AI 审核',
  redo: '返工中',
  done: '已完成',
  skipped: '已跳过',
  external: '外部已完成',
  failed: '失败',
  blocked: '受阻',
  waiting_user: '等你确认',
};

const STAGE_ICON: Record<NodeRunStatus, string> = {
  pending: '⚪',
  dispatched: '🔵',
  submitted: '🟡',
  redo: '↩️',
  done: '✅',
  skipped: '⏭️',
  external: '☑️',
  failed: '❌',
  blocked: '⛔',
  waiting_user: '🟠',
};

const RUN_LABEL: Record<WorkflowRunDTO['status'], string> = {
  running: '进行中',
  waiting_user: '等你确认',
  blocked: '受阻',
  done: '全部完成',
  cancelled: '已停止',
  failed: '失败',
};

export const ACTIVE_RUN = new Set<WorkflowRunDTO['status']>(['running', 'waiting_user', 'blocked']);

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Stage nodes in execution order (follow the edges from start; same as the web canvas). */
export function runSteps(run: WorkflowRunDTO): WorkflowNodeDef[] {
  const next = new Map(run.graph.edges.map((e) => [e.from, e.to]));
  const byId = new Map(run.graph.nodes.map((n) => [n.id, n]));
  const out: WorkflowNodeDef[] = [];
  const seen = new Set<string>();
  let cur = run.graph.nodes.find((n) => n.type === 'start')?.id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (n?.type === 'step') out.push(n);
    cur = next.get(cur);
  }
  return out;
}

export function nodeRunOf(run: WorkflowRunDTO, nodeId: string): WorkflowNodeRunDTO | undefined {
  return run.nodeRuns.find((n) => n.nodeId === nodeId);
}

/** Overall 0-100 (mean of stage progress; 100 when done) — same as the web card. */
export function runProgress(run: WorkflowRunDTO): number {
  const steps = runSteps(run);
  if (!steps.length) return 0;
  if (run.status === 'done') return 100;
  return Math.round(steps.reduce((s, n) => s + (nodeRunOf(run, n.id)?.progress ?? 0), 0) / steps.length);
}

/** The stage title without its "阶段 N" prefix (we number by position). */
export function shortTitle(title: string): string {
  return title.replace(/^阶段\s*[\d.]+\s*/, '').trim() || title;
}

export function bar(pct: number, width = 10): string {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▰'.repeat(full) + '▱'.repeat(width - full);
}

function substepLines(node: WorkflowNodeDef, nr: WorkflowNodeRunDTO | undefined, index: number, withNotes: boolean): string[] {
  const defs = node.substeps ?? [];
  return defs.map((d, j) => {
    const st = nr?.substeps.find((x) => x.id === d.id);
    const mark = st?.status === 'done' ? '✓' : st?.status === 'na' ? '—' : '◻';
    const note = withNotes && st?.note ? `：${clip(toPlainText(st.note), 120)}` : '';
    return `　${mark} ${index}.${j + 1} ${clip(d.title, 60)}${note}`;
  });
}

/** The live progress card: stages with status, the current stage's sub-steps, overall %. */
export function renderRunCard(run: WorkflowRunDTO): string {
  const steps = runSteps(run);
  const pct = runProgress(run);
  const head = `🧭 **${clip(run.workflowName, 60)}** · v${run.version}${run.label ? ` · ${clip(run.label, 40)}` : ''}`;
  const state = run.status === 'cancelled' ? '⏹ 已停止' : `${bar(pct)} **${pct}%** · ${RUN_LABEL[run.status]}`;
  const lines = [head, state];
  steps.forEach((n, i) => {
    const nr = nodeRunOf(run, n.id);
    const st = nr?.status ?? 'pending';
    const isCur = run.cursor?.nodeId === n.id && ACTIVE_RUN.has(run.status);
    const extra = isCur || !['pending', 'done'].includes(st) ? ` · ${STAGE_LABEL[st]}${isCur && nr && nr.progress < 100 && nr.progress > 0 ? ` ${nr.progress}%` : ''}` : '';
    const attempt = nr && nr.attempts > 1 ? ` · 第 ${nr.attempts} 次` : '';
    lines.push(`${STAGE_ICON[st]} ${i + 1}. ${isCur ? '**' : ''}${clip(shortTitle(n.title), 50)}${isCur ? '**' : ''}${extra}${attempt}`);
    if (isCur) lines.push(...substepLines(n, nr, i + 1, false));
  });
  return lines.join('\n');
}

/** One stage in full: status, sub-steps with notes, the sub-agent's summary, the main AI's review. */
export function renderStageDetail(run: WorkflowRunDTO, nodeId: string): string {
  const steps = runSteps(run);
  const i = steps.findIndex((n) => n.id === nodeId);
  const node = steps[i];
  if (!node) return '找不到这个阶段。';
  const nr = nodeRunOf(run, nodeId);
  const st = nr?.status ?? 'pending';
  const lines = [`🔍 **阶段 ${i + 1}/${steps.length}：${shortTitle(node.title)}**`, `${STAGE_ICON[st]} ${STAGE_LABEL[st]} · ${nr?.progress ?? 0}%${nr && nr.attempts > 1 ? ` · 第 ${nr.attempts} 次` : ''}`];
  const subs = substepLines(node, nr, i + 1, true);
  if (subs.length) lines.push('', '**子步骤**', ...subs);
  if (node.doneCriteria?.length) {
    lines.push('', '**完成标准**');
    for (const c of node.doneCriteria) {
      const v = nr?.review?.perCriterion.find((x) => x.criterion === c);
      lines.push(`- ${v ? (v.verdict === 'met' ? '✓ ' : '— ') : ''}${clip(c, 120)}${v?.reason ? `（${clip(v.reason, 80)}）` : ''}`);
    }
  }
  if (nr?.summary) lines.push('', '**副 AI 交付**', clip(toPlainText(nr.summary), 700));
  if (nr?.evidence && Object.keys(nr.evidence).length) {
    lines.push('', '**证据**');
    for (const [k, v] of Object.entries(nr.evidence).slice(0, 8)) {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      lines.push(`- ${k}：${clip(val ?? '', 120)}`);
    }
  }
  if (nr?.review) lines.push('', `**主 AI 审核**：${nr.review.decision === 'accept' ? '✓ 通过' : '↩️ 打回返工'}${nr.review.feedback ? ` — ${clip(nr.review.feedback, 300)}` : ''}`);
  return lines.join('\n');
}

/**
 * Transitions worth a (notifying) thread message: a stage finished / got stuck /
 * was sent back, the run ended. Silent card edits cover everything else.
 */
export function stageEvents(prev: WorkflowRunDTO | undefined, next: WorkflowRunDTO): string[] {
  const steps = runSteps(next);
  const out: string[] = [];
  steps.forEach((n, i) => {
    const before = prev ? nodeRunOf(prev, n.id)?.status : undefined;
    const after = nodeRunOf(next, n.id)?.status;
    if (!after || before === after || (!prev && after === 'pending')) return;
    if (!prev && after !== 'done' && after !== 'failed' && after !== 'blocked') return;
    const name = `阶段 ${i + 1}/${steps.length}「${clip(shortTitle(n.title), 40)}」`;
    if (after === 'done') out.push(`✅ ${name}完成`);
    else if (after === 'redo') out.push(`↩️ ${name}被打回返工`);
    else if (after === 'blocked') out.push(`⛔ ${name}受阻`);
    else if (after === 'failed') out.push(`❌ ${name}失败`);
    else if (after === 'waiting_user') out.push(`🟠 ${name}等你确认`);
  });
  if (prev && prev.status !== next.status) {
    if (next.status === 'done') out.push(`🏁 工作流「${clip(next.workflowName, 40)}」全部完成`);
    else if (next.status === 'cancelled') out.push(`⏹ 工作流「${clip(next.workflowName, 40)}」已停止`);
    else if (next.status === 'failed') out.push(`❌ 工作流「${clip(next.workflowName, 40)}」失败`);
  }
  return out;
}

const PLAN_ICON: Record<string, string> = { pending: '⚪', in_progress: '🔵', done: '✅', failed: '❌', problem: '⚠️', blocked: '⛔' };

/** The task flow (the model's own plan steps; workflow-owned rows are on the run card) — same rows as the web canvas. */
export function renderPlan(title: string, tasks: PlanTaskDTO[]): string {
  const live = tasks.filter((t) => !t.locked && t.status !== 'replaced' && t.status !== 'error').sort((a, b) => a.ordinal - b.ordinal);
  if (!live.length) return '这个任务还没有任务流（计划步骤）。';
  const done = live.filter((t) => t.status === 'done').length;
  const pct = Math.round(live.reduce((s, t) => s + (t.status === 'done' ? 100 : t.status === 'in_progress' ? 50 : 0), 0) / live.length);
  const lines = [`🗂 **任务流 · ${clip(title, 50)}**`, `${bar(pct)} **${pct}%** · ${done}/${live.length} 步`];
  for (const t of live) {
    const why = (t.status === 'problem' || t.status === 'blocked' || t.status === 'failed') && t.reason ? `（${clip(toPlainText(t.reason), 60)}）` : '';
    lines.push(`${t.depth ? '　' : ''}${PLAN_ICON[t.status] ?? '⚪'} ${clip(toPlainText(t.text).replace(/^\d+[.、]\s*/, ''), 70)}${why}`);
  }
  return lines.join('\n');
}

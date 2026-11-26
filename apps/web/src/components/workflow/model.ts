import type { WorkflowNodeDef, WorkflowNodeRunDTO, WorkflowRunDTO } from '@chapi/shared';

/** Stage nodes of a run in execution order (linear graphs: follow the edges from start). */
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

export function runProgress(run: WorkflowRunDTO): number {
  const steps = runSteps(run);
  if (!steps.length) return 0;
  if (run.status === 'done') return 100;
  return Math.round(steps.reduce((s, n) => s + (nodeRunOf(run, n.id)?.progress ?? 0), 0) / steps.length);
}

/** The stage title without its "阶段 N" prefix (the canvas numbers by position). */
export function shortTitle(title: string): string {
  return title.replace(/^阶段\s*[\d.]+\s*/, '').trim() || title;
}

export const STATUS_LABEL: Record<string, string> = {
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

export type NodeTone = 'idle' | 'active' | 'review' | 'done' | 'problem';
export function toneOf(status: string | undefined): NodeTone {
  switch (status) {
    case 'dispatched':
    case 'redo':
      return 'active';
    case 'submitted':
    case 'waiting_user':
      return 'review';
    case 'done':
    case 'skipped':
    case 'external':
      return 'done';
    case 'failed':
    case 'blocked':
      return 'problem';
    default:
      return 'idle';
  }
}

export interface SnakeSlot {
  x: number;
  y: number;
  /** flow direction of this slot's row: 1 = left→right, -1 = right→left */
  dir: 1 | -1;
  row: number;
}

/**
 * Boustrophedon layout for a single line of `count` items in a box `width` wide:
 * as many per row as fit at `pitch`, rows alternate direction so the line snakes
 * down instead of running off to the right.
 */
export function snakeLayout(count: number, width: number, pitch: number, rowHeight: number, itemWidth: number): { slots: SnakeSlot[]; cols: number } {
  const usable = Math.max(itemWidth, width - 48);
  const cols = Math.max(2, Math.floor((usable - itemWidth) / pitch) + 1);
  const rowWidth = (cols - 1) * pitch + itemWidth;
  const left = Math.max(24, (width - rowWidth) / 2);
  const slots: SnakeSlot[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / cols);
    const k = i % cols;
    const dir: 1 | -1 = row % 2 === 0 ? 1 : -1;
    const col = dir === 1 ? k : cols - 1 - k;
    slots.push({ x: left + col * pitch, y: row * rowHeight, dir, row });
  }
  return { slots, cols };
}

/** A plain task-flow step (the main AI's own set_plan, not a workflow run). */
export interface PlanStep {
  id: string;
  title: string;
  status: string;
  /** 0-100; plain steps have no sub-steps, so a running one shows half */
  progress: number;
  tone: NodeTone;
}

const PLAN_TONE: Record<string, NodeTone> = {
  pending: 'idle',
  in_progress: 'active',
  done: 'done',
  problem: 'review',
  blocked: 'review',
  failed: 'problem',
  error: 'problem',
};

/** The model's own (unlocked) steps in order; replaced approaches are dropped. */
export function planSteps(plan: { id: string; text: string; status: string; locked: boolean; ordinal: number }[]): PlanStep[] {
  return plan
    .filter((t) => !t.locked && t.status !== 'replaced')
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((t) => ({
      id: t.id,
      title: t.text.replace(/^\d+[.、]\s*/, ''),
      status: t.status,
      progress: t.status === 'done' ? 100 : t.status === 'in_progress' ? 50 : 0,
      tone: PLAN_TONE[t.status] ?? 'idle',
    }));
}

export function planProgress(steps: PlanStep[]): number {
  if (!steps.length) return 0;
  return Math.round(steps.reduce((s, x) => s + x.progress, 0) / steps.length);
}

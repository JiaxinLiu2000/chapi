import type { PlanTask } from '@prisma/client';
import type { PlanTaskStatus } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { toPlanTaskDTO } from '../mappers.js';

/**
 * The task flow shown on the left. Steps keep a stable identity across
 * `set_plan` rewrites (matched by text), and every status change is stamped:
 * in_progress opens a step's window, a terminal status closes it with a reason.
 * Terminal transitions are handed to the learning agent (see learning/learner.ts),
 * which learns from what happened inside that window.
 */

export const TERMINAL: PlanTaskStatus[] = ['done', 'failed', 'problem', 'blocked', 'replaced'];
/** Statuses that need a reason. */
export const NEEDS_REASON: PlanTaskStatus[] = ['failed', 'problem', 'blocked', 'replaced'];

export interface StepTransition {
  step: PlanTask;
  from: string | null;
  to: PlanTaskStatus;
}

type TransitionListener = (sessionId: string, transitions: StepTransition[]) => void;
const listeners: TransitionListener[] = [];
/** The learning agent subscribes here (kept as a listener to avoid an import cycle). */
export function onPlanTransitions(fn: TransitionListener): void {
  listeners.push(fn);
}

// Per-session bookkeeping for the plan-discipline reminders in hooks.ts.
const lastPlanUpdate = new Map<string, number>();
const toolsSincePlan = new Map<string, number>();

export function notePlanTouched(sessionId: string): void {
  lastPlanUpdate.set(sessionId, Date.now());
  toolsSincePlan.set(sessionId, 0);
}

/** Count one main-agent tool call; returns how many happened since the plan was last updated. */
export function countToolSincePlan(sessionId: string): number {
  const n = (toolsSincePlan.get(sessionId) ?? 0) + 1;
  toolsSincePlan.set(sessionId, n);
  return n;
}

async function emitPlan(sessionId: string): Promise<PlanTask[]> {
  const all = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
  bus.emit({ type: 'plan.updated', sessionId, tasks: all.map(toPlanTaskDTO) });
  return all;
}

function stampFor(prev: PlanTask | null, to: PlanTaskStatus, reason: string | null | undefined) {
  const now = new Date();
  const data: Partial<Pick<PlanTask, 'status' | 'startedAt' | 'endedAt' | 'reason'>> = { status: to };
  if (to === 'in_progress' && !prev?.startedAt) data.startedAt = now;
  if (TERMINAL.includes(to)) data.endedAt = now;
  if (to === 'in_progress' || to === 'pending') data.endedAt = null;
  if (reason !== undefined) data.reason = reason?.trim() || null;
  return data;
}

function fire(sessionId: string, transitions: StepTransition[]): void {
  if (!transitions.length) return;
  for (const fn of listeners) {
    try {
      fn(sessionId, transitions);
    } catch {
      /* listeners must not break the tool */
    }
  }
}

export interface PlanInput {
  text: string;
  status?: PlanTaskStatus;
  reason?: string;
  /** Text of the step this one replaces (a change of approach). */
  replaces?: string;
}

/**
 * Replace the visible plan with `tasks` (ordered). Steps whose text already
 * exists keep their row (id, timestamps); steps not in the new list are removed.
 */
export async function setPlan(sessionId: string, tasks: PlanInput[]): Promise<{ plan: PlanTask[]; transitions: StepTransition[] }> {
  const all = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
  // Workflow-locked rows are engine-owned: always kept, first, untouched by the model.
  const lockedRows = all.filter((t) => t.locked);
  const lockedText = new Set(lockedRows.map((t) => t.text));
  for (const [i, t] of lockedRows.entries()) {
    if (t.ordinal !== i) await prisma.planTask.update({ where: { id: t.id }, data: { ordinal: i } });
  }
  const existing = all.filter((t) => !t.locked);
  const byText = new Map(existing.map((t) => [t.text, t]));
  const keep = new Set<string>();
  const transitions: StepTransition[] = [];
  const created: PlanTask[] = [];
  let ordinal = lockedRows.length;

  for (const t of tasks) {
    const text = (t.text ?? '').trim();
    if (!text || keep.has(text) || lockedText.has(text)) continue;
    const status = t.status ?? 'pending';
    const prev = byText.get(text) ?? null;
    let row: PlanTask;
    if (prev) {
      keep.add(prev.text);
      const changed = prev.status !== status;
      row = await prisma.planTask.update({
        where: { id: prev.id },
        data: { ordinal, ...(changed ? stampFor(prev, status, t.reason) : t.reason ? { reason: t.reason } : {}) },
      });
      if (changed) transitions.push({ step: row, from: prev.status, to: status });
    } else {
      row = await prisma.planTask.create({
        data: { sessionId, ordinal, text, ...stampFor(null, status, t.reason ?? null) },
      });
      keep.add(text);
      created.push(row);
      if (status !== 'pending') transitions.push({ step: row, from: null, to: status });
    }
    if (t.replaces) {
      const old = byText.get(t.replaces.trim());
      if (old) row = await prisma.planTask.update({ where: { id: row.id }, data: { replacesId: old.id } });
    }
    ordinal += 1;
  }

  // One step newly replaced + new steps added in the same call → the first new step replaces it.
  const newlyReplaced = transitions.filter((x) => x.to === 'replaced');
  const unlinked = created.filter((c) => !c.replacesId);
  if (newlyReplaced.length === 1 && unlinked.length && !tasks.some((t) => t.replaces)) {
    await prisma.planTask.update({ where: { id: unlinked[0]!.id }, data: { replacesId: newlyReplaced[0]!.step.id } });
  }

  const drop = existing.filter((t) => !keep.has(t.text)).map((t) => t.id);
  if (drop.length) await prisma.planTask.deleteMany({ where: { id: { in: drop } } });

  notePlanTouched(sessionId);
  const plan = await emitPlan(sessionId);
  const fresh = transitions.map((x) => ({ ...x, step: plan.find((p) => p.id === x.step.id) ?? x.step }));
  fire(sessionId, fresh);
  return { plan, transitions: fresh };
}

/** Find a step by 1-based number, exact text, or a unique text fragment. */
export function findStep(plan: PlanTask[], key: string | number): PlanTask | null {
  if (typeof key === 'number' || /^\d+$/.test(String(key).trim())) {
    return plan[Number(key) - 1] ?? null;
  }
  const k = String(key).trim();
  return plan.find((t) => t.text === k) ?? (plan.filter((t) => t.text.includes(k)).length === 1 ? plan.find((t) => t.text.includes(k))! : null);
}

/**
 * Change one step's status (with a reason for failed/problem/blocked/replaced).
 * `replacement` adds the new approach right after a replaced step, linked to it.
 */
export async function updatePlanStep(
  sessionId: string,
  input: { step: string | number; status: PlanTaskStatus; reason?: string; replacement?: string },
): Promise<{ ok: true; plan: PlanTask[]; step: PlanTask; added?: PlanTask } | { ok: false; error: string }> {
  const plan = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
  const step = findStep(plan, input.step);
  if (!step) {
    return { ok: false, error: `找不到步骤「${input.step}」。当前任务流：\n${plan.map((t, i) => `${i + 1}. [${t.status}] ${t.text}`).join('\n') || '(空——先用 set_plan 建任务流)'}` };
  }
  if (step.locked && (input.status === 'done' || input.status === 'replaced')) {
    return {
      ok: false,
      error:
        input.status === 'done'
          ? '这是 SOP 锁定步骤，由工作流自动更新：副 AI 交证据、你用 workflow_review_stage 审核通过后会自动完成。'
          : '这是 SOP 锁定步骤，不能替换或跳过。确实无法按 SOP 执行时，标 problem / blocked 并写原因，或用 ask_user 请用户决定。',
    };
  }
  if (NEEDS_REASON.includes(input.status) && !input.reason?.trim()) {
    return { ok: false, error: `把步骤标为 ${input.status} 时必须写 reason（为什么失败/遇到什么问题/为什么受阻/为什么换方案）。` };
  }
  const transitions: StepTransition[] = [];
  let updated = step;
  if (step.status !== input.status || input.reason) {
    updated = await prisma.planTask.update({ where: { id: step.id }, data: stampFor(step, input.status, input.reason) });
    if (step.status !== input.status) transitions.push({ step: updated, from: step.status, to: input.status });
  }
  let added: PlanTask | undefined;
  if (input.replacement?.trim()) {
    // Insert right after the replaced step.
    await prisma.planTask.updateMany({ where: { sessionId, ordinal: { gt: step.ordinal } }, data: { ordinal: { increment: 1 } } });
    added = await prisma.planTask.create({
      data: { sessionId, ordinal: step.ordinal + 1, text: input.replacement.trim(), status: 'in_progress', startedAt: new Date(), replacesId: step.id },
    });
  }
  notePlanTouched(sessionId);
  const all = await emitPlan(sessionId);
  fire(sessionId, transitions);
  return { ok: true, plan: all, step: updated, ...(added ? { added } : {}) };
}

/** Steps the agent hasn't closed yet (blocks request_approval). */
export async function openSteps(sessionId: string): Promise<PlanTask[]> {
  return prisma.planTask.findMany({
    where: { sessionId, status: { in: ['pending', 'in_progress'] } },
    orderBy: { ordinal: 'asc' },
  });
}

export function formatPlan(plan: PlanTask[]): string {
  return plan.map((t, i) => `${i + 1}. [${t.status}] ${t.text}${t.reason ? `（${t.reason}）` : ''}`).join('\n');
}

export interface LockedStep {
  nodeRunId: string;
  text: string;
  status: PlanTaskStatus;
  reason?: string | null;
  /** 0 = stage, 1 = sub-step. */
  depth?: number;
  /** 0-100 progress fill. */
  progress?: number | null;
}

/**
 * Engine-side: make the workflow-locked rows match `steps` (by nodeRunId), in
 * that order, at the top of the plan. Locked rows not in `steps` are removed;
 * the model's own (unlocked) rows follow, keeping their relative order.
 * Status changes are stamped and handed to the learning agent like any other.
 */
export async function syncLockedSteps(
  sessionId: string,
  steps: LockedStep[],
  opts: { scope?: string[] } = {},
): Promise<PlanTask[]> {
  const all = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
  const lockedByNode = new Map(all.filter((t) => t.locked && t.nodeRunId).map((t) => [t.nodeRunId!, t]));
  // The run owns only its own rows (`scope`, default: the steps given). Locked rows of
  // earlier runs in this session are history: kept untouched, ahead of this run.
  const scope = new Set(opts.scope ?? steps.map((s) => s.nodeRunId));
  const history = all.filter((t) => t.locked && !(t.nodeRunId && scope.has(t.nodeRunId)));
  const transitions: StepTransition[] = [];
  const keepIds = new Set<string>(history.map((t) => t.id));
  let ordinal = 0;
  for (const t of history) {
    if (t.ordinal !== ordinal) await prisma.planTask.update({ where: { id: t.id }, data: { ordinal } });
    ordinal += 1;
  }
  for (const s of steps) {
    const prev = lockedByNode.get(s.nodeRunId) ?? null;
    let row: PlanTask;
    if (prev) {
      const changed = prev.status !== s.status;
      row = await prisma.planTask.update({
        where: { id: prev.id },
        data: {
          ordinal,
          text: s.text,
          depth: s.depth ?? 0,
          progress: s.progress ?? null,
          ...(changed ? stampFor(prev, s.status, s.reason) : s.reason !== undefined ? { reason: s.reason?.trim() || null } : {}),
        },
      });
      if (changed) transitions.push({ step: row, from: prev.status, to: s.status });
    } else {
      row = await prisma.planTask.create({
        data: {
          sessionId,
          ordinal,
          text: s.text,
          locked: true,
          nodeRunId: s.nodeRunId,
          depth: s.depth ?? 0,
          progress: s.progress ?? null,
          ...stampFor(null, s.status, s.reason ?? null),
        },
      });
      if (s.status !== 'pending') transitions.push({ step: row, from: null, to: s.status });
    }
    keepIds.add(row.id);
    ordinal += 1;
  }
  const staleLocked = all.filter((t) => t.locked && !keepIds.has(t.id)).map((t) => t.id);
  if (staleLocked.length) await prisma.planTask.deleteMany({ where: { id: { in: staleLocked } } });
  for (const t of all.filter((x) => !x.locked)) {
    if (t.ordinal !== ordinal) await prisma.planTask.update({ where: { id: t.id }, data: { ordinal } });
    ordinal += 1;
  }
  const plan = await emitPlan(sessionId);
  fire(
    sessionId,
    transitions.map((x) => ({ ...x, step: plan.find((p) => p.id === x.step.id) ?? x.step })),
  );
  return plan;
}

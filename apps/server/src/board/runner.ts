/**
 * Automation runner: starts a registered automation (manual button, cron tick or
 * startup catch-up) in a fresh session and keeps its AutomationRun row in step with
 * what actually happens in that session.
 *
 * Stability rules (spec 5.3 / 5.4 / 5.8):
 *  - one live (running|queued) run per automation — per-automation in-process lock,
 *    plus the (automationId, dueAt) unique key as the backstop (P2002 = already handled);
 *  - at most MAX_AUTO_RUNNING cron/catchup runs `running` at once — the rest are
 *    persisted as `queued` and drained in dueAt order (missed by > 24h → skipped);
 *  - status writes are compare-and-set on the old status, and a terminal status
 *    (done/failed/skipped) never moves; nothing is left stuck in `running`
 *    (session deleted → failed, periodic sweep as the safety net).
 */
import type { AutomationRunDTO } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toAutomationRunDTO } from '../mappers.js';
import { getOrchestrator } from '../orchestrator/types.js';
import { createSession, currentRunState } from '../services/sessions.js';
import { workflowEngine } from '../workflow/engine.js';
import { notifyMainAI } from '../workflow/notify.js';
import { renderInputs, renderTemplate } from './schedule.js';

const log = createLogger('board-runner');

export const MAX_AUTO_RUNNING = 2;
const MISSED_AFTER_MS = 24 * 3600_000;
/**
 * A run idle this long with no live orchestrator run is over (e.g. chapi restarted
 * mid-turn): no-SOP → failed / done, SOP-backed → waiting_user.
 */
const IDLE_GIVE_UP_MS = 10 * 60_000;
/** A `running` row with no session younger than this is treated as still starting. */
const START_GRACE_MS = 10_000;
const SWEEP_MS = 60_000;
const BOARD_DEBOUNCE_MS = 1000;

type Trigger = 'manual' | 'cron' | 'catchup';
type RunStatus = 'queued' | 'running' | 'waiting_user' | 'done' | 'failed' | 'skipped' | 'stale';
type Result = { ok: true; run: AutomationRunDTO } | { ok: false; error: string; runId?: string };

const TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'skipped']);
/** Statuses status-sync looks after (queued has no session yet; drainQueue owns it). */
const LIVE_SYNC = ['running', 'waiting_user', 'stale'];

// ── in-memory state ─────────────────────────────────────────────────────────

const locks = new Map<string, Promise<unknown>>();
/** Serialise async work per key (same shape as workflow/engine.ts withLock). */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}
const CAP_LOCK = '\u0000cap';
const DRAIN_LOCK = '\u0000drain';

/** Runs between row creation and session/workflow start — status sync must leave them alone. */
const launching = new Set<string>();
/** Sessions whose turn has been seen running (guards against marking done on the initial idle). */
const sawRunning = new Set<string>();
let boardTimer: ReturnType<typeof setTimeout> | null = null;
let offBus: (() => void) | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function __resetRunnerForTests(): void {
  locks.clear();
  launching.clear();
  sawRunning.clear();
  if (boardTimer) clearTimeout(boardTimer);
  boardTimer = null;
  offBus?.();
  offBus = null;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

function scheduleBoardChanged(): void {
  if (boardTimer) clearTimeout(boardTimer);
  boardTimer = setTimeout(() => {
    boardTimer = null;
    bus.emit({ type: 'board.changed' });
  }, BOARD_DEBOUNCE_MS);
  boardTimer.unref?.();
}

function notifyFailure(name: string, error: string, sessionId: string | null): void {
  bus.emit({ type: 'notification', sessionId, level: 'error', title: '自动化运行失败', body: `「${name}」${error}` });
}

const isP2002 = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── row helpers ─────────────────────────────────────────────────────────────

async function runDTO(runId: string): Promise<AutomationRunDTO> {
  const r = await prisma.automationRun.findUniqueOrThrow({ where: { id: runId }, include: { session: { select: { slug: true } } } });
  return toAutomationRunDTO(r, r.session);
}

/** Mirror the newest run onto the Automation row and tell the board. */
export async function refreshAutomation(automationId: string): Promise<void> {
  const newest = await prisma.automationRun.findFirst({ where: { automationId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] });
  const withSession = await prisma.automationRun.findFirst({
    where: { automationId, sessionId: { not: null } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  });
  await prisma.automation
    .update({
      where: { id: automationId },
      data: {
        lastRunAt: newest?.startedAt ?? null,
        lastStatus: newest?.status ?? null,
        lastSessionId: withSession?.sessionId ?? null,
      },
    })
    .catch((err) => log.warn(`refresh automation ${automationId} failed`, err));
  scheduleBoardChanged();
}

/**
 * Compare-and-set a run's status. Returns false when the row moved on in the meantime
 * (someone else won) or the move is not allowed: terminal statuses never change, and
 * a stale run may only finish (done/failed).
 */
async function transition(runId: string, from: string, to: RunStatus, note?: string | null): Promise<boolean> {
  if (from === to || TERMINAL.has(from)) return false;
  if (from === 'stale' && to !== 'done' && to !== 'failed') return false;
  const ended = TERMINAL.has(to) ? { endedAt: new Date() } : {};
  const res = await prisma.automationRun.updateMany({
    where: { id: runId, status: from },
    data: { status: to, ...ended, ...(note !== undefined ? { note } : {}) },
  });
  return res.count === 1;
}

// ── start ───────────────────────────────────────────────────────────────────

type AutomationRow = NonNullable<Awaited<ReturnType<typeof loadAutomation>>>;
function loadAutomation(id: string) {
  return prisma.automation.findUnique({
    where: { id },
    include: { workflow: { select: { id: true, slug: true, name: true, status: true, confirmedVersion: true } } },
  });
}

/** Why this automation can't run with this trigger right now (null = it can). */
function cannotRun(a: AutomationRow, trigger: Trigger): string | null {
  if (a.workflowId) {
    const w = a.workflow;
    if (!w) return '绑定的 SOP 不存在。';
    if (w.status === 'archived') return `SOP「${w.name}」已归档，不能运行。`;
    if (w.status !== 'confirmed' || !w.confirmedVersion) return `SOP「${w.name}」还是草稿，确认后才能运行。`;
    return null;
  }
  if (trigger !== 'manual') return '没有绑定已确认的 SOP，只能手动运行。';
  if (!a.prompt?.trim()) return '没有绑定 SOP，也没有填写固定 prompt。';
  return null;
}

/** M/D in PT for the session title. */
const ptMD = (now: Date) => renderInputs({ md: '{MD}' }, now)!.md;

/** Create the session and kick off the SOP / first message for a run that is already `running`. */
async function launch(runId: string, a: AutomationRow, trigger: Trigger): Promise<{ ok: true } | { ok: false; error: string }> {
  launching.add(runId);
  let sessionId: string | null = null;
  try {
    const now = new Date();
    const session = await createSession({
      title: `${a.name} · ${ptMD(now)}`,
      model: a.model || undefined,
      effort: (a.effort || undefined) as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
      language: 'zh',
    });
    sessionId = session.id;
    // A fixed project pins the session (user source); with none, leave it 'ai' so classify may file it.
    if (a.projectId) {
      await prisma.session.update({ where: { id: session.id }, data: { projectId: a.projectId, projectSource: 'user' } });
    }
    await prisma.automationRun.update({ where: { id: runId }, data: { sessionId: session.id } });

    if (a.workflow) {
      const inputs = renderInputs((a.inputs as Record<string, string> | null) ?? null, now);
      const r = await workflowEngine.start(session.id, {
        workflow: a.workflow.slug,
        label: a.name,
        inputs,
        trigger: trigger === 'manual' ? 'manual' : 'cron',
      });
      if (!r.ok) throw new Error(r.error);
      await prisma.automationRun.update({ where: { id: runId }, data: { workflowRunId: r.run.id, workflowVersion: r.run.version } });
      const who = trigger === 'manual' ? '用户已启动' : '定时任务已启动';
      notifyMainAI(session.id, `[工作流] ${who}「${r.run.workflowName}」。${r.message}`);
    } else {
      const sid = session.id;
      void Promise.resolve()
        .then(() => getOrchestrator().handleUserMessage(sid, renderTemplate(a.prompt!.trim(), now)))
        .catch(async (err) => {
          log.warn(`automation ${a.id} first message failed`, err);
          await failRun(runId, a.name, `发送第一条消息失败：${errText(err)}`, sid).catch(() => undefined);
        });
    }
    return { ok: true };
  } catch (err) {
    const error = errText(err);
    log.warn(`automation ${a.id} run ${runId} failed to start: ${error}`);
    await failRun(runId, a.name, `启动失败：${error}`, sessionId);
    return { ok: false, error };
  } finally {
    launching.delete(runId);
  }
}

/** Mark a non-terminal run failed (any live status) and tell the user. */
async function failRun(runId: string, name: string, note: string, sessionId: string | null): Promise<void> {
  const row = await prisma.automationRun.findUnique({ where: { id: runId } });
  if (!row) return;
  if (await transition(runId, row.status, 'failed', note)) {
    notifyFailure(name, note, sessionId);
    await refreshAutomation(row.automationId);
    if (row.trigger !== 'manual' && row.status === 'running') void drainQueue();
  }
}

export async function runAutomation(id: string, opts: { trigger: Trigger; dueAt?: Date }): Promise<Result> {
  return withLock(`a:${id}`, async (): Promise<Result> => {
    const a = await loadAutomation(id);
    if (!a) return { ok: false, error: '找不到这个自动化任务。' };
    const trigger = opts.trigger;
    const scheduled = trigger !== 'manual';
    const dueAt = scheduled ? (opts.dueAt ?? new Date(Math.floor(Date.now() / 60_000) * 60_000)) : null;

    if (dueAt) {
      const handled = await prisma.automationRun.findUnique({ where: { automationId_dueAt: { automationId: id, dueAt } } });
      if (handled) return { ok: false, error: '该时刻已处理。', runId: handled.id };
    }

    // Record a scheduled slot that we won't start (it's still "handled").
    const recordSlot = async (status: 'skipped' | 'failed', note: string): Promise<string | null> => {
      try {
        const row = await prisma.automationRun.create({
          data: { automationId: id, trigger, status, note, dueAt, endedAt: new Date() },
        });
        await refreshAutomation(id);
        return row.id;
      } catch (err) {
        if (isP2002(err)) return null;
        throw err;
      }
    };

    const bad = cannotRun(a, trigger);
    if (bad) {
      if (!scheduled) return { ok: false, error: bad };
      const rowId = await recordSlot('failed', bad);
      if (rowId) notifyFailure(a.name, bad, null);
      return { ok: false, error: rowId ? bad : '该时刻已处理。', ...(rowId ? { runId: rowId } : {}) };
    }

    // Refresh live rows first so a run whose session vanished doesn't block forever.
    const live = await prisma.automationRun.findMany({ where: { automationId: id, status: { in: ['running', 'waiting_user'] } } });
    for (const r of live) await syncUnlocked(r.id);
    const findActive = () =>
      prisma.automationRun.findFirst({
        where: { automationId: id, status: { in: ['running', 'queued'] } },
        orderBy: { startedAt: 'desc' },
      });
    const refuse = async (active: { id: string }): Promise<Result> => {
      if (!scheduled) return { ok: false, error: '上次还没完成，请先处理上一次运行。', runId: active.id };
      const rowId = await recordSlot('skipped', '上次还没完成');
      return { ok: false, error: rowId ? '上次还没完成，本次已跳过。' : '该时刻已处理。', runId: active.id };
    };
    const active = await findActive();
    if (active) return refuse(active);

    // The user chose: an older run still waiting on them is kept but marked stale.
    // Compare-and-set BEFORE inserting the new row, then re-check: a concurrent status
    // sync may have moved a waiting_user run back to running in between — once it is
    // stale it can no longer do that, so at most one live run can exist.
    await prisma.automationRun.updateMany({ where: { automationId: id, status: 'waiting_user' }, data: { status: 'stale' } });
    const revived = await findActive();
    if (revived) return refuse(revived);

    // Claim the slot: the cap check and the insert must not interleave across automations.
    let created: { id: string; status: string };
    try {
      created = await withLock(CAP_LOCK, async () => {
        const full = scheduled && (await countAutoRunning()) >= MAX_AUTO_RUNNING;
        const row = await prisma.automationRun.create({
          data: { automationId: id, trigger, status: full ? 'queued' : 'running', dueAt, startedAt: new Date() },
          select: { id: true, status: true },
        });
        // From the moment it is `running` with no session yet, status sync must leave it alone.
        if (row.status === 'running') launching.add(row.id);
        return row;
      });
    } catch (err) {
      if (isP2002(err)) return { ok: false, error: '该时刻已处理。' };
      throw err;
    }

    if (created.status === 'queued') {
      log.info(`automation ${id} queued (${MAX_AUTO_RUNNING} auto runs already running)`);
      await refreshAutomation(id);
      return { ok: true, run: await runDTO(created.id) };
    }

    const started = await launch(created.id, a, trigger);
    // Bus events during the launch were ignored (launching) — catch up on them now.
    await syncUnlocked(created.id);
    await refreshAutomation(id);
    if (!started.ok) return { ok: false, error: started.error, runId: created.id };
    log.info(`automation ${id} (${a.name}) started run ${created.id} [${trigger}]`);
    return { ok: true, run: await runDTO(created.id) };
  });
}

function countAutoRunning(): Promise<number> {
  return prisma.automationRun.count({ where: { status: 'running', trigger: { in: ['cron', 'catchup'] } } });
}

// ── queue ───────────────────────────────────────────────────────────────────

/** Start queued cron/catchup runs in dueAt order while there is room; drop those missed by > 24h. */
export function drainQueue(): Promise<void> {
  return withLock(DRAIN_LOCK, async () => {
    for (;;) {
      const next = await withLock(CAP_LOCK, async () => {
        const q = await prisma.automationRun.findFirst({ where: { status: 'queued' }, orderBy: [{ dueAt: 'asc' }, { startedAt: 'asc' }] });
        if (!q) return null;
        const due = q.dueAt ?? q.startedAt;
        if (Date.now() - due.getTime() > MISSED_AFTER_MS) {
          if (await transition(q.id, 'queued', 'skipped', '错过（排队超过 24 小时）')) await refreshAutomation(q.automationId);
          return { kind: 'skipped' as const };
        }
        if ((await countAutoRunning()) >= MAX_AUTO_RUNNING) return null;
        const res = await prisma.automationRun.updateMany({ where: { id: q.id, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
        if (res.count !== 1) return { kind: 'skipped' as const };
        launching.add(q.id); // running with no session yet — status sync must leave it alone
        return { kind: 'start' as const, run: q };
      });
      if (!next) return;
      if (next.kind === 'skipped') continue;
      const runId = next.run.id;
      try {
        const a = await loadAutomation(next.run.automationId);
        if (!a) continue; // automation deleted → its runs cascade away
        const bad = cannotRun(a, next.run.trigger as Trigger);
        if (bad) {
          await failRun(runId, a.name, bad, null);
          continue;
        }
        await launch(runId, a, next.run.trigger as Trigger);
        launching.delete(runId);
        await syncUnlocked(runId); // events during the launch were ignored — catch up now
        await refreshAutomation(a.id);
      } finally {
        launching.delete(runId);
      }
    }
  });
}

// ── status sync ─────────────────────────────────────────────────────────────

async function hasOpenHitl(sessionId: string): Promise<boolean> {
  const [q, ap] = await Promise.all([
    prisma.pendingQuestion.count({ where: { sessionId, status: 'open', source: 'agent' } }),
    prisma.approval.count({ where: { sessionId, status: 'open' } }),
  ]);
  return q + ap > 0;
}

function orchestratorActive(sessionId: string): boolean {
  try {
    return getOrchestrator().isActive(sessionId);
  } catch {
    return false;
  }
}

function runStateOf(sessionId: string): string {
  try {
    return currentRunState(sessionId);
  } catch {
    return bus.lastRunState(sessionId);
  }
}

/** What the run's status should be now, from its session / workflow run. */
async function derive(run: {
  id: string;
  sessionId: string | null;
  workflowRunId: string | null;
  status: string;
  startedAt: Date;
}): Promise<{ status: RunStatus; note?: string }> {
  if (!run.sessionId) {
    // No session yet: still starting (in-process: `launching`; leave a short grace for
    // safety), otherwise the session was deleted or a restart cut the start short.
    if (launching.has(run.id) || Date.now() - run.startedAt.getTime() < START_GRACE_MS) return { status: run.status as RunStatus };
    return { status: 'failed', note: '会话已删除' };
  }
  const session = await prisma.session.findUnique({ where: { id: run.sessionId }, select: { status: true } });
  if (!session || session.status === 'deleted') return { status: 'failed', note: '会话已删除' };

  if (run.workflowRunId) {
    const wr = await prisma.workflowRun.findUnique({ where: { id: run.workflowRunId }, select: { status: true } });
    if (!wr) return { status: 'failed', note: 'SOP 运行记录不存在' };
    switch (wr.status) {
      case 'done':
        return { status: 'done' };
      case 'cancelled':
        return { status: 'failed', note: 'SOP 运行已取消' };
      case 'failed':
        return { status: 'failed', note: 'SOP 运行失败' };
      case 'waiting_user':
      case 'blocked':
        return { status: 'waiting_user' };
      default: {
        // The workflow engine has no idle handling: if the main agent's turn ends mid-SOP
        // (a plain-text question, a restart) the run would sit `running` forever, holding
        // a cap slot. Mirror the no-SOP path: a turn seen running that is now idle is over
        // (the real orchestrator keeps its Run registered across turns, so isActive can't
        // tell turns apart — only the run state can). After a restart (never seen running)
        // fall back to: idle for long AND no live orchestrator run. A resumed turn moves
        // waiting_user back to running.
        const st = runStateOf(run.sessionId);
        if (await hasOpenHitl(run.sessionId)) return { status: 'waiting_user' };
        if (st === 'running' || st === 'paused') return { status: 'running' };
        if (sawRunning.has(run.sessionId)) return { status: 'waiting_user' };
        if (Date.now() - run.startedAt.getTime() > IDLE_GIVE_UP_MS && !orchestratorActive(run.sessionId)) return { status: 'waiting_user' };
        return { status: 'running' };
      }
    }
  }

  // No SOP: the main agent's turn ending (idle) is the end of the run. Read the run
  // state BEFORE the HITL rows: a question opened just before the turn went idle is
  // then always seen, so the run can't be marked done over an open question.
  const st = runStateOf(run.sessionId);
  if (await hasOpenHitl(run.sessionId)) return { status: 'waiting_user' };
  if (st === 'running' || st === 'paused') return { status: 'running' };
  if (sawRunning.has(run.sessionId)) return { status: 'done' };
  // Not seen running in this process (e.g. after a restart): done once the AI has replied,
  // or once it has sat idle with no live run for a while — never stuck forever.
  const replied = await prisma.message.count({ where: { sessionId: run.sessionId, role: 'assistant' } });
  if (replied > 0) return { status: 'done' };
  if (Date.now() - run.startedAt.getTime() > IDLE_GIVE_UP_MS && !orchestratorActive(run.sessionId)) {
    return { status: 'failed', note: '会话没有开始运行' };
  }
  return { status: 'running' };
}

async function syncUnlocked(runId: string): Promise<void> {
  if (launching.has(runId)) return;
  const run = await prisma.automationRun.findUnique({ where: { id: runId }, include: { automation: { select: { name: true } } } });
  if (!run || !LIVE_SYNC.includes(run.status)) return;
  const target = await derive(run);
  if (target.status === run.status) return;
  if (launching.has(run.id)) return; // a launch began while we were reading
  if (!(await transition(run.id, run.status, target.status, target.note ?? undefined))) return;
  log.info(`automation run ${run.id}: ${run.status} → ${target.status}${target.note ? ` (${target.note})` : ''}`);
  if (TERMINAL.has(target.status) && run.sessionId) sawRunning.delete(run.sessionId);
  if (target.status === 'failed') notifyFailure(run.automation.name, target.note ?? '运行失败', run.sessionId);
  await refreshAutomation(run.automationId);
  if (run.status === 'running' && run.trigger !== 'manual') void drainQueue();
}

/** Re-derive one run's status from its session / workflow run (idempotent). */
export function syncRunStatus(runId: string): Promise<void> {
  return withLock(`r:${runId}`, () => syncUnlocked(runId));
}

async function syncSession(sessionId: string): Promise<void> {
  const runs = await prisma.automationRun.findMany({
    where: {
      status: { in: LIVE_SYNC },
      OR: [{ sessionId }, { sessionId: null }],
    },
    select: { id: true },
  });
  for (const r of runs) await syncRunStatus(r.id);
}

async function sweep(): Promise<void> {
  const runs = await prisma.automationRun.findMany({ where: { status: { in: LIVE_SYNC } }, select: { id: true } });
  for (const r of runs) await syncRunStatus(r.id);
  await drainQueue();
}

/** Subscribe status sync to the bus and start the periodic safety sweep. */
export function startRunnerListeners(): void {
  if (offBus) return;
  offBus = bus.on((e) => {
    let sessionId: string | null = null;
    switch (e.type) {
      case 'run.state':
        if (e.state === 'running') sawRunning.add(e.sessionId);
        sessionId = e.sessionId;
        break;
      case 'workflow.run.updated':
      case 'question.open':
      case 'question.closed':
      case 'approval.request':
      case 'approval.closed':
        sessionId = e.sessionId;
        break;
      case 'session.updated':
        if (e.session.status === 'deleted') sessionId = e.session.id;
        break;
      default:
        return;
    }
    if (sessionId) void syncSession(sessionId).catch((err) => log.warn(`status sync for ${sessionId} failed`, err));
  });
  sweepTimer = setInterval(() => void sweep().catch((err) => log.warn('runner sweep failed', err)), SWEEP_MS);
  sweepTimer.unref?.();
  void sweep().catch((err) => log.warn('runner startup sweep failed', err));
}

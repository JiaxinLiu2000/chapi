/**
 * Board cron: every 30s, fire `auto` automations whose PT schedule has come due, and on
 * (re)start catch up the single most recent due slot if it is at most 24h old.
 * Every (automationId, dueAt) slot is handled at most once — the runner's unique key is
 * the backstop; here we only look at the latest slot and write a skipped「错过」row for
 * slots older than 24h.
 */
import type { ScheduleSpec } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { refreshSummariesDaily } from './classify.js';
import { drainQueue, runAutomation } from './runner.js';
import { lastDue, nextDue } from './schedule.js';

const log = createLogger('board-cron');

const TICK_MS = 30_000;
const CATCHUP_WINDOW_MS = 24 * 3600_000;
/** Beyond this lateness a due slot is reported as a catch-up rather than an on-time cron run. */
const ON_TIME_MS = 2 * 60_000;

const isP2002 = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
const SUMMARY_SLOT = { kind: 'daily', time: '06:00' } as unknown as ScheduleSpec;
const SUMMARY_CATCHUP_MS = 6 * 3600_000;
/** Last 06:00 PT summary slot already handled (in memory; seeded on first tick). */
let lastSummaryRun: Date | null = null;

/** Daily 06:00 PT project-summary refresh; isolated so a failure never breaks the automation tick. */
function summaryHook(now: Date): void {
  try {
    const slot = lastDue(SUMMARY_SLOT, now);
    if (!slot) return;
    if (!lastSummaryRun) {
      // fresh start: only fire if that slot is recent, otherwise just record it
      lastSummaryRun = now.getTime() - slot.getTime() <= SUMMARY_CATCHUP_MS ? new Date(slot.getTime() - 1) : slot;
    }
    if (slot.getTime() > lastSummaryRun.getTime()) {
      lastSummaryRun = slot;
      void refreshSummariesDaily().catch((err) => log.warn(`daily summaries failed: ${errText(err)}`));
    }
  } catch (err) {
    log.warn(`summary hook failed: ${errText(err)}`);
  }
}

type AutomationRow = Awaited<ReturnType<typeof prisma.automation.findMany>>[number];

async function sopUsable(workflowId: string | null): Promise<boolean> {
  if (!workflowId) return false;
  const w = await prisma.workflow.findUnique({ where: { id: workflowId }, select: { status: true } });
  return !!w && w.status === 'confirmed';
}

async function handleOne(a: AutomationRow, now: Date): Promise<boolean> {
  let changed = false;

  if (!(await sopUsable(a.workflowId))) {
    const r = await prisma.automation.updateMany({ where: { id: a.id, mode: 'auto' }, data: { mode: 'manual', nextRunAt: null } });
    if (r.count > 0) {
      bus.emit({
        type: 'notification',
        sessionId: null,
        level: 'info', // no 'warning' level in NotificationLevel
        title: '自动化已改回手动',
        body: `${a.name} 的 SOP 已不可用，已改回手动`,
      });
      return true;
    }
    return false;
  }

  const spec = a.schedule as unknown as ScheduleSpec;
  // Legacy/seeded auto row with no autoSince: this tick is its baseline, nothing fires for earlier slots.
  // (The PATCH route sets autoSince=now whenever a task becomes live auto — mode→auto or re-enabled — or its schedule changes.)
  let baselined = false;
  if (!a.autoSince) {
    await prisma.automation.updateMany({ where: { id: a.id, autoSince: null }, data: { autoSince: now } });
    baselined = true;
    changed = true;
  }
  const d = baselined ? null : lastDue(spec, now);
  // Eligible only if later than creation, the moment auto was enabled, and the last run (spec 5.4).
  const floor = Math.max(a.createdAt.getTime(), a.autoSince?.getTime() ?? 0, a.lastRunAt?.getTime() ?? 0);
  if (d && d.getTime() > floor) {
    const exists = await prisma.automationRun.findUnique({ where: { automationId_dueAt: { automationId: a.id, dueAt: d } }, select: { id: true } });
    if (!exists) {
      const late = now.getTime() - d.getTime();
      if (late <= CATCHUP_WINDOW_MS) {
        const r = await runAutomation(a.id, { trigger: late > ON_TIME_MS ? 'catchup' : 'cron', dueAt: d });
        if (r.ok) changed = true;
      } else {
        try {
          await prisma.automationRun.create({
            data: { automationId: a.id, trigger: 'catchup', status: 'skipped', note: '错过', dueAt: d, endedAt: new Date() },
          });
          changed = true;
        } catch (err) {
          if (!isP2002(err)) throw err;
        }
      }
    }
  }

  const next = nextDue(spec, now);
  if (a.nextRunAt?.getTime() !== next.getTime()) {
    await prisma.automation.update({ where: { id: a.id }, data: { nextRunAt: next } });
    changed = true;
  }
  return changed;
}

async function tick(now: Date = new Date()): Promise<void> {
  summaryHook(now);
  if (ticking) return;
  ticking = true;
  try {
    const rows = await prisma.automation.findMany({ where: { enabled: true, mode: 'auto' } });
    let changed = false;
    for (const a of rows) {
      try {
        if (await handleOne(a, now)) changed = true;
      } catch (err) {
        log.warn(`automation ${a.id} (${a.name}) tick failed: ${errText(err)}`);
        // only a schedule that cannot be computed clears nextRunAt; other errors just log
        try {
          nextDue(a.schedule as unknown as ScheduleSpec, now);
          lastDue(a.schedule as unknown as ScheduleSpec, now);
        } catch {
          await prisma.automation.updateMany({ where: { id: a.id, nextRunAt: { not: null } }, data: { nextRunAt: null } }).catch(() => undefined);
        }
      }
    }
    if (changed) bus.emit({ type: 'board.changed' });
  } catch (err) {
    log.warn(`board tick failed: ${errText(err)}`);
  } finally {
    ticking = false;
  }
}

async function start(): Promise<void> {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  try {
    await drainQueue(); // queued runs survive a restart
  } catch (err) {
    log.warn(`startup drainQueue failed: ${errText(err)}`);
  }
  await tick();
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export const boardCron = { start, tick, stop };

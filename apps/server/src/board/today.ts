import type { BoardSessionCard, BoardTodayDTO } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { currentRunState } from '../services/sessions.js';
import { hitl } from '../engine/hitl.js';

const TZ = 'America/Los_Angeles';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function ptWallMs(ms: number): number {
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year ?? 0, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0);
}

/** The UTC instant at which the PT calendar day containing `now` began. */
export function ptDayStart(now: Date): Date {
  const w = new Date(ptWallMs(now.getTime()));
  const wall = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate());
  let utc = wall - (ptWallMs(wall) - wall);
  utc = wall - (ptWallMs(utc) - utc);
  return new Date(utc);
}

const DONE_CAP = 50;
/** Open questions / approvals older than this no longer count as "waiting" (unless the agent is live-blocked). */
const RECENT_WAIT_MS = 3 * 86400000;
const clip = (s: string) => (s.length > 120 ? s.slice(0, 120) : s);

export async function getBoardToday(now = new Date()): Promise<BoardTodayDTO> {
  const since = ptDayStart(now);
  const pendingRuns = await prisma.automationRun.findMany({
    where: { status: { in: ['waiting_user', 'stale'] }, sessionId: { not: null } },
    orderBy: { startedAt: 'desc' },
  });
  const runBySession = new Map<string, (typeof pendingRuns)[number]>();
  for (const r of pendingRuns) if (r.sessionId && !runBySession.has(r.sessionId)) runBySession.set(r.sessionId, r);

  // "Waiting" = really waiting now: an open automation run (above), a live HITL block,
  // or an open question / approval from the last 3 days.
  const recent = new Date(now.getTime() - RECENT_WAIT_MS);
  const [oq, oa] = await Promise.all([
    prisma.pendingQuestion.findMany({ where: { status: 'open', source: 'agent', createdAt: { gte: recent } }, select: { sessionId: true } }),
    prisma.approval.findMany({ where: { status: 'open', createdAt: { gte: recent } }, select: { sessionId: true } }),
  ]);
  const hasQuestion = new Set(oq.map((q) => q.sessionId));
  const hasApproval = new Set(oa.map((a) => a.sessionId));
  const live = hitl.waitingSessionIds();
  const needUser = [...new Set([...hasQuestion, ...hasApproval, ...live])];
  const sessions = await prisma.session.findMany({
    where: {
      status: { not: 'deleted' },
      OR: [{ updatedAt: { gte: since } }, { id: { in: [...runBySession.keys(), ...needUser] } }],
    },
    include: { project: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  if (sessions.length === 0) return { running: [], waiting: [], done: [] };
  const ids = sessions.map((s) => s.id);

  const [tasks, agents] = await Promise.all([
    prisma.planTask.findMany({ where: { sessionId: { in: ids }, status: 'in_progress' }, orderBy: { ordinal: 'asc' }, select: { sessionId: true, text: true } }),
    prisma.agentRun.findMany({
      where: { sessionId: { in: ids }, status: 'running', currentActivity: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { sessionId: true, currentActivity: true },
    }),
  ]);
  const taskText = new Map<string, string>();
  for (const t of tasks) if (!taskText.has(t.sessionId)) taskText.set(t.sessionId, t.text);
  const activity = new Map<string, string>();
  for (const a of agents) if (a.currentActivity && !activity.has(a.sessionId)) activity.set(a.sessionId, a.currentActivity);

  const out: BoardTodayDTO = { running: [], waiting: [], done: [] };
  for (const s of sessions) {
    const run = runBySession.get(s.id) ?? null;
    const waitingKind: BoardSessionCard['waitingKind'] =
      hitl.waitKind(s.id) ?? (hasQuestion.has(s.id) ? 'question' : hasApproval.has(s.id) ? 'approval' : null);
    const state = currentRunState(s.id);
    const progress = taskText.get(s.id) ?? activity.get(s.id) ?? null;
    const card: BoardSessionCard = {
      id: s.id,
      slug: s.slug,
      title: s.title,
      projectName: s.project?.name ?? null,
      state,
      progress: progress ? clip(progress) : null,
      waitingKind,
      updatedAt: s.updatedAt.toISOString(),
      automationRunId: run?.id ?? null,
      stale: run?.status === 'stale',
    };
    // A live HITL block keeps the run "running" underneath, but the user is who it waits on.
    if (hitl.isWaiting(s.id)) out.waiting.push(card);
    else if (state === 'running' || state === 'paused') out.running.push(card);
    else if (waitingKind || run) out.waiting.push(card);
    else out.done.push(card);
  }
  out.done = out.done.slice(0, DONE_CAP);
  return out;
}

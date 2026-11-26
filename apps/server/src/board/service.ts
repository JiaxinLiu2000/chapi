/**
 * Automation service: the one place that validates and applies changes to the
 * automation registry. The REST routes (/api/board/automations…) and the AI tools
 * (board/tools.ts) both call it, so validation, autoSince rules and side effects
 * (board.changed) live here only.
 */
import { Prisma, type Automation, type AutomationRun } from '@prisma/client';
import type { AutomationDTO, AutomationRunDTO, ScheduleSpec } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { toAutomationDTO, toAutomationRunDTO } from '../mappers.js';
import { settings } from '../secrets.js';
import { refreshAutomation, runAutomation } from './runner.js';
import { nextDue, renderInputs } from './schedule.js';
import { sameSchedule, validateEffort, validateInputs, validateModel, validateName, validateSchedule } from './validate.js';

const LIVE = ['running', 'queued', 'waiting_user'];
const OPEN = [...LIVE, 'stale'];

export type SvcResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

const changed = () => bus.emit({ type: 'board.changed' });
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export const NEED_SOP = '先整理成 SOP，并在 /workflows 确认后，才能设成自动。';
export const NOT_FOUND = '找不到这个自动化任务。';

type RunRow = AutomationRun & { session: { slug: string } | null };
const runDto = (r: RunRow): AutomationRunDTO => toAutomationRunDTO(r, r.session);

export async function automationDTOs(where: { id?: string } = {}): Promise<AutomationDTO[]> {
  const rows = await prisma.automation.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: {
      workflow: { select: { slug: true, name: true, status: true, confirmedVersion: true } },
      runs: { orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 30, include: { session: { select: { slug: true } } } },
    },
  });
  const openAll = await prisma.automationRun.findMany({
    where: { automationId: { in: rows.map((r) => r.id) }, status: { in: OPEN } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    include: { session: { select: { slug: true } } },
  });
  const now = new Date();
  return rows.map((a) => {
    const runs = a.runs;
    const live = openAll.some((r) => r.automationId === a.id && LIVE.includes(r.status));
    const last = (live ? runs.find((r) => r.status !== 'skipped') : runs[0]) ?? null;
    const next = a.enabled && a.mode === 'auto' ? nextDue(a.schedule as unknown as ScheduleSpec, now) : null;
    const w = a.workflow;
    return toAutomationDTO({ ...a, nextRunAt: next } as Automation, {
      workflow: w ? { slug: w.slug, name: w.name, confirmed: w.status === 'confirmed' && !!w.confirmedVersion } : null,
      lastRun: last ? runDto(last) : null,
      openRuns: openAll.filter((r) => r.automationId === a.id).map(runDto),
    });
  });
}

async function dtoOf(id: string): Promise<AutomationDTO> {
  const [dto] = await automationDTOs({ id });
  return dto!;
}

/** Find an automation by id or by exact name (names are what the AI and the update script use). */
export async function findAutomation(ref: string): Promise<Automation | null> {
  const r = ref.trim();
  if (!r) return null;
  return (await prisma.automation.findUnique({ where: { id: r } })) ?? (await prisma.automation.findFirst({ where: { name: r }, orderBy: { createdAt: 'asc' } }));
}

/** Resolve the workflow binding from { workflowId } / { workflowSlug }. undefined = not given. */
async function resolveWorkflow(body: Record<string, unknown>): Promise<{ id: string | null; confirmed: boolean } | undefined | 'missing'> {
  let w: { id: string; status: string; confirmedVersion: number | null } | null | undefined;
  if (typeof body.workflowId === 'string' && body.workflowId) {
    w = await prisma.workflow.findUnique({ where: { id: body.workflowId }, select: { id: true, status: true, confirmedVersion: true } });
  } else if (typeof body.workflowSlug === 'string' && body.workflowSlug) {
    w = await prisma.workflow.findUnique({ where: { slug: body.workflowSlug }, select: { id: true, status: true, confirmedVersion: true } });
  } else if (body.workflowId === null || body.workflowSlug === null) {
    return { id: null, confirmed: false };
  } else return undefined;
  if (!w || w.status === 'archived') return 'missing';
  return { id: w.id, confirmed: w.status === 'confirmed' && !!w.confirmedVersion };
}

/** Optional model / effort fields: absent → undefined, present but invalid → error. */
function modelEffort(b: Record<string, unknown>): { ok: true; model?: string; effort?: string } | { ok: false; error: string } {
  const out: { ok: true; model?: string; effort?: string } = { ok: true };
  if (b.model !== undefined) {
    const m = validateModel(b.model);
    if (!m.ok) return m;
    out.model = m.value;
  }
  if (b.effort !== undefined) {
    const e = validateEffort(b.effort);
    if (!e.ok) return e;
    out.effort = e.value;
  }
  return out;
}

async function projectOk(pid: string): Promise<boolean> {
  return !!(await prisma.project.findFirst({ where: { id: pid, archived: false }, select: { id: true } }));
}

/** Create a task. Body fields as the POST route takes them. */
export async function createAutomation(b: Record<string, unknown>): Promise<SvcResult<AutomationDTO>> {
  const name = validateName(b.name);
  if (!name.ok) return fail(400, name.error);
  const schedule = validateSchedule(b.schedule);
  if (!schedule.ok) return fail(400, schedule.error);
  const inputs = validateInputs(b.inputs);
  if (!inputs.ok) return fail(400, inputs.error);
  const me = modelEffort(b);
  if (!me.ok) return fail(400, me.error);
  const wf = await resolveWorkflow(b);
  if (wf === 'missing') return fail(400, '找不到这个 SOP。');
  const prompt = str(b.prompt)?.trim() || null;
  if (!wf?.id && !prompt) return fail(400, '没有绑定 SOP 时，需要填写固定 prompt。');
  const mode = b.mode === 'auto' ? 'auto' : 'manual';
  if (mode === 'auto' && !wf?.confirmed) return fail(409, NEED_SOP);
  const projectId = str(b.projectId) ?? null;
  if (projectId && !(await projectOk(projectId))) return fail(400, '找不到这个项目。');
  const enabled = b.enabled === false ? false : true;
  const row = await prisma.automation.create({
    data: {
      name: name.value,
      schedule: schedule.value as unknown as object,
      workflowId: wf?.id ?? null,
      prompt,
      inputs: inputs.value ?? undefined,
      mode,
      // Only a live auto task gets a baseline now; a disabled one gets it when enabled.
      autoSince: mode === 'auto' && enabled ? new Date() : null,
      enabled,
      model: me.model ?? (await settings.getModels()).main,
      effort: me.effort ?? 'high',
      projectId,
    },
  });
  changed();
  return { ok: true, value: await dtoOf(row.id) };
}

/** Partial update. Body fields as the PATCH route takes them (incl. mode). */
export async function updateAutomation(id: string, b: Record<string, unknown>): Promise<SvcResult<AutomationDTO>> {
  const cur = await prisma.automation.findUnique({ where: { id }, include: { workflow: { select: { status: true, confirmedVersion: true } } } });
  if (!cur) return fail(404, NOT_FOUND);
  const data: Record<string, unknown> = {};
  if (b.name !== undefined) {
    const n = validateName(b.name);
    if (!n.ok) return fail(400, n.error);
    data.name = n.value;
  }
  if (b.schedule !== undefined) {
    const s = validateSchedule(b.schedule);
    if (!s.ok) return fail(400, s.error);
    data.schedule = s.value as unknown as object;
  }
  if (b.inputs !== undefined) {
    const i = validateInputs(b.inputs);
    if (!i.ok) return fail(400, i.error);
    data.inputs = i.value ?? Prisma.DbNull;
  }
  if (b.prompt !== undefined) data.prompt = str(b.prompt)?.trim() || null;
  if (b.enabled !== undefined) data.enabled = b.enabled === true;
  const me = modelEffort(b);
  if (!me.ok) return fail(400, me.error);
  if (me.model !== undefined) data.model = me.model;
  if (me.effort !== undefined) data.effort = me.effort;
  if (b.projectId !== undefined) {
    const pid = str(b.projectId) ?? null;
    if (pid && !(await projectOk(pid))) return fail(400, '找不到这个项目。');
    data.projectId = pid;
  }
  let confirmed = !!cur.workflow && cur.workflow.status === 'confirmed' && !!cur.workflow.confirmedVersion;
  let workflowId = cur.workflowId;
  const wf = await resolveWorkflow(b);
  if (wf === 'missing') return fail(400, '找不到这个 SOP。');
  if (wf) {
    workflowId = wf.id;
    confirmed = wf.confirmed;
    data.workflowId = wf.id;
  }
  const mode = b.mode === 'auto' || b.mode === 'manual' ? b.mode : cur.mode;
  if (mode === 'auto' && cur.mode === 'auto' && cur.workflowId && !workflowId) return fail(409, '先改回手动，再解绑 SOP。');
  const prompt = 'prompt' in data ? (data.prompt as string | null) : cur.prompt;
  if (!workflowId && !prompt?.trim()) return fail(400, '没有绑定 SOP 时，需要填写固定 prompt。');

  if (mode === 'auto' && (!workflowId || !confirmed)) return fail(409, NEED_SOP);
  if (mode !== cur.mode) data.mode = mode;
  // New baseline (cron never catches up slots at/before autoSince) whenever the task
  // becomes live auto or its schedule really changes — no surprise run for a slot that
  // passed while it was manual / disabled / on the old schedule.
  const enabled = 'enabled' in data ? (data.enabled as boolean) : cur.enabled;
  const becameAuto = mode !== cur.mode;
  const reEnabled = enabled && !cur.enabled;
  const scheduleChanged = 'schedule' in data && !sameSchedule(data.schedule, cur.schedule);
  if (mode === 'auto' && enabled && (becameAuto || reEnabled || scheduleChanged)) data.autoSince = new Date();
  await prisma.automation.update({ where: { id: cur.id }, data });
  changed();
  return { ok: true, value: await dtoOf(cur.id) };
}

export function setMode(id: string, mode: 'manual' | 'auto'): Promise<SvcResult<AutomationDTO>> {
  return updateAutomation(id, { mode });
}

export async function deleteAutomation(id: string): Promise<SvcResult<null>> {
  const r = await prisma.automation.deleteMany({ where: { id } });
  if (r.count === 0) return fail(404, NOT_FOUND);
  changed();
  return { ok: true, value: null };
}

export type RunNowResult =
  | { ok: true; run: AutomationRunDTO }
  | { ok: false; status: number; error: string; runId: string | null; sessionSlug: string | null };

/** Start a manual run now. */
export async function runNow(id: string): Promise<RunNowResult> {
  if (!(await prisma.automation.findUnique({ where: { id }, select: { id: true } }))) {
    return { ok: false, status: 404, error: NOT_FOUND, runId: null, sessionSlug: null };
  }
  const r = await runAutomation(id, { trigger: 'manual' });
  if (r.ok) return { ok: true, run: r.run };
  let sessionSlug: string | null = null;
  if (r.runId) {
    const run = await prisma.automationRun.findUnique({ where: { id: r.runId }, include: { session: { select: { slug: true } } } });
    sessionSlug = run?.session?.slug ?? null;
  }
  return { ok: false, status: 409, error: r.error, runId: r.runId ?? null, sessionSlug };
}

// ── history links ───────────────────────────────────────────────────────────

export interface HistoryLink {
  /** Session id or slug. */
  session: string;
  /** Optional PT date 'YYYY-MM-DD' of the occurrence (for a session reused across several dates). */
  date?: string;
}
export interface LinkOutcome {
  session: string;
  date?: string;
  result: 'linked' | 'duplicate' | 'skipped';
  reason?: string;
  sessionSlug?: string;
  startedAt?: string;
}

const ptDate = (d: Date) => renderInputs({ t: '{today}' }, d)!.t;

/**
 * Link past sessions as earlier runs of a task: AutomationRun{trigger:'history', status:'done'}.
 * startedAt = the session's createdAt, or — with `date` — the first user message that PT day.
 * The same session on the same PT day is never linked twice (nor when it is already a real run).
 * Refreshes lastRunAt / lastSessionId afterwards. History rows are never open, queued or capped.
 * `dryRun`: report what would happen without writing anything.
 */
export async function linkHistory(id: string, links: HistoryLink[], opts: { dryRun?: boolean } = {}): Promise<SvcResult<LinkOutcome[]>> {
  const a = await prisma.automation.findUnique({ where: { id }, select: { id: true } });
  if (!a) return fail(404, NOT_FOUND);
  const out: LinkOutcome[] = [];
  const planned = new Set<string>();
  for (const link of links) {
    const ref = (link.session ?? '').trim();
    const o: LinkOutcome = { session: ref, ...(link.date ? { date: link.date } : {}), result: 'skipped' };
    out.push(o);
    const s = await prisma.session.findFirst({
      where: { OR: [{ id: ref }, { slug: ref }] },
      select: { id: true, slug: true, status: true, createdAt: true },
    });
    if (!s || s.status === 'deleted') {
      o.reason = '找不到这个会话';
      continue;
    }
    o.sessionSlug = s.slug;
    let startedAt = s.createdAt;
    if (link.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(link.date)) {
        o.reason = '日期要写成 YYYY-MM-DD';
        continue;
      }
      // Messages of that PT day: scan a ±1 day UTC window and keep the PT-date matches.
      const [y, m, d] = link.date.split('-').map(Number);
      const from = new Date(Date.UTC(y!, m! - 1, d!) - 86_400_000);
      const to = new Date(Date.UTC(y!, m! - 1, d!) + 2 * 86_400_000);
      const msgs = await prisma.message.findMany({
        where: { sessionId: s.id, role: 'user', createdAt: { gte: from, lt: to } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      const hit = msgs.find((x) => ptDate(x.createdAt) === link.date);
      if (!hit) {
        o.reason = `这个会话在 ${link.date} 没有用户消息`;
        continue;
      }
      startedAt = hit.createdAt;
    }
    const day = ptDate(startedAt);
    const same = await prisma.automationRun.findMany({ where: { automationId: id, sessionId: s.id }, select: { startedAt: true, trigger: true } });
    if (same.some((r) => r.trigger !== 'history' || ptDate(r.startedAt) === day) || planned.has(`${s.id}|${day}`)) {
      o.result = 'duplicate';
      o.startedAt = startedAt.toISOString();
      continue;
    }
    planned.add(`${s.id}|${day}`);
    if (opts.dryRun) {
      o.result = 'linked';
      o.startedAt = startedAt.toISOString();
      continue;
    }
    await prisma.automationRun.create({
      data: { automationId: id, sessionId: s.id, trigger: 'history', status: 'done', note: '历史会话', startedAt, endedAt: startedAt },
    });
    o.result = 'linked';
    o.startedAt = startedAt.toISOString();
  }
  if (!opts.dryRun && out.some((o) => o.result === 'linked')) {
    await refreshAutomation(id);
    changed();
  }
  return { ok: true, value: out };
}

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { AutomationDTO, BoardTodayDTO, ProjectDTO } from '@chapi/shared';

const handleUserMessage = vi.fn(async (_sid: string, _text: string) => undefined);
const isActive = vi.fn((_sid: string) => false);
vi.mock('../../orchestrator/types.js', () => ({
  getOrchestrator: () => ({ handleUserMessage, isActive }),
  setOrchestrator: () => undefined,
}));
vi.mock('../../knowledge/recall.js', () => ({ recallBlock: async () => null }));
vi.mock('../../workflow/notify.js', () => ({ notifyMainAI: () => undefined }));
const classifyAll = vi.fn(async () => ({ projects: 0, assigned: 0 }));
const summarizeProject = vi.fn(async (_id: string) => undefined);
const isClassifying = vi.fn(() => false);
vi.mock('../../board/classify.js', () => ({ classifyAll, isClassifying, summarizeProject, refreshSummariesDaily: async () => undefined }));

const createdSessions: string[] = [];
const createSessionImpl = vi.fn();
vi.mock('../../services/sessions.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../services/sessions.js')>();
  return { ...orig, createSession: (input: unknown) => createSessionImpl(input) };
});

const { prisma } = await import('../../db/client.js');
const { bus } = await import('../../gateway/bus.js');
const { config } = await import('../../config.js');
const { toSessionDTO } = await import('../../mappers.js');
const { boardRoutes } = await import('./board.js');
const { seedAutomations } = await import('../../board/seed.js');
const { __resetRunnerForTests } = await import('../../board/runner.js');
const { hitl } = await import('../../engine/hitl.js');
const { boardCron } = await import('../../board/cron.js');
const { lastDue } = await import('../../board/schedule.js');

const WEB = { origin: `http://127.0.0.1:${config.webPort}` };
const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const automationIds: string[] = [];
const workflowIds: string[] = [];
const projectIds: string[] = [];
const events: string[] = [];
let offBus: (() => void) | null = null;

async function app() {
  const a = Fastify();
  await a.register(boardRoutes, { prefix: '/api' });
  return a;
}

async function makeSession(data: { title?: string; updatedAt?: Date; projectId?: string; status?: string } = {}) {
  const s = await prisma.session.create({
    data: { slug: `board-test-${tag()}`, title: data.title ?? 'board 测试会话', titleSource: 'user', model: 'm', projectId: data.projectId, status: data.status ?? 'active' },
  });
  createdSessions.push(s.id);
  if (data.updatedAt) await prisma.$executeRaw`UPDATE \`Session\` SET updatedAt = ${data.updatedAt} WHERE id = ${s.id}`;
  return s;
}

async function makeProject(name?: string) {
  const p = await prisma.project.create({ data: { name: name ?? `测试项目-${tag()}`.slice(0, 40) } });
  projectIds.push(p.id);
  return p;
}

async function makeWorkflow(status: 'draft' | 'confirmed') {
  const slug = `wf-test-board-${tag()}`;
  const graph = {
    nodes: [
      { id: 'start', type: 'start', title: '开始' },
      { id: 'a', type: 'step', title: '阶段 A', instructions: '做 A。', doneCriteria: ['完成'], evidence: [{ key: 'f', type: 'path' }] },
      { id: 'end', type: 'end', title: '结束' },
    ],
    edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'end' }],
  };
  const w = await prisma.workflow.create({
    data: {
      slug,
      name: `测试 SOP ${slug}`,
      status,
      confirmedVersion: status === 'confirmed' ? 1 : null,
      versions: { create: { version: 1, graph: graph as unknown as object, state: status } },
    },
  });
  workflowIds.push(w.id);
  return w;
}

async function makeAutomation(data: { workflowId?: string | null; prompt?: string | null; mode?: string } = {}) {
  const a = await prisma.automation.create({
    data: {
      name: `测试任务 ${tag()}`,
      workflowId: data.workflowId ?? null,
      prompt: data.prompt === undefined ? '做点事' : data.prompt,
      schedule: { kind: 'daily', time: '18:00' },
      mode: data.mode ?? 'manual',
      model: 'test-model',
    },
  });
  automationIds.push(a.id);
  return a;
}

beforeEach(() => {
  __resetRunnerForTests();
  handleUserMessage.mockClear();
  classifyAll.mockClear();
  createSessionImpl.mockReset();
  createSessionImpl.mockImplementation(async (input: { title?: string; model?: string }) => {
    const s = await makeSession({ title: input.title });
    return toSessionDTO(s);
  });
  events.length = 0;
  offBus = bus.on((e) => {
    if (e.type === 'board.changed') events.push(e.type);
  });
});

afterEach(async () => {
  offBus?.();
  __resetRunnerForTests();
  await prisma.automation.deleteMany({ where: { id: { in: automationIds.splice(0) } } });
  await prisma.session.deleteMany({ where: { id: { in: createdSessions.splice(0) } } });
  await prisma.workflow.deleteMany({ where: { id: { in: workflowIds.splice(0) } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds.splice(0) } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

const okSchedule = { kind: 'daily', time: '09:30' };

describe('origin guard', () => {
  it('every mutating route is 403 without the web-UI origin; GETs are open', async () => {
    const a = await app();
    const p = await makeProject();
    const s = await makeSession();
    const auto = await makeAutomation();
    const calls: Array<[string, string, unknown]> = [
      ['POST', '/api/board/projects', { name: 'x' }],
      ['PATCH', `/api/board/projects/${p.id}`, { name: 'y' }],
      ['POST', `/api/board/projects/${p.id}/merge`, { intoId: p.id }],
      ['PATCH', `/api/sessions/${s.id}/project`, { projectId: p.id }],
      ['POST', '/api/board/classify', {}],
      ['POST', `/api/board/projects/${p.id}/summary`, {}],
      ['POST', '/api/board/automations', { name: 'a', schedule: okSchedule, prompt: 'p' }],
      ['PATCH', `/api/board/automations/${auto.id}`, { name: 'b' }],
      ['DELETE', `/api/board/automations/${auto.id}`, undefined],
      ['POST', `/api/board/automations/${auto.id}/run`, {}],
      ['POST', '/api/board/automation-runs/x/dismiss', {}],
    ];
    for (const [method, url, payload] of calls) {
      const res = await a.inject({ method: method as 'POST', url, payload: payload as object });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      const foreign = await a.inject({ method: method as 'POST', url, payload: payload as object, headers: { origin: `http://evil.example:${config.webPort}` } });
      expect(foreign.statusCode, `foreign ${method} ${url}`).toBe(403);
    }
    expect((await a.inject({ method: 'GET', url: '/api/board/automations' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/board/projects' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/board/today' })).statusCode).toBe(200);
    expect(await prisma.automation.findUnique({ where: { id: auto.id } })).not.toBeNull();
    expect(classifyAll).not.toHaveBeenCalled();
  });
});

describe('automations', () => {
  it('PATCH mode=auto 且无 SOP → 409；SOP 是草稿也 409', async () => {
    const a = await app();
    const t = await makeAutomation();
    const r1 = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { mode: 'auto' }, headers: WEB });
    expect(r1.statusCode).toBe(409);
    expect((r1.json() as { error: string }).error).toContain('SOP');
    const draft = await makeWorkflow('draft');
    const r2 = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { mode: 'auto', workflowId: draft.id }, headers: WEB });
    expect(r2.statusCode).toBe(409);
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: t.id } })).mode).toBe('manual');
  });

  it('PATCH mode=auto 绑已确认 SOP → 200、autoSince=now、nextRunAt 已算；切回 manual 保留 autoSince 且 nextRunAt=null', async () => {
    const a = await app();
    const w = await makeWorkflow('confirmed');
    const t = await makeAutomation({ workflowId: w.id });
    const before = Date.now();
    const r = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { mode: 'auto' }, headers: WEB });
    expect(r.statusCode).toBe(200);
    const dto = (r.json() as { automation: AutomationDTO }).automation;
    expect(dto.mode).toBe('auto');
    expect(dto.workflowConfirmed).toBe(true);
    expect(new Date(dto.autoSince!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(dto.nextRunAt).toBeTruthy();
    expect(events).toContain('board.changed');
    const back = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { mode: 'manual' }, headers: WEB });
    const d2 = (back.json() as { automation: AutomationDTO }).automation;
    expect(d2.mode).toBe('manual');
    expect(d2.autoSince).toBe(dto.autoSince);
    expect(d2.nextRunAt).toBeNull();
  });

  it('POST run 两次 → 第二次 409 且带 runId / sessionSlug', async () => {
    const a = await app();
    const t = await makeAutomation({ prompt: '写点东西' });
    const r1 = await a.inject({ method: 'POST', url: `/api/board/automations/${t.id}/run`, headers: WEB });
    expect(r1.statusCode).toBe(200);
    const run1 = (r1.json() as { run: { id: string } }).run;
    const r2 = await a.inject({ method: 'POST', url: `/api/board/automations/${t.id}/run`, headers: WEB });
    expect(r2.statusCode).toBe(409);
    const body = r2.json() as { error: string; runId: string; sessionSlug: string };
    expect(body.runId).toBe(run1.id);
    expect(body.sessionSlug).toMatch(/^board-test-/);
    expect(body.error).toBeTruthy();
  });

  it('创建：校验频率 / 名称 / inputs / prompt（400 中文）', async () => {
    const a = await app();
    const post = (payload: object) => a.inject({ method: 'POST', url: '/api/board/automations', payload, headers: WEB });
    const base = { name: '校验任务', prompt: 'p', schedule: okSchedule };
    const bads: object[] = [
      { ...base, name: '' },
      { ...base, name: 'x'.repeat(61) },
      { ...base, schedule: { kind: 'daily', time: '24:00' } },
      { ...base, schedule: { kind: 'daily', time: '9:30' } },
      { ...base, schedule: { kind: 'hourly', time: '09:30' } },
      { ...base, schedule: { kind: 'weekly', time: '09:30' } },
      { ...base, schedule: { kind: 'weekly', time: '09:30', weekdays: [] } },
      { ...base, schedule: { kind: 'weekly', time: '09:30', weekdays: [7] } },
      { ...base, schedule: { kind: 'biweekly', time: '09:30', weekdays: [3] } },
      { ...base, schedule: { kind: 'biweekly', time: '09:30', weekdays: [3], anchorDate: '11/18' } },
      { ...base, schedule: { kind: 'monthly', time: '09:30' } },
      { ...base, schedule: { kind: 'monthly', time: '09:30', dayOfMonth: 32 } },
      { ...base, inputs: { a: 1 } },
      { ...base, inputs: [] },
      { name: '没有 prompt', schedule: okSchedule },
      { ...base, prompt: '   ' },
    ];
    for (const b of bads) {
      const res = await post(b);
      expect(res.statusCode, JSON.stringify(b)).toBe(400);
      expect(/[一-龥]/.test((res.json() as { error: string }).error)).toBe(true);
    }
    expect(await prisma.automation.count({ where: { name: { in: ['校验任务', '没有 prompt'] } } })).toBe(0);
    const ok = await post({ ...base, schedule: { kind: 'biweekly', time: '09:00', weekdays: [3], anchorDate: '2026-11-18' }, inputs: { column: '{MDYY} Updates' } });
    expect(ok.statusCode).toBe(201);
    const dto = (ok.json() as { automation: AutomationDTO }).automation;
    automationIds.push(dto.id);
    expect(dto.mode).toBe('manual');
    expect(dto.nextRunAt).toBeNull();
    expect(dto.inputs).toEqual({ column: '{MDYY} Updates' });
  });

  it('PATCH inputs:null → 200 且 DTO.inputs 为 null', async () => {
    const a = await app();
    const t = await makeAutomation();
    await prisma.automation.update({ where: { id: t.id }, data: { inputs: { a: 'b' } } });
    const r = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { inputs: null }, headers: WEB });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { automation: AutomationDTO }).automation.inputs).toBeNull();
  });

  it('run 对不存在的任务 → 404；openRuns 不被 30 条上限截断', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/board/automations/nope/run', headers: WEB })).statusCode).toBe(404);
    const t = await makeAutomation();
    const base = Date.now() - 1e9;
    await prisma.automationRun.create({ data: { automationId: t.id, status: 'stale', startedAt: new Date(base) } });
    for (let i = 0; i < 31; i++) await prisma.automationRun.create({ data: { automationId: t.id, status: 'done', startedAt: new Date(base + 1000 * (i + 1)) } });
    const dto = ((await a.inject({ method: 'GET', url: '/api/board/automations' })).json() as { automations: AutomationDTO[] }).automations.find((x) => x.id === t.id)!;
    expect(dto.openRuns).toHaveLength(1);
  });

  it('PATCH 校验频率；DELETE 删除', async () => {
    const a = await app();
    const t = await makeAutomation();
    const bad = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { schedule: { kind: 'monthly', time: '10:00' } }, headers: WEB });
    expect(bad.statusCode).toBe(400);
    const del = await a.inject({ method: 'DELETE', url: `/api/board/automations/${t.id}`, headers: WEB });
    expect(del.statusCode).toBe(200);
    expect(await prisma.automation.findUnique({ where: { id: t.id } })).toBeNull();
  });

  it('lastRun 跳过 skipped（有活跃运行时）；openRuns 含 stale/waiting_user', async () => {
    const a = await app();
    const t = await makeAutomation();
    const s = await makeSession();
    const t0 = Date.now();
    const live = await prisma.automationRun.create({ data: { automationId: t.id, sessionId: s.id, status: 'running', startedAt: new Date(t0 - 5000) } });
    await prisma.automationRun.create({ data: { automationId: t.id, status: 'skipped', note: '上次还没完成', startedAt: new Date(t0), endedAt: new Date(t0) } });
    const stale = await prisma.automationRun.create({ data: { automationId: t.id, sessionId: s.id, status: 'stale', startedAt: new Date(t0 - 90_000_000) } });
    const dto = ((await a.inject({ method: 'GET', url: '/api/board/automations' })).json() as { automations: AutomationDTO[] }).automations.find((x) => x.id === t.id)!;
    expect(dto.lastRun?.id).toBe(live.id);
    expect(dto.openRuns.map((r) => r.id).sort()).toEqual([live.id, stale.id].sort());
    expect(dto.openRuns[0]!.sessionSlug).toMatch(/^board-test-/);
    // no live run → newest overall (the skipped one)
    await prisma.automationRun.update({ where: { id: live.id }, data: { status: 'done' } });
    const dto2 = ((await a.inject({ method: 'GET', url: '/api/board/automations' })).json() as { automations: AutomationDTO[] }).automations.find((x) => x.id === t.id)!;
    expect(dto2.lastRun?.status).toBe('skipped');
  });

  it('dismiss：waiting_user / stale → failed「用户关闭」；其它状态 409', async () => {
    const a = await app();
    const t = await makeAutomation();
    const w = await prisma.automationRun.create({ data: { automationId: t.id, status: 'waiting_user' } });
    const st = await prisma.automationRun.create({ data: { automationId: t.id, status: 'stale', startedAt: new Date(Date.now() - 1e8) } });
    const done = await prisma.automationRun.create({ data: { automationId: t.id, status: 'done', startedAt: new Date(Date.now() - 2e8) } });
    for (const id of [w.id, st.id]) {
      const r = await a.inject({ method: 'POST', url: `/api/board/automation-runs/${id}/dismiss`, headers: WEB });
      expect(r.statusCode).toBe(200);
      const row = await prisma.automationRun.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('failed');
      expect(row.note).toBe('用户关闭');
      expect(row.endedAt).not.toBeNull();
    }
    expect(events).toContain('board.changed');
    expect((await a.inject({ method: 'POST', url: `/api/board/automation-runs/${done.id}/dismiss`, headers: WEB })).statusCode).toBe(409);
    expect((await a.inject({ method: 'POST', url: '/api/board/automation-runs/nope/dismiss', headers: WEB })).statusCode).toBe(404);
    expect((await prisma.automationRun.findUniqueOrThrow({ where: { id: done.id } })).status).toBe('done');
  });
});

describe('autoSince（不补跑意外的时刻）', () => {
  // 2026-11-24 19:00 PT == 2026-11-25 03:00 UTC; today's 18:00 PT slot is 1h old.
  const AT_1900 = new Date('2026-11-25T03:00:00Z');
  const SLOT_1800 = new Date('2026-11-25T02:00:00Z');
  const LONG_AGO = new Date('2026-10-01T00:00:00Z');

  async function liveAuto(data: { enabled: boolean; schedule?: object }) {
    const w = await makeWorkflow('confirmed');
    const t = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    await prisma.automation.update({
      where: { id: t.id },
      data: { enabled: data.enabled, autoSince: LONG_AGO, createdAt: LONG_AGO, ...(data.schedule ? { schedule: data.schedule } : {}) },
    });
    return t;
  }
  const runsOf = (id: string) => prisma.automationRun.count({ where: { automationId: id } });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AT_1900);
  });
  afterEach(() => {
    boardCron.stop();
    vi.useRealTimers();
  });

  it('19:00 重新启用（18:00 的时刻已过）→ autoSince=now，cron tick 不补跑', async () => {
    const a = await app();
    const t = await liveAuto({ enabled: false });
    expect(lastDue({ kind: 'daily', time: '18:00' }, AT_1900)?.getTime()).toBe(SLOT_1800.getTime()); // a real, catch-up-able slot
    const r = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { enabled: true, schedule: { kind: 'daily', time: '18:00' } }, headers: WEB });
    expect(r.statusCode).toBe(200);
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: t.id } })).autoSince?.getTime()).toBe(AT_1900.getTime());
    await boardCron.tick(AT_1900);
    expect(await runsOf(t.id)).toBe(0);
  });

  it('改频率 → autoSince=now，不会立刻补跑新频率下已过的时刻', async () => {
    const a = await app();
    const t = await liveAuto({ enabled: true, schedule: { kind: 'daily', time: '20:00' } });
    const r = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { enabled: true, schedule: { kind: 'daily', time: '18:00' } }, headers: WEB });
    expect(r.statusCode).toBe(200);
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: t.id } })).autoSince?.getTime()).toBe(AT_1900.getTime());
    await boardCron.tick(AT_1900);
    expect(await runsOf(t.id)).toBe(0);
  });

  it('编辑器原样重发频率 + enabled（键顺序不同）→ autoSince 不变', async () => {
    const a = await app();
    const t = await liveAuto({ enabled: true, schedule: { kind: 'weekly', time: '18:00', weekdays: [1, 3] } });
    const r = await a.inject({
      method: 'PATCH',
      url: `/api/board/automations/${t.id}`,
      payload: { name: '改个名', enabled: true, schedule: { weekdays: [3, 1], time: '18:00', kind: 'weekly' } },
      headers: WEB,
    });
    expect(r.statusCode).toBe(200);
    const row = await prisma.automation.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.autoSince?.getTime()).toBe(LONG_AGO.getTime());
    expect(row.name).toBe('改个名');
  });

  it('POST：auto+启用 → autoSince=now；auto+停用 → autoSince=null', async () => {
    const a = await app();
    const w = await makeWorkflow('confirmed');
    const post = async (enabled: boolean) => {
      const r = await a.inject({ method: 'POST', url: '/api/board/automations', payload: { name: `auto-${enabled}`, schedule: okSchedule, workflowId: w.id, mode: 'auto', enabled }, headers: WEB });
      expect(r.statusCode).toBe(201);
      const dto = (r.json() as { automation: AutomationDTO }).automation;
      automationIds.push(dto.id);
      return prisma.automation.findUniqueOrThrow({ where: { id: dto.id } });
    };
    expect((await post(true)).autoSince?.getTime()).toBe(AT_1900.getTime());
    expect((await post(false)).autoSince).toBeNull();
  });
});

describe('model / effort 校验与解绑 SOP', () => {
  it('POST / PATCH：effort 不在列表、model 为空或超过 100 → 400；合法值写入', async () => {
    const a = await app();
    const base = { name: '校验 model', prompt: 'p', schedule: okSchedule };
    for (const extra of [{ effort: 'turbo' }, { effort: 3 }, { model: '' }, { model: '   ' }, { model: 'x'.repeat(101) }, { model: 42 }]) {
      const r = await a.inject({ method: 'POST', url: '/api/board/automations', payload: { ...base, ...extra }, headers: WEB });
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
      expect(/[一-龥]/.test((r.json() as { error: string }).error)).toBe(true);
    }
    expect(await prisma.automation.count({ where: { name: '校验 model' } })).toBe(0);
    const t = await makeAutomation();
    for (const extra of [{ effort: 'ultra' }, { model: '' }]) {
      const r = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: extra, headers: WEB });
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
    }
    const ok = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { effort: 'xhigh', model: 'claude-x' }, headers: WEB });
    expect(ok.statusCode).toBe(200);
    const row = await prisma.automation.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.effort).toBe('xhigh');
    expect(row.model).toBe('claude-x');
  });

  it('自动任务解绑 SOP → 409「先改回手动，再解绑 SOP」；同时改回手动 → 200', async () => {
    const a = await app();
    const w = await makeWorkflow('confirmed');
    const t = await makeAutomation({ workflowId: w.id, mode: 'auto', prompt: null });
    const r = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { workflowId: null, prompt: '固定 prompt' }, headers: WEB });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: string }).error).toContain('先改回手动，再解绑 SOP');
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: t.id } })).workflowId).toBe(w.id);
    const ok = await a.inject({ method: 'PATCH', url: `/api/board/automations/${t.id}`, payload: { workflowId: null, prompt: '固定 prompt', mode: 'manual' }, headers: WEB });
    expect(ok.statusCode).toBe(200);
    const row = await prisma.automation.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.workflowId).toBeNull();
    expect(row.mode).toBe('manual');
  });
});

describe('projects & session assignment', () => {
  it('PATCH sessions/:id/project → projectSource=user，且不改 updatedAt；null 清空', async () => {
    const a = await app();
    const p = await makeProject();
    const old = new Date('2026-01-05T12:00:00Z');
    const s = await makeSession({ updatedAt: old });
    const r = await a.inject({ method: 'PATCH', url: `/api/sessions/${s.id}/project`, payload: { projectId: p.id }, headers: WEB });
    expect(r.statusCode).toBe(200);
    const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.projectId).toBe(p.id);
    expect(row.projectSource).toBe('user');
    expect(row.updatedAt.getTime()).toBe(old.getTime());
    const clear = await a.inject({ method: 'PATCH', url: `/api/sessions/${s.id}/project`, payload: { projectId: null }, headers: WEB });
    expect(clear.statusCode).toBe(200);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: s.id } })).projectId).toBeNull();
    expect((await a.inject({ method: 'PATCH', url: `/api/sessions/${s.id}/project`, payload: { projectId: 'nope' }, headers: WEB })).statusCode).toBe(404);
  });

  it('创建 / 重命名校验（1–40 字、重名 409）、列表含 sessionCount 与未归类计数', async () => {
    const a = await app();
    const name = `项目-${tag()}`;
    expect((await a.inject({ method: 'POST', url: '/api/board/projects', payload: { name: '' }, headers: WEB })).statusCode).toBe(400);
    expect((await a.inject({ method: 'POST', url: '/api/board/projects', payload: { name: 'x'.repeat(41) }, headers: WEB })).statusCode).toBe(400);
    const c = await a.inject({ method: 'POST', url: '/api/board/projects', payload: { name }, headers: WEB });
    expect(c.statusCode).toBe(201);
    const p = (c.json() as { project: ProjectDTO }).project;
    projectIds.push(p.id);
    expect((await a.inject({ method: 'POST', url: '/api/board/projects', payload: { name }, headers: WEB })).statusCode).toBe(409);
    const other = await makeProject();
    expect((await a.inject({ method: 'PATCH', url: `/api/board/projects/${other.id}`, payload: { name }, headers: WEB })).statusCode).toBe(409);
    const ren = await a.inject({ method: 'PATCH', url: `/api/board/projects/${p.id}`, payload: { name: `${name}-改`, sortOrder: 999 }, headers: WEB });
    expect(ren.statusCode).toBe(200);
    await makeSession({ projectId: p.id });
    await makeSession({ projectId: p.id, status: 'deleted' });
    const list = (await a.inject({ method: 'GET', url: '/api/board/projects' })).json() as { projects: ProjectDTO[]; unassignedCount: number };
    const mine = list.projects.find((x) => x.id === p.id)!;
    expect(mine.sessionCount).toBe(1);
    expect(mine.name).toBe(`${name}-改`);
    expect(typeof list.unassignedCount).toBe('number');
    const sorted = list.projects.map((x) => x.sortOrder);
    expect(sorted).toEqual([...sorted].sort((x, y) => x - y));
    const ss = (await a.inject({ method: 'GET', url: `/api/board/projects/${p.id}/sessions` })).json() as { sessions: unknown[] };
    expect(ss.sessions).toHaveLength(1);
  });

  it('merge：会话（保留 projectSource）和任务移到目标，源项目归档', async () => {
    const a = await app();
    const from = await makeProject();
    const into = await makeProject();
    const s = await makeSession({ projectId: from.id });
    await prisma.session.update({ where: { id: s.id }, data: { projectSource: 'user' } });
    const t = await makeAutomation();
    await prisma.automation.update({ where: { id: t.id }, data: { projectId: from.id } });
    const r = await a.inject({ method: 'POST', url: `/api/board/projects/${from.id}/merge`, payload: { intoId: into.id }, headers: WEB });
    expect(r.statusCode).toBe(200);
    const row = await prisma.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.projectId).toBe(into.id);
    expect(row.projectSource).toBe('user');
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: t.id } })).projectId).toBe(into.id);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: from.id } })).archived).toBe(true);
    const list = (await a.inject({ method: 'GET', url: '/api/board/projects' })).json() as { projects: ProjectDTO[] };
    expect(list.projects.find((x) => x.id === from.id)).toBeUndefined();
    expect((await a.inject({ method: 'POST', url: `/api/board/projects/${into.id}/merge`, payload: { intoId: into.id }, headers: WEB })).statusCode).toBe(400);
  });

  it('classify 返回 202 并在后台触发；summary 触发 summarizeProject', async () => {
    const a = await app();
    expect((await a.inject({ method: 'POST', url: '/api/board/classify', headers: WEB })).statusCode).toBe(202);
    expect(classifyAll).toHaveBeenCalledTimes(1);
    expect(((await a.inject({ method: 'GET', url: '/api/board/projects' })).json() as { classifying: boolean }).classifying).toBe(false);
    isClassifying.mockReturnValueOnce(true);
    expect(((await a.inject({ method: 'GET', url: '/api/board/projects' })).json() as { classifying: boolean }).classifying).toBe(true);
    const p = await makeProject();
    expect((await a.inject({ method: 'POST', url: `/api/board/projects/${p.id}/summary`, headers: WEB })).statusCode).toBe(200);
    expect(summarizeProject).toHaveBeenCalledWith(p.id);
    expect(events).toContain('board.changed');
    await prisma.project.update({ where: { id: p.id }, data: { archived: true } });
    expect((await a.inject({ method: 'POST', url: `/api/board/projects/${p.id}/summary`, headers: WEB })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/api/board/projects/nope/summary', headers: WEB })).statusCode).toBe(404);
  });
});

describe('GET /board/today', () => {
  const find = (d: BoardTodayDTO, id: string) =>
    (['running', 'waiting', 'done'] as const).map((k) => [k, d[k].find((c) => c.id === id)] as const).find(([, c]) => c) ?? [null, undefined];

  it('有 open question 的会话在 waiting；审批 pending 也在 waiting；其余今天的在 done；旧会话不出现', async () => {
    const a = await app();
    const q = await makeSession({ title: '有问题' });
    await prisma.pendingQuestion.create({ data: { sessionId: q.id, question: '选哪个？' } });
    const ap = await makeSession({ title: '待审批' });
    await prisma.approval.create({ data: { sessionId: ap.id, summary: 's', artifacts: [] } });
    const dn = await makeSession({ title: '已完成' });
    const old = await makeSession({ title: '很久以前', updatedAt: new Date('2026-01-05T12:00:00Z') });
    const answered = await makeSession({ title: '已答复' });
    await prisma.pendingQuestion.create({ data: { sessionId: answered.id, question: 'x', status: 'answered' } });
    const today = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    const [kq, cq] = find(today, q.id);
    expect(kq).toBe('waiting');
    expect(cq?.waitingKind).toBe('question');
    const [ka, ca] = find(today, ap.id);
    expect(ka).toBe('waiting');
    expect(ca?.waitingKind).toBe('approval');
    expect(find(today, dn.id)[0]).toBe('done');
    expect(find(today, answered.id)[0]).toBe('done');
    expect(find(today, old.id)[0]).toBeNull();
  });

  it('running 会话带 progress（进行中的 PlanTask 优先，截断 120）；deleted 不出现', async () => {
    const a = await app();
    const r = await makeSession({ title: '跑着' });
    bus.emit({ type: 'run.state', sessionId: r.id, state: 'running' } as never);
    isActive.mockImplementation((id) => id === r.id);
    await prisma.planTask.create({ data: { sessionId: r.id, ordinal: 1, text: '长'.repeat(200), status: 'in_progress' } });
    await prisma.agentRun.create({ data: { sessionId: r.id, name: 'main', status: 'running', currentActivity: '读取文件' } });
    const r2 = await makeSession({ title: '只有活动' });
    bus.emit({ type: 'run.state', sessionId: r2.id, state: 'paused' } as never);
    isActive.mockImplementation((id) => id === r.id || id === r2.id);
    await prisma.agentRun.create({ data: { sessionId: r2.id, name: 'main', status: 'running', currentActivity: '读取文件' } });
    const del = await makeSession({ title: '已删除', status: 'deleted' });
    const today = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    const c1 = today.running.find((c) => c.id === r.id);
    expect(c1?.progress).toBe('长'.repeat(120));
    expect(today.running.find((c) => c.id === r2.id)?.progress).toBe('读取文件');
    expect(find(today, del.id)[0]).toBeNull();
    isActive.mockImplementation(() => false);
  });

  it('旧会话只要有 waiting_user / stale 的自动运行就出现（stale 标记），不论日期；dismiss 后消失', async () => {
    const a = await app();
    const t = await makeAutomation();
    const old = await makeSession({ title: '旧的等待', updatedAt: new Date('2026-01-05T12:00:00Z') });
    const run = await prisma.automationRun.create({ data: { automationId: t.id, sessionId: old.id, status: 'stale', startedAt: new Date('2026-01-05T12:00:00Z') } });
    const today = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    const card = today.waiting.find((c) => c.id === old.id);
    expect(card?.stale).toBe(true);
    expect(card?.automationRunId).toBe(run.id);
    await a.inject({ method: 'POST', url: `/api/board/automation-runs/${run.id}/dismiss`, headers: WEB });
    const after = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    expect(find(after, old.id)[0]).toBeNull();
  });

  it('一月的 open question / pending approval（没有实时等待、没有自动运行）不再出现', async () => {
    const a = await app();
    const old = new Date('2026-01-05T12:00:00Z');
    const q = await makeSession({ title: '旧问题', updatedAt: old });
    await prisma.pendingQuestion.create({ data: { sessionId: q.id, question: '还没回答', createdAt: old } });
    await prisma.$executeRaw`UPDATE \`Session\` SET updatedAt = ${old} WHERE id = ${q.id}`;
    const ap = await makeSession({ title: '旧审批', updatedAt: old });
    await prisma.approval.create({ data: { sessionId: ap.id, summary: 's', artifacts: [], createdAt: old } });
    await prisma.$executeRaw`UPDATE \`Session\` SET updatedAt = ${old} WHERE id = ${ap.id}`;
    // updated today but its only open approval is old → normal bucket, waitingKind null
    const touched = await makeSession({ title: '今天动过' });
    await prisma.approval.create({ data: { sessionId: touched.id, summary: 's', artifacts: [], createdAt: old } });
    const today = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    expect(find(today, q.id)[0]).toBeNull();
    expect(find(today, ap.id)[0]).toBeNull();
    const [k, c] = find(today, touched.id);
    expect(k).toBe('done');
    expect(c?.waitingKind).toBeNull();
  });

  it('HITL 实时等待的会话在 waiting（哪怕很旧、run 仍在跑），解除后不再出现', async () => {
    const a = await app();
    const old = new Date('2026-01-05T12:00:00Z');
    const s = await makeSession({ title: '实时等审批', updatedAt: old });
    void hitl.waitForApproval(`ap-${s.id}`, s.id);
    bus.emit({ type: 'run.state', sessionId: s.id, state: 'running' } as never);
    const today = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    const [k, c] = find(today, s.id);
    expect(k).toBe('waiting');
    expect(c?.waitingKind).toBe('approval');
    hitl.resolveApproval(`ap-${s.id}`, { decision: 'approve' } as never);
    bus.emit({ type: 'run.state', sessionId: s.id, state: 'idle' } as never);
    const after = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    expect(find(after, s.id)[0]).toBeNull();
  });

  it('1 天前的 open approval 在 waiting；5 天前的不出现', async () => {
    const a = await app();
    const old = new Date('2026-01-05T12:00:00Z');
    const day = 86400000;
    const s1 = await makeSession({ title: '一天前审批', updatedAt: old });
    await prisma.approval.create({ data: { sessionId: s1.id, summary: 's', artifacts: [], createdAt: new Date(Date.now() - day) } });
    await prisma.$executeRaw`UPDATE \`Session\` SET updatedAt = ${old} WHERE id = ${s1.id}`;
    const s5 = await makeSession({ title: '五天前审批', updatedAt: old });
    await prisma.approval.create({ data: { sessionId: s5.id, summary: 's', artifacts: [], createdAt: new Date(Date.now() - 5 * day) } });
    await prisma.$executeRaw`UPDATE \`Session\` SET updatedAt = ${old} WHERE id = ${s5.id}`;
    const today = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    expect(today.waiting.find((c) => c.id === s1.id)?.waitingKind).toBe('approval');
    expect(find(today, s5.id)[0]).toBeNull();
  });

  it('每个分组按 updatedAt 倒序，done 最多 50', async () => {
    const a = await app();
    const now = Date.now();
    for (let i = 0; i < 53; i++) await makeSession({ title: `d${i}`, updatedAt: new Date(now - i * 1000) });
    const today = (await a.inject({ method: 'GET', url: '/api/board/today' })).json() as BoardTodayDTO;
    expect(today.done.length).toBe(50);
    const ts = today.done.map((c) => Date.parse(c.updatedAt));
    expect(ts).toEqual([...ts].sort((x, y) => y - x));
  });
});

describe('seedAutomations', () => {
  it('事务内（回滚）：空表插入 6 条、EOD 用历史会话首条消息、SOP 按已确认绑定、再执行仍 6 条', async () => {
    const SENTINEL = new Error('rollback');
    const marker = `历史 EOD 首条消息 ${tag()}`;
    const real = await prisma.workflow.findUnique({ where: { slug: 'tracker-weekly' }, select: { id: true, status: true, confirmedVersion: true } });
    const realConfirmed = !!real && real.status === 'confirmed' && !!real.confirmedVersion;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.automation.deleteMany({}); // inside the transaction only; rolled back below
        await tx.setting.deleteMany({ where: { key: 'board.seeded' } });
        const s = await tx.session.create({ data: { slug: `board-seed-${tag()}`, title: '每日总结邮件 测试', titleSource: 'user', model: 'm' } });
        await tx.message.create({ data: { sessionId: s.id, role: 'user', type: 'user', content: [], text: marker } });
        expect(await seedAutomations(tx)).toBe(6);
        expect(await seedAutomations(tx)).toBe(0);
        const rows = await tx.automation.findMany({ orderBy: { createdAt: 'asc' } });
        expect(rows).toHaveLength(6);
        expect(rows.every((r) => r.mode === 'manual' && r.enabled && r.effort === 'high')).toBe(true);
        const by = (n: string) => rows.find((r) => r.name.includes(n))!;
        expect(by('EOD').prompt).toBe(marker);
        expect(by('EOD').schedule).toEqual({ kind: 'weekdays', time: '18:00' });
        expect(by('Sales').schedule).toEqual({ kind: 'weekly', time: '16:00', weekdays: [5] });
        expect(by('Updates 列').schedule).toEqual({ kind: 'biweekly', time: '09:00', weekdays: [3], anchorDate: '2026-11-18' });
        expect(by('Updates 列').inputs).toEqual({ column: '{MDYY} Updates' });
        expect(by('三表同步').prompt).toContain('三表同步规则');
        const tw = by('Project Tracker');
        if (realConfirmed) {
          expect(tw.workflowId).toBe(real!.id);
          expect(tw.prompt).toBeNull();
        } else {
          expect(tw.workflowId).toBeNull();
          expect(tw.prompt).toBe('按 SOP tracker-weekly 执行');
        }
        expect(rows.every((r) => r.workflowId || r.prompt?.trim())).toBe(true);
        // one-time marker: emptying the table later never re-seeds
        expect(await tx.setting.findUnique({ where: { key: 'board.seeded' } })).not.toBeNull();
        await tx.automation.deleteMany({});
        expect(await seedAutomations(tx)).toBe(0);
        expect(await tx.automation.count()).toBe(0);
        throw SENTINEL;
      }, { timeout: 30000 }),
    ).rejects.toBe(SENTINEL);
  });

  it('事务内（回滚）：表里已有任务但没有标记 → 不插入，只写标记', async () => {
    const SENTINEL = new Error('rollback');
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.setting.deleteMany({ where: { key: 'board.seeded' } });
        await tx.automation.deleteMany({});
        await tx.automation.create({ data: { name: '已有任务', schedule: okSchedule, prompt: 'p', model: 'm' } });
        expect(await seedAutomations(tx)).toBe(0);
        expect(await tx.automation.count()).toBe(1);
        expect(await tx.setting.findUnique({ where: { key: 'board.seeded' } })).not.toBeNull();
        await tx.automation.deleteMany({});
        expect(await seedAutomations(tx)).toBe(0);
        throw SENTINEL;
      }, { timeout: 30000 }),
    ).rejects.toBe(SENTINEL);
  });
});

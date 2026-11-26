import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../knowledge/recall.js', () => ({ recallBlock: vi.fn(async () => null) }));
const handleUserMessage = vi.fn(async (_sid: string, _text: string) => undefined);
vi.mock('../orchestrator/types.js', () => ({
  getOrchestrator: () => ({ handleUserMessage, isActive: () => false }),
  setOrchestrator: () => undefined,
}));
vi.mock('../workflow/notify.js', () => ({ notifyMainAI: vi.fn() }));

const createdSessions: string[] = [];
vi.mock('../services/sessions.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/sessions.js')>();
  const { prisma } = await import('../db/client.js');
  const { toSessionDTO } = await import('../mappers.js');
  return {
    ...orig,
    createSession: async (input: { title?: string }) => {
      const s = await prisma.session.create({
        data: { slug: `tools-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: input.title ?? 'x', titleSource: 'user', model: 'm' },
      });
      createdSessions.push(s.id);
      return toSessionDTO(s);
    },
  };
});

const { prisma } = await import('../db/client.js');
const { bus } = await import('../gateway/bus.js');
const { hitl } = await import('../engine/hitl.js');
const { __resetRunnerForTests } = await import('./runner.js');
const { buildBoardTools, BOARD_TOOL_NAMES } = await import('./tools.js');
const { CHAPI_TOOL_NAMES } = await import('../engine/tools/chapiTools.js');

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const automationIds: string[] = [];
const workflowIds: string[] = [];
const approvals: string[] = [];
let offBus: (() => void) | null = null;
let chatSession: { id: string; slug: string };

type ToolDef = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }> };
function tools(sessionId: string) {
  const all = buildBoardTools(sessionId) as unknown as ToolDef[];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = all.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return (await t.handler(args, {})).content[0]!.text;
  };
  return { all, call };
}

async function makeSession() {
  const s = await prisma.session.create({ data: { slug: `tools-test-${tag()}`, title: 'tools 测试', titleSource: 'user', model: 'm' } });
  createdSessions.push(s.id);
  return s;
}

async function makeWorkflow(status: 'draft' | 'confirmed') {
  const slug = `wf-test-tools-${tag()}`;
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

async function makeAuto(data: { name?: string; workflowId?: string | null; mode?: string } = {}) {
  const a = await prisma.automation.create({
    data: {
      name: data.name ?? `tools 测试 ${tag()}`.slice(0, 60),
      workflowId: data.workflowId ?? null,
      prompt: data.workflowId ? null : 'do it',
      schedule: { kind: 'weekdays', time: '10:00' },
      mode: data.mode ?? 'manual',
      model: 'm',
      effort: 'high',
    },
  });
  automationIds.push(a.id);
  return a;
}

const approve = (decision: 'approve' | 'reject', feedback?: string) =>
  vi.spyOn(hitl, 'waitForApproval').mockImplementation(async (id: string) => {
    approvals.push(id);
    return { decision, feedback } as never;
  });

const cardEvents: Array<{ summary: string }> = [];

beforeEach(async () => {
  __resetRunnerForTests();
  chatSession = await makeSession();
  cardEvents.length = 0;
  offBus = bus.on((e) => {
    if (e.type === 'approval.request') cardEvents.push({ summary: e.approval.summary });
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  offBus?.();
  __resetRunnerForTests();
  await prisma.approval.deleteMany({ where: { id: { in: approvals.splice(0) } } });
  await prisma.automation.deleteMany({ where: { id: { in: automationIds.splice(0) } } });
  await prisma.session.deleteMany({ where: { id: { in: createdSessions.splice(0) } } });
  await prisma.workflow.deleteMany({ where: { id: { in: workflowIds.splice(0) } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('registration', () => {
  it('exposes exactly the 6 tools, all on the chapi server list', () => {
    const names = (buildBoardTools('x') as unknown as ToolDef[]).map((t) => `mcp__chapi__${t.name}`);
    expect(names).toEqual(BOARD_TOOL_NAMES);
    for (const n of BOARD_TOOL_NAMES) expect(CHAPI_TOOL_NAMES).toContain(n);
  });
});

describe('automation_list', () => {
  it('lists frequency in Chinese, SOP, mode and last run', async () => {
    const a = await makeAuto({ name: `列表测试 ${tag()}`.slice(0, 60) });
    const out = await tools(chatSession.id).call('automation_list');
    expect(out).toContain(`「${a.name}」`);
    expect(out).toContain('每个工作日 10:00');
    expect(out).toContain('无（固定 prompt）');
    expect(out).toContain('手动');
    expect(out).toContain('从未运行');
  });
});

describe('automation_upsert', () => {
  it('creates as manual; edits by name; rejects mode; validation errors come back in Chinese', async () => {
    const { call } = tools(chatSession.id);
    const name = `新建测试 ${tag()}`.slice(0, 60);
    const created = await call('automation_upsert', { name, prompt: 'p', schedule: { kind: 'monthly', time: '09:00', daysOfMonth: [25, 10] } });
    expect(created).toContain('已新建（手动）');
    expect(created).toContain('每月 10、25 日 09:00');
    const row = await prisma.automation.findFirstOrThrow({ where: { name } });
    automationIds.push(row.id);
    expect(row.mode).toBe('manual');

    expect(await call('automation_upsert', { automation: name, mode: 'auto' })).toContain('不能改手动/自动');
    expect(await call('automation_upsert', { name: `x${tag()}`, prompt: 'p', mode: 'auto', schedule: { kind: 'daily', time: '09:00' } })).toContain('不能改手动/自动');

    const edited = await call('automation_upsert', { automation: name, schedule: { kind: 'daily', time: '25:00' } });
    expect(edited).toContain('没有保存');
    expect(edited).toContain('HH:mm');

    const ok = await call('automation_upsert', { automation: name, inputs: { date: '{prevWorkday}' }, schedule: { kind: 'weekdays', time: '10:00' } });
    expect(ok).toContain('已修改');
    const after = await prisma.automation.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.inputs).toEqual({ date: '{prevWorkday}' });
  });

  it('an existing auto task stays auto after an edit; binding a draft SOP to it is refused', async () => {
    const wf = await makeWorkflow('confirmed');
    const draft = await makeWorkflow('draft');
    const a = await makeAuto({ workflowId: wf.id, mode: 'auto' });
    const { call } = tools(chatSession.id);
    expect(await call('automation_upsert', { automation: a.id, schedule: { kind: 'daily', time: '08:00' } })).toContain('已修改');
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: a.id } })).mode).toBe('auto');
    expect(await call('automation_upsert', { automation: a.id, workflow: draft.slug })).toContain('automation_set_mode');
  });

  it('auto task: re-enabling or changing the SOP binding is refused (→ set_mode card); same binding / manual task is fine', async () => {
    const wf = await makeWorkflow('confirmed');
    const wf2 = await makeWorkflow('confirmed');
    const a = await makeAuto({ workflowId: wf.id, mode: 'auto' });
    await prisma.automation.update({ where: { id: a.id }, data: { enabled: false } });
    const { call } = tools(chatSession.id);
    expect(await call('automation_upsert', { automation: a.id, enabled: true })).toContain('automation_set_mode');
    expect(await call('automation_upsert', { automation: a.id, workflow: wf2.slug })).toContain('automation_set_mode');
    expect(await call('automation_upsert', { automation: a.id, workflow: null })).toContain('automation_set_mode');
    let row = await prisma.automation.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.enabled).toBe(false);
    expect(row.workflowId).toBe(wf.id);
    // disabling, and re-sending the same binding, are fine
    expect(await call('automation_upsert', { automation: a.id, enabled: false, workflow: wf.slug })).toContain('已修改');
    // a manual task can be re-enabled / rebound directly
    const m = await makeAuto({ workflowId: wf.id });
    await prisma.automation.update({ where: { id: m.id }, data: { enabled: false } });
    expect(await call('automation_upsert', { automation: m.id, enabled: true, workflow: wf2.slug })).toContain('已修改');
    row = await prisma.automation.findUniqueOrThrow({ where: { id: m.id } });
    expect([row.enabled, row.workflowId]).toEqual([true, wf2.id]);
  });

  it('binds a SOP by name', async () => {
    const wf = await makeWorkflow('draft');
    const a = await makeAuto();
    expect(await tools(chatSession.id).call('automation_upsert', { automation: a.id, workflow: wf.name })).toContain('已修改');
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: a.id } })).workflowId).toBe(wf.id);
  });
});

describe('automation_link_history', () => {
  it('links sessions and reports duplicates / missing ones', async () => {
    const a = await makeAuto();
    const s = await makeSession();
    const { call } = tools(chatSession.id);
    const out = await call('automation_link_history', { automation: a.name, sessions: [{ session: s.slug }, { session: 'no-such-session' }] });
    expect(out).toContain('已登记');
    expect(out).toContain('找不到这个会话');
    expect(await call('automation_link_history', { automation: a.id, sessions: [{ session: s.id }] })).toContain('已存在，忽略');
    const runs = await prisma.automationRun.findMany({ where: { automationId: a.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'history', status: 'done', sessionId: s.id });
  });
});

describe('automation_set_mode', () => {
  it('manual takes effect directly (no card)', async () => {
    const wf = await makeWorkflow('confirmed');
    const a = await makeAuto({ workflowId: wf.id, mode: 'auto' });
    const spy = approve('approve');
    expect(await tools(chatSession.id).call('automation_set_mode', { automation: a.id, mode: 'manual' })).toContain('已改为手动');
    expect(spy).not.toHaveBeenCalled();
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: a.id } })).mode).toBe('manual');
  });

  it('auto without a confirmed SOP is refused before any card', async () => {
    const draft = await makeWorkflow('draft');
    const a = await makeAuto({ workflowId: draft.id });
    const spy = approve('approve');
    expect(await tools(chatSession.id).call('automation_set_mode', { automation: a.id, mode: 'auto' })).toContain('不能设成自动');
    expect(spy).not.toHaveBeenCalled();
  });

  it('auto: card (name, frequency, SOP, what happens) → approve sets auto + autoSince; reject changes nothing', async () => {
    const wf = await makeWorkflow('confirmed');
    const a = await makeAuto({ workflowId: wf.id });
    approve('reject', '先别');
    const { call } = tools(chatSession.id);
    expect(await call('automation_set_mode', { automation: a.id, mode: 'auto' })).toContain('用户没有同意（reject）：先别');
    expect((await prisma.automation.findUniqueOrThrow({ where: { id: a.id } })).mode).toBe('manual');
    expect(cardEvents[0]!.summary).toContain(`任务：「${a.name}」`);
    expect(cardEvents[0]!.summary).toContain('频率：每个工作日 10:00');
    expect(cardEvents[0]!.summary).toContain(`SOP：${wf.slug}（已确认`);
    expect(cardEvents[0]!.summary).toContain('将会：');

    vi.restoreAllMocks();
    approve('approve');
    const before = Date.now();
    expect(await call('automation_set_mode', { automation: a.id, mode: 'auto' })).toContain('已设成自动');
    const row = await prisma.automation.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.mode).toBe('auto');
    expect(row.autoSince!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe('automation_delete', () => {
  it('reject keeps the task; approve deletes it', async () => {
    const a = await makeAuto();
    const { call } = tools(chatSession.id);
    approve('reject');
    expect(await call('automation_delete', { automation: a.id })).toContain('没有做任何改动');
    expect(await prisma.automation.findUnique({ where: { id: a.id } })).not.toBeNull();
    vi.restoreAllMocks();
    approve('approve');
    expect(await call('automation_delete', { automation: a.id })).toContain('已删除');
    expect(await prisma.automation.findUnique({ where: { id: a.id } })).toBeNull();
  });
});

describe('automation_run_now', () => {
  it('approve starts a run in a new session; reject does not', async () => {
    const a = await makeAuto();
    const { call } = tools(chatSession.id);
    approve('reject');
    expect(await call('automation_run_now', { automation: a.id })).toContain('没有做任何改动');
    expect(await prisma.automationRun.count({ where: { automationId: a.id } })).toBe(0);
    vi.restoreAllMocks();
    approve('approve');
    expect(await call('automation_run_now', { automation: a.id })).toContain('已启动');
    const runs = await prisma.automationRun.findMany({ where: { automationId: a.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('manual');
    expect(runs[0]!.sessionId).not.toBe(chatSession.id);
  });

  it('loop guard: refused inside a run session of the same task (no card)', async () => {
    const a = await makeAuto();
    await prisma.automationRun.create({ data: { automationId: a.id, sessionId: chatSession.id, trigger: 'manual', status: 'running' } });
    const spy = approve('approve');
    expect(await tools(chatSession.id).call('automation_run_now', { automation: a.id })).toContain('会形成循环');
    expect(spy).not.toHaveBeenCalled();
  });

  it('loop guard ignores history links: this session linked as history → run_now allowed (card shown)', async () => {
    const a = await makeAuto();
    await prisma.automationRun.create({ data: { automationId: a.id, sessionId: chatSession.id, trigger: 'history', status: 'done', note: '历史会话' } });
    const spy = approve('reject');
    expect(await tools(chatSession.id).call('automation_run_now', { automation: a.id })).toContain('没有做任何改动');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cardEvents[0]!.summary).toContain('立即运行');
  });

  it('unknown task → hint to list', async () => {
    expect(await tools(chatSession.id).call('automation_run_now', { automation: '不存在的任务' })).toContain('automation_list');
  });
});

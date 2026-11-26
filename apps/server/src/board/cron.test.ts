import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowGraph } from '@chapi/shared';

vi.mock('../knowledge/recall.js', () => ({ recallBlock: vi.fn(async () => null) }));
vi.mock('../orchestrator/types.js', () => ({
  getOrchestrator: () => ({ handleUserMessage: vi.fn(async () => undefined), isActive: () => false }),
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
    createSession: async (input: { title?: string; model?: string; effort?: string; language?: string }) => {
      const s = await prisma.session.create({
        data: {
          slug: `cron-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title: input.title ?? 'x',
          titleSource: 'user',
          model: input.model ?? 'm',
          effort: input.effort ?? 'high',
          language: input.language ?? 'zh',
        },
      });
      createdSessions.push(s.id);
      return toSessionDTO(s);
    },
  };
});

const { prisma } = await import('../db/client.js');
const { bus } = await import('../gateway/bus.js');
const { __resetRunnerForTests } = await import('./runner.js');
const { boardCron } = await import('./cron.js');

const graph: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'start', title: '开始' },
    { id: 'a', type: 'step', title: '阶段 A', instructions: '做 A。', doneCriteria: ['A 已完成'], evidence: [{ key: 'file', type: 'path' }] },
    { id: 'end', type: 'end', title: '结束' },
  ],
  edges: [
    { from: 'start', to: 'a' },
    { from: 'a', to: 'end' },
  ],
};

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const H = 3600_000;
// 2026-11-24 18:00 PT == 2026-11-25 02:00 UTC (PST, UTC-8)
const DUE_1800 = new Date('2026-11-25T02:00:00Z');
const LONG_AGO = new Date('2026-10-01T00:00:00Z');

const automationIds: string[] = [];
const workflowIds: string[] = [];
const events: Array<{ type: string; [k: string]: unknown }> = [];
let offBus: (() => void) | null = null;

async function makeWorkflow(): Promise<string> {
  const slug = `wf-test-cron-${tag()}`;
  const w = await prisma.workflow.create({
    data: {
      slug,
      name: `测试 SOP ${slug}`,
      status: 'confirmed',
      confirmedVersion: 1,
      versions: { create: { version: 1, graph: graph as unknown as object, state: 'confirmed' } },
    },
  });
  workflowIds.push(w.id);
  return w.id;
}

async function makeAuto(data: {
  workflowId?: string | null;
  mode?: 'manual' | 'auto';
  schedule?: object;
  createdAt?: Date;
  autoSince?: Date | null;
  lastRunAt?: Date;
  name?: string;
}): Promise<string> {
  const a = await prisma.automation.create({
    data: {
      name: data.name ?? `cron 测试 ${tag()}`,
      workflowId: data.workflowId === undefined ? null : data.workflowId,
      prompt: data.workflowId ? null : 'do it',
      schedule: data.schedule ?? { kind: 'daily', time: '18:00' },
      mode: data.mode ?? 'auto',
      model: 'test-model',
      effort: 'medium',
      createdAt: data.createdAt ?? LONG_AGO,
      autoSince: data.autoSince === undefined ? LONG_AGO : data.autoSince,
      ...(data.lastRunAt ? { lastRunAt: data.lastRunAt } : {}),
    },
  });
  automationIds.push(a.id);
  return a.id;
}

const runsOf = (id: string) => prisma.automationRun.findMany({ where: { automationId: id }, orderBy: { startedAt: 'asc' } });

beforeEach(() => {
  __resetRunnerForTests();
  events.length = 0;
  offBus = bus.on((e) => {
    if (e.type === 'notification' || e.type === 'board.changed') events.push(e as never);
  });
});

afterEach(async () => {
  offBus?.();
  boardCron.stop();
  __resetRunnerForTests();
  await prisma.automation.deleteMany({ where: { id: { in: automationIds.splice(0) } } });
  await prisma.session.deleteMany({ where: { id: { in: createdSessions.splice(0) } } });
  await prisma.workflow.deleteMany({ where: { id: { in: workflowIds.splice(0) } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('boardCron.tick', () => {
  it('18:00:10 PT → 1 条 trigger=cron；再 tick 仍只有 1 条；nextRunAt 刷新为次日 18:00', async () => {
    const wf = await makeWorkflow();
    const id = await makeAuto({ workflowId: wf });
    const now = new Date(DUE_1800.getTime() + 10_000);
    await boardCron.tick(now);
    await boardCron.tick(new Date(now.getTime() + 30_000));
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('cron');
    expect(runs[0]!.dueAt?.getTime()).toBe(DUE_1800.getTime());
    const a = await prisma.automation.findUniqueOrThrow({ where: { id } });
    expect(a.nextRunAt?.getTime()).toBe(DUE_1800.getTime() + 24 * H);
  });

  it('启动时 lastDue 在 3 小时前且无记录 → catchup', async () => {
    const wf = await makeWorkflow();
    const id = await makeAuto({ workflowId: wf });
    await boardCron.tick(new Date(DUE_1800.getTime() + 3 * H));
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('catchup');
  });

  it('lastDue 在 30 小时前 → skipped，note「错过」，且不再重复', async () => {
    const wf = await makeWorkflow();
    // weekly Tue 18:00 PT; 2026-11-24 is a Tuesday
    const id = await makeAuto({ workflowId: wf, schedule: { kind: 'weekly', time: '18:00', weekdays: [2] } });
    const now = new Date(DUE_1800.getTime() + 30 * H);
    await boardCron.tick(now);
    await boardCron.tick(new Date(now.getTime() + 30_000));
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('skipped');
    expect(runs[0]!.note).toBe('错过');
    expect(runs[0]!.dueAt?.getTime()).toBe(DUE_1800.getTime());
  });

  it('mode=manual 的任务 → 不生成任何运行', async () => {
    const wf = await makeWorkflow();
    const id = await makeAuto({ workflowId: wf, mode: 'manual' });
    await boardCron.tick(new Date(DUE_1800.getTime() + 10_000));
    expect(await runsOf(id)).toHaveLength(0);
  });

  it('任务创建于到期时刻之后 → 不补跑那个时刻', async () => {
    const wf = await makeWorkflow();
    const id = await makeAuto({ workflowId: wf, createdAt: new Date(DUE_1800.getTime() + 1000) });
    await boardCron.tick(new Date(DUE_1800.getTime() + 10_000));
    expect(await runsOf(id)).toHaveLength(0);
  });

  it('18:00 档位在 19:00 才切到 auto → 不补跑；次日 18:00 正常 cron', async () => {
    const wf = await makeWorkflow();
    const switched = new Date(DUE_1800.getTime() + H);
    const id = await makeAuto({ workflowId: wf, autoSince: switched });
    await boardCron.tick(new Date(switched.getTime() + 10_000));
    expect(await runsOf(id)).toHaveLength(0);
    await boardCron.tick(new Date(DUE_1800.getTime() + 24 * H + 10_000));
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('cron');
  });

  it('18:30 已手动跑过 → 18:40 的 tick 不再补跑 18:00 档位', async () => {
    const wf = await makeWorkflow();
    const id = await makeAuto({ workflowId: wf, lastRunAt: new Date(DUE_1800.getTime() + 30 * 60_000) });
    await boardCron.tick(new Date(DUE_1800.getTime() + 40 * 60_000));
    expect(await runsOf(id)).toHaveLength(0);
  });

  it('18:30 链接了一条历史会话（trigger=history）→ 18:40 的 tick 不再补跑 18:00 档位', async () => {
    const { linkHistory } = await import('./service.js');
    const wf = await makeWorkflow();
    const id = await makeAuto({ workflowId: wf });
    const s = await prisma.session.create({
      data: { slug: `cron-hist-${tag()}`, title: '手动做过', titleSource: 'user', model: 'm', createdAt: new Date(DUE_1800.getTime() + 30 * 60_000) },
    });
    createdSessions.push(s.id);
    const r = await linkHistory(id, [{ session: s.id }]);
    expect(r.ok && r.value[0]!.result).toBe('linked');
    await boardCron.tick(new Date(DUE_1800.getTime() + 40 * 60_000));
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('history');
  });

  it('autoSince 为空的老 auto 任务 → 第一次 tick 只定基线、不触发', async () => {
    const wf = await makeWorkflow();
    const id = await makeAuto({ workflowId: wf, autoSince: null });
    const now = new Date(DUE_1800.getTime() + 3 * H);
    await boardCron.tick(now);
    expect(await runsOf(id)).toHaveLength(0);
    expect((await prisma.automation.findUniqueOrThrow({ where: { id } })).autoSince?.getTime()).toBe(now.getTime());
  });

  it('SOP archived → mode 变 manual，发出 notification，不运行', async () => {
    const wf = await makeWorkflow();
    const id = await makeAuto({ workflowId: wf, name: '归档测试任务' });
    await prisma.workflow.update({ where: { id: wf }, data: { status: 'archived' } });
    await boardCron.tick(new Date(DUE_1800.getTime() + 10_000));
    const a = await prisma.automation.findUniqueOrThrow({ where: { id } });
    expect(a.mode).toBe('manual');
    expect(await runsOf(id)).toHaveLength(0);
    const n = events.find((e) => e.type === 'notification');
    expect(n).toMatchObject({ title: '自动化已改回手动', body: '归档测试任务 的 SOP 已不可用，已改回手动' });
  });

  it('auto 但没有 SOP → 改回 manual', async () => {
    const id = await makeAuto({ workflowId: null });
    await boardCron.tick(new Date(DUE_1800.getTime() + 10_000));
    expect((await prisma.automation.findUniqueOrThrow({ where: { id } })).mode).toBe('manual');
  });

  it('坏的 schedule 不影响其他任务', async () => {
    const wf = await makeWorkflow();
    const bad = await makeAuto({ workflowId: wf, schedule: { kind: 'weekly', time: '18:00', weekdays: [] } });
    const good = await makeAuto({ workflowId: wf });
    await boardCron.tick(new Date(DUE_1800.getTime() + 10_000));
    expect(await runsOf(bad)).toHaveLength(0);
    expect(await runsOf(good)).toHaveLength(1);
  });
});

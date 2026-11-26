import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowGraph } from '@chapi/shared';

const recallBlock = vi.fn(async () => null as string | null);
vi.mock('../knowledge/recall.js', () => ({ recallBlock }));

const handleUserMessage = vi.fn(async (_sid: string, _text: string) => undefined);
const isActive = vi.fn((_sid: string) => false);
vi.mock('../orchestrator/types.js', () => ({
  getOrchestrator: () => ({ handleUserMessage, isActive }),
  setOrchestrator: () => undefined,
}));

const notifyMainAI = vi.fn((_sid: string, _text: string) => undefined);
vi.mock('../workflow/notify.js', () => ({ notifyMainAI }));

const createdSessions: string[] = [];
const createSessionImpl = vi.fn();
vi.mock('../services/sessions.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/sessions.js')>();
  return {
    ...orig,
    createSession: (input: { title?: string; model?: string; effort?: string; language?: string }) => createSessionImpl(input),
  };
});

const { prisma } = await import('../db/client.js');
const { bus } = await import('../gateway/bus.js');
const { toSessionDTO } = await import('../mappers.js');
const runner = await import('./runner.js');
const { runAutomation, syncRunStatus, drainQueue, startRunnerListeners, __resetRunnerForTests } = runner;
const { workflowEngine } = await import('../workflow/engine.js');

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
const NOW = new Date('2026-11-24T20:00:00Z'); // 12:00 PT, 11/24
const H = 3600_000;

const automationIds: string[] = [];
const workflowIds: string[] = [];
const projectIds: string[] = [];
const events: Array<{ type: string; [k: string]: unknown }> = [];
let offBus: (() => void) | null = null;

async function makeWorkflow(status: 'draft' | 'confirmed' = 'confirmed'): Promise<{ id: string; slug: string }> {
  const slug = `wf-test-runner-${tag()}`;
  const w = await prisma.workflow.create({
    data: {
      slug,
      name: `测试 SOP ${slug}`,
      status,
      confirmedVersion: status === 'confirmed' ? 1 : null,
      versions: { create: { version: 1, graph: graph as unknown as object, state: status === 'confirmed' ? 'confirmed' : 'draft' } },
    },
  });
  workflowIds.push(w.id);
  return { id: w.id, slug };
}

async function makeAutomation(data: {
  name?: string;
  workflowId?: string | null;
  prompt?: string | null;
  mode?: 'manual' | 'auto';
  projectId?: string | null;
  inputs?: Record<string, string>;
}): Promise<string> {
  const a = await prisma.automation.create({
    data: {
      name: data.name ?? `测试任务 ${tag()}`,
      workflowId: data.workflowId ?? null,
      prompt: data.prompt ?? null,
      schedule: { kind: 'daily', time: '18:00' },
      mode: data.mode ?? 'manual',
      model: 'test-model',
      effort: 'medium',
      projectId: data.projectId ?? null,
      inputs: data.inputs ?? undefined,
    },
  });
  automationIds.push(a.id);
  return a.id;
}

const getRun = (id: string) => prisma.automationRun.findUniqueOrThrow({ where: { id } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  __resetRunnerForTests();
  handleUserMessage.mockClear();
  notifyMainAI.mockClear();
  isActive.mockReset();
  isActive.mockImplementation(() => false);
  createSessionImpl.mockReset();
  createSessionImpl.mockImplementation(async (input: { title?: string; model?: string; effort?: string; language?: string }) => {
    const s = await prisma.session.create({
      data: {
        slug: `runner-test-${tag()}`,
        title: input.title ?? 'x',
        titleSource: 'user',
        model: input.model ?? 'm',
        effort: input.effort ?? 'high',
        language: input.language ?? 'zh',
      },
    });
    createdSessions.push(s.id);
    return toSessionDTO(s);
  });
  events.length = 0;
  offBus = bus.on((e) => {
    if (e.type === 'notification' || e.type === 'board.changed') events.push(e as never);
  });
});

afterEach(async () => {
  vi.useRealTimers();
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

describe('runAutomation', () => {
  it('manual 无 SOP → 新会话标题「EOD 每日总结 · 11/24」、handleUserMessage 收到 prompt、run.status=running', async () => {
    const p = await prisma.project.create({ data: { name: `测试项目 ${tag()}` } });
    projectIds.push(p.id);
    const id = await makeAutomation({ name: 'EOD 每日总结', prompt: '写今天的 EOD 邮件', projectId: p.id });
    const r = await runAutomation(id, { trigger: 'manual' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe('running');
    expect(r.run.trigger).toBe('manual');
    const s = await prisma.session.findUniqueOrThrow({ where: { id: r.run.sessionId! } });
    expect(s.title).toBe('EOD 每日总结 · 11/24');
    expect(s.language).toBe('zh');
    expect(s.model).toBe('test-model');
    expect(s.effort).toBe('medium');
    expect(s.projectId).toBe(p.id);
    expect(s.projectSource).toBe('user');
    expect(handleUserMessage).toHaveBeenCalledWith(s.id, '写今天的 EOD 邮件');
    const a = await prisma.automation.findUniqueOrThrow({ where: { id } });
    expect(a.lastSessionId).toBe(s.id);
    expect(a.lastStatus).toBe('running');
    expect(a.lastRunAt?.getTime()).toBe(NOW.getTime());
  });

  it('有 SOP → WorkflowRun.trigger=manual、AutomationRun.workflowRunId 已填', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, inputs: { day: '{today}' } });
    const r = await runAutomation(id, { trigger: 'manual' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.workflowRunId).toBeTruthy();
    expect(r.run.workflowVersion).toBe(1);
    const wr = await prisma.workflowRun.findUniqueOrThrow({ where: { id: r.run.workflowRunId! } });
    expect(wr.trigger).toBe('manual');
    expect(wr.sessionId).toBe(r.run.sessionId);
    expect(wr.inputs).toEqual({ day: '2026-11-24' });
    expect(notifyMainAI).toHaveBeenCalledTimes(1);
    expect(notifyMainAI.mock.calls[0]![1]).toContain('用户已启动');
    expect(handleUserMessage).not.toHaveBeenCalled();
  });

  it('cron 有 SOP → WorkflowRun.trigger=cron，通知主 AI「定时任务已启动」', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const r = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wr = await prisma.workflowRun.findUniqueOrThrow({ where: { id: r.run.workflowRunId! } });
    expect(wr.trigger).toBe('cron');
    expect(notifyMainAI.mock.calls[0]![1]).toContain('定时任务已启动');
  });

  it('已有 running 实例时再 manual → ok:false，error 含「上次还没完成」，runId 指向旧运行', async () => {
    const id = await makeAutomation({ prompt: 'do it' });
    const first = await runAutomation(id, { trigger: 'manual' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await runAutomation(id, { trigger: 'manual' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain('上次还没完成');
    expect(second.runId).toBe(first.run.id);
    expect(await prisma.automationRun.count({ where: { automationId: id } })).toBe(1);
  });

  it('cron 到点时上次还在跑 → 记一条 skipped，note「上次还没完成」', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const first = await runAutomation(id, { trigger: 'manual' });
    expect(first.ok).toBe(true);
    const due = new Date(NOW.getTime() - 60_000);
    const r = await runAutomation(id, { trigger: 'cron', dueAt: due });
    expect(r.ok).toBe(false);
    const skipped = await prisma.automationRun.findFirstOrThrow({ where: { automationId: id, dueAt: due } });
    expect(skipped.status).toBe('skipped');
    expect(skipped.note).toContain('上次还没完成');
  });

  it('同 dueAt 并发两次 cron → 只有 1 条 AutomationRun', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const due = new Date(NOW.getTime() - 60_000);
    const [a, b] = await Promise.all([
      runAutomation(id, { trigger: 'cron', dueAt: due }),
      runAutomation(id, { trigger: 'cron', dueAt: due }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await prisma.automationRun.count({ where: { automationId: id } })).toBe(1);
    expect(createSessionImpl).toHaveBeenCalledTimes(1);
    const again = await runAutomation(id, { trigger: 'catchup', dueAt: due });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain('该时刻已处理');
  });

  it('已有 2 个 cron running → 第 3 个为 queued；其中一个 done 后 drainQueue → 第 3 个变 running', async () => {
    const w = await makeWorkflow();
    const ids = [await makeAutomation({ workflowId: w.id, mode: 'auto' }), await makeAutomation({ workflowId: w.id, mode: 'auto' }), await makeAutomation({ workflowId: w.id, mode: 'auto' })];
    const due = new Date(NOW.getTime() - 60_000);
    const r1 = await runAutomation(ids[0]!, { trigger: 'cron', dueAt: due });
    const r2 = await runAutomation(ids[1]!, { trigger: 'cron', dueAt: due });
    const r3 = await runAutomation(ids[2]!, { trigger: 'cron', dueAt: due });
    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('expected ok');
    expect(r1.run.status).toBe('running');
    expect(r2.run.status).toBe('running');
    expect(r3.run.status).toBe('queued');
    expect(r3.run.sessionId).toBeNull();
    // A manual run neither counts toward nor waits on the cap.
    const m = await makeAutomation({ prompt: 'manual one' });
    const rm = await runAutomation(m, { trigger: 'manual' });
    expect(rm.ok && rm.run.status).toBe('running');

    await prisma.workflowRun.update({ where: { id: r1.run.workflowRunId! }, data: { status: 'done' } });
    await syncRunStatus(r1.run.id);
    expect((await getRun(r1.run.id)).status).toBe('done');
    await drainQueue();
    const third = await getRun(r3.run.id);
    expect(third.status).toBe('running');
    expect(third.sessionId).toBeTruthy();
    expect(third.workflowRunId).toBeTruthy();
  });

  it('queued 超过 24h 出队 → skipped，note「错过」', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const row = await prisma.automationRun.create({
      data: { automationId: id, trigger: 'cron', status: 'queued', dueAt: new Date(NOW.getTime() - 25 * H), startedAt: new Date(NOW.getTime() - 25 * H) },
    });
    await drainQueue();
    const r = await getRun(row.id);
    expect(r.status).toBe('skipped');
    expect(r.note).toContain('错过');
    expect(createSessionImpl).not.toHaveBeenCalled();
  });

  it('会话删除 → failed', async () => {
    const id = await makeAutomation({ prompt: 'do it' });
    const r = await runAutomation(id, { trigger: 'manual' });
    if (!r.ok) throw new Error(r.error);
    await prisma.session.delete({ where: { id: r.run.sessionId! } });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000)); // past the start grace
    await syncRunStatus(r.run.id);
    const row = await getRun(r.run.id);
    expect(row.status).toBe('failed');
    expect(row.note).toContain('会话已删除');
    expect(row.endedAt).toBeTruthy();
    // a failed run no longer blocks the next one
    const next = await runAutomation(id, { trigger: 'manual' });
    expect(next.ok).toBe(true);
  });

  it('会话软删除（session.updated deleted）→ 监听器把运行记为 failed', async () => {
    startRunnerListeners();
    const id = await makeAutomation({ prompt: 'do it' });
    const r = await runAutomation(id, { trigger: 'manual' });
    if (!r.ok) throw new Error(r.error);
    const s = await prisma.session.update({ where: { id: r.run.sessionId! }, data: { status: 'deleted' } });
    bus.emit({ type: 'session.updated', session: toSessionDTO(s) });
    await vi.waitFor(async () => expect((await getRun(r.run.id)).status).toBe('failed'), { timeout: 5000 });
    expect((await getRun(r.run.id)).note).toContain('会话已删除');
  });

  it('旧运行 waiting_user，新 cron 运行 → 旧运行 stale、新运行 running', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const old = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 24 * H) });
    if (!old.ok) throw new Error(old.error);
    await prisma.workflowRun.update({ where: { id: old.run.workflowRunId! }, data: { status: 'waiting_user' } });
    await syncRunStatus(old.run.id);
    expect((await getRun(old.run.id)).status).toBe('waiting_user');

    const fresh = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.run.status).toBe('running');
    expect((await getRun(old.run.id)).status).toBe('stale');
    // sync never revives a stale run, but lets it finish
    await prisma.workflowRun.update({ where: { id: old.run.workflowRunId! }, data: { status: 'running' } });
    await syncRunStatus(old.run.id);
    expect((await getRun(old.run.id)).status).toBe('stale');
    await prisma.workflowRun.update({ where: { id: old.run.workflowRunId! }, data: { status: 'done' } });
    await syncRunStatus(old.run.id);
    expect((await getRun(old.run.id)).status).toBe('done');
  });

  it('启动窗口里的 bus 事件不会把还没有会话的运行记成 failed', async () => {
    startRunnerListeners();
    const id = await makeAutomation({ prompt: 'do it' });
    createSessionImpl.mockImplementationOnce(async (input: { title?: string }) => {
      // The row is already `running` with sessionId=null; time has passed the grace.
      vi.setSystemTime(new Date(NOW.getTime() + 60_000));
      const row = await prisma.automationRun.findFirstOrThrow({ where: { automationId: id } });
      expect(row.status).toBe('running');
      expect(row.sessionId).toBeNull();
      bus.emit({ type: 'run.state', sessionId: 'unrelated-session', state: 'idle' });
      await syncRunStatus(row.id);
      await new Promise((res) => setTimeout(res, 200));
      expect((await getRun(row.id)).status).toBe('running');
      const s = await prisma.session.create({ data: { slug: `runner-test-${tag()}`, title: input.title ?? 'x', model: 'm' } });
      createdSessions.push(s.id);
      return toSessionDTO(s);
    });
    const r = await runAutomation(id, { trigger: 'manual' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe('running');
    expect(r.run.sessionId).toBeTruthy();
    expect(events.some((e) => e.type === 'notification')).toBe(false);
  });

  it('drainQueue 出队后、启动前的 bus 事件不会把运行记成 failed', async () => {
    startRunnerListeners();
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const row = await prisma.automationRun.create({
      data: { automationId: id, trigger: 'cron', status: 'queued', dueAt: new Date(NOW.getTime() - H), startedAt: new Date(NOW.getTime() - H) },
    });
    const delegate = prisma.automation as unknown as { findUnique: (...a: unknown[]) => unknown };
    const original = delegate.findUnique;
    const orig = original.bind(delegate) as typeof prisma.automation.findUnique;
    let poked = false;
    // (vi.spyOn + mockRestore breaks Prisma's model delegate — patch and put back by hand.)
    delegate.findUnique = ((args: Parameters<typeof orig>[0]) => {
      // drainQueue has just promoted the row to running (no session yet) and is loading the automation.
      return (async () => {
        if (!poked) {
          poked = true;
          vi.setSystemTime(new Date(NOW.getTime() + 60_000)); // past the start grace
          const r = await prisma.automationRun.findUniqueOrThrow({ where: { id: row.id } });
          expect(r.status).toBe('running');
          bus.emit({ type: 'run.state', sessionId: 'unrelated-session', state: 'idle' });
          await syncRunStatus(row.id);
          await new Promise((res) => setTimeout(res, 200));
        }
        return orig(args);
      })();
    }) as never;
    try {
      await drainQueue();
    } finally {
      delegate.findUnique = original;
    }
    expect(poked).toBe(true);
    const after = await getRun(row.id);
    expect(after.status).toBe('running');
    expect(after.sessionId).toBeTruthy();
    expect(events.some((e) => e.type === 'notification')).toBe(false);
  });

  it('SOP 一启动就 waiting_user → 启动后立刻同步，不用等巡检', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const orig = workflowEngine.start.bind(workflowEngine);
    const spy = vi.spyOn(workflowEngine, 'start').mockImplementation(async (sid, input) => {
      const res = await orig(sid, input);
      if (res.ok) {
        await prisma.workflowRun.update({ where: { id: res.run.id }, data: { status: 'waiting_user' } });
        bus.emit({ type: 'workflow.run.updated', sessionId: sid, run: { ...res.run, status: 'waiting_user' } });
      }
      return res;
    });
    try {
      const r = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.run.status).toBe('waiting_user');
      expect((await prisma.automation.findUniqueOrThrow({ where: { id } })).lastStatus).toBe('waiting_user');
    } finally {
      spy.mockRestore();
    }
  });

  it('等你处理的旧运行被并发同步拉回 running 时，不会出现两个在跑的实例', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const old = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 24 * H) });
    if (!old.ok) throw new Error(old.error);
    await prisma.workflowRun.update({ where: { id: old.run.workflowRunId! }, data: { status: 'waiting_user' } });
    await syncRunStatus(old.run.id);
    // The user answers: the old run is about to become running again while a new tick fires.
    await prisma.workflowRun.update({ where: { id: old.run.workflowRunId! }, data: { status: 'running' } });
    const [fresh] = await Promise.all([
      runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) }),
      syncRunStatus(old.run.id),
    ]);
    const live = await prisma.automationRun.count({ where: { automationId: id, status: { in: ['running', 'queued'] } } });
    expect(live).toBe(1);
    const oldRow = await getRun(old.run.id);
    if (fresh.ok) expect(oldRow.status).toBe('stale');
    else expect(oldRow.status).toBe('running');
  });

  it('mode=auto 但 SOP 是草稿 → ok:false', async () => {
    const w = await makeWorkflow('draft');
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const r = await runAutomation(id, { trigger: 'manual' });
    expect(r.ok).toBe(false);
    const c = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) });
    expect(c.ok).toBe(false);
    expect(createSessionImpl).not.toHaveBeenCalled();
    // the cron slot is recorded as failed (handled) and the user is told
    const rows = await prisma.automationRun.findMany({ where: { automationId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(events.some((e) => e.type === 'notification' && e.title === '自动化运行失败')).toBe(true);
  });

  it('cron 不能跑没有 SOP 的任务', async () => {
    const id = await makeAutomation({ prompt: 'only manual' });
    const r = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) });
    expect(r.ok).toBe(false);
    expect(createSessionImpl).not.toHaveBeenCalled();
  });

  it('启动失败（createSession 抛错）→ failed + notification', async () => {
    createSessionImpl.mockRejectedValueOnce(new Error('disk full'));
    const id = await makeAutomation({ prompt: 'do it' });
    const r = await runAutomation(id, { trigger: 'manual' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const row = await getRun(r.runId!);
    expect(row.status).toBe('failed');
    expect(row.note).toContain('disk full');
    expect(events.some((e) => e.type === 'notification' && e.level === 'error' && e.title === '自动化运行失败')).toBe(true);
  });
});

describe('syncRunStatus（有 SOP，主 AI 回合结束）', () => {
  it('SOP 中途回合结束（running → idle）→ waiting_user、腾出名额；回合恢复 → 回到 running', async () => {
    startRunnerListeners();
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const r = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) });
    if (!r.ok) throw new Error(r.error);
    const sid = r.run.sessionId!;
    await syncRunStatus(r.run.id);
    expect((await getRun(r.run.id)).status).toBe('running'); // initial idle is not the end

    // Real orchestrator: the session's Run stays registered across turns → isActive stays true.
    isActive.mockImplementation((s: string) => s === sid);
    bus.emit({ type: 'run.state', sessionId: sid, state: 'running' });
    await syncRunStatus(r.run.id);
    expect((await getRun(r.run.id)).status).toBe('running');

    // the main agent's turn ends mid-SOP with a plain-text question (no HITL row)
    bus.emit({ type: 'run.state', sessionId: sid, state: 'idle' });
    await vi.waitFor(async () => expect((await getRun(r.run.id)).status).toBe('waiting_user'), { timeout: 5000 });
    expect(await prisma.automationRun.count({ where: { id: r.run.id, status: 'running' } })).toBe(0);

    // the user replies → the turn resumes → running again
    bus.emit({ type: 'run.state', sessionId: sid, state: 'running' });
    await vi.waitFor(async () => expect((await getRun(r.run.id)).status).toBe('running'), { timeout: 5000 });
  });

  it('正常多轮（running → idle → 用户回复 → running …）每个回合边界只变一次状态', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const r = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) });
    if (!r.ok) throw new Error(r.error);
    const sid = r.run.sessionId!;
    const wr = await prisma.workflowRun.findUniqueOrThrow({ where: { id: r.run.workflowRunId! } });
    isActive.mockImplementation((s: string) => s === sid); // stays true for the whole test
    startRunnerListeners();
    // every status transition that landed is logged by the runner as "automation run <id>: a → b"
    const spy = vi.spyOn(console, 'info');
    const writes = () =>
      spy.mock.calls
        .map((c) => String(c[1] ?? ''))
        .filter((m) => m.startsWith(`automation run ${r.run.id}:`))
        .map((m) => m.split('→')[1]!.trim().split(' ')[0]!);
    const seen: string[] = [(await getRun(r.run.id)).status];
    const settle = async (expected: string) => {
      await vi.waitFor(async () => expect((await getRun(r.run.id)).status).toBe(expected), { timeout: 5000 });
      // repeated events / syncs at the same boundary must not move it again
      bus.emit({ type: 'workflow.run.updated', sessionId: sid, run: { id: wr.id, status: 'running' } as never });
      await syncRunStatus(r.run.id);
      await syncRunStatus(r.run.id);
      const now = (await getRun(r.run.id)).status;
      expect(now).toBe(expected);
      if (seen[seen.length - 1] !== now) seen.push(now);
    };
    let moved: string[];
    try {
      for (let turn = 0; turn < 3; turn++) {
        bus.emit({ type: 'run.state', sessionId: sid, state: 'running' });
        await settle('running');
        bus.emit({ type: 'run.state', sessionId: sid, state: 'idle' });
        await settle('waiting_user');
      }
      moved = writes();
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(['running', 'waiting_user', 'running', 'waiting_user', 'running', 'waiting_user']);
    // exactly one transition per turn boundary (first boundary: already running, so none)
    expect(moved).toEqual(['waiting_user', 'running', 'waiting_user', 'running', 'waiting_user']);
    const row = await getRun(r.run.id);
    expect(row.endedAt).toBeNull(); // never terminal along the way
  });

  it('重启后没见过 running、闲置超过 10 分钟且编排器不活跃 → waiting_user（不再永远占着名额）', async () => {
    const w = await makeWorkflow();
    const id = await makeAutomation({ workflowId: w.id, mode: 'auto' });
    const r = await runAutomation(id, { trigger: 'cron', dueAt: new Date(NOW.getTime() - 60_000) });
    if (!r.ok) throw new Error(r.error);
    __resetRunnerForTests(); // "restart": in-memory sawRunning is gone
    await syncRunStatus(r.run.id);
    expect((await getRun(r.run.id)).status).toBe('running');
    isActive.mockImplementation(() => true);
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60_000));
    await syncRunStatus(r.run.id);
    expect((await getRun(r.run.id)).status).toBe('running'); // orchestrator still busy
    isActive.mockImplementation(() => false);
    await syncRunStatus(r.run.id);
    expect((await getRun(r.run.id)).status).toBe('waiting_user');
  });

  it('没有固定项目的任务 → 会话 projectSource 保持 ai', async () => {
    const id = await makeAutomation({ prompt: 'do it' });
    const r = await runAutomation(id, { trigger: 'manual' });
    if (!r.ok) throw new Error(r.error);
    const s = await prisma.session.findUniqueOrThrow({ where: { id: r.run.sessionId! } });
    expect(s.projectId).toBeNull();
    expect(s.projectSource).toBe('ai');
  });
});

describe('syncRunStatus（无 SOP）', () => {
  it('初始 idle 不算完成；running → idle 且没有待答提问 → done', async () => {
    startRunnerListeners();
    const id = await makeAutomation({ prompt: 'do it' });
    const r = await runAutomation(id, { trigger: 'manual' });
    if (!r.ok) throw new Error(r.error);
    const sid = r.run.sessionId!;
    await syncRunStatus(r.run.id);
    expect((await getRun(r.run.id)).status).toBe('running');

    isActive.mockImplementation((s: string) => s === sid); // the orchestrator now has a live run
    bus.emit({ type: 'run.state', sessionId: sid, state: 'running' });
    const q = await prisma.pendingQuestion.create({ data: { sessionId: sid, question: '选哪个？' } });
    bus.emit({ type: 'run.state', sessionId: sid, state: 'idle' });
    await vi.waitFor(async () => expect((await getRun(r.run.id)).status).toBe('waiting_user'), { timeout: 5000 });

    await prisma.pendingQuestion.update({ where: { id: q.id }, data: { status: 'answered' } });
    bus.emit({ type: 'question.closed', sessionId: sid, questionId: q.id });
    await vi.waitFor(async () => expect((await getRun(r.run.id)).status).toBe('done'), { timeout: 5000 });
    const row = await getRun(r.run.id);
    expect(row.endedAt).toBeTruthy();
    // terminal never moves back
    bus.emit({ type: 'run.state', sessionId: sid, state: 'running' });
    await syncRunStatus(r.run.id);
    expect((await getRun(r.run.id)).status).toBe('done');
    expect((await prisma.automation.findUniqueOrThrow({ where: { id } })).lastStatus).toBe('done');
  });

  it('状态变化后防抖发出 board.changed', async () => {
    vi.useRealTimers();
    const id = await makeAutomation({ prompt: 'do it' });
    await runAutomation(id, { trigger: 'manual' });
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'board.changed')).toHaveLength(1), { timeout: 3000 });
  });
});

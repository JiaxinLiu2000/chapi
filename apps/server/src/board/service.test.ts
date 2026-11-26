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
        data: { slug: `svc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: input.title ?? 'x', titleSource: 'user', model: 'm' },
      });
      createdSessions.push(s.id);
      return toSessionDTO(s);
    },
  };
});

const { prisma } = await import('../db/client.js');
const { __resetRunnerForTests, runAutomation } = await import('./runner.js');
const { automationDTOs, createAutomation, linkHistory, updateAutomation, findAutomation } = await import('./service.js');
const { getBoardToday } = await import('./today.js');

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const automationIds: string[] = [];

async function makeAuto(name?: string): Promise<string> {
  const a = await prisma.automation.create({
    data: { name: name ?? `svc 测试 ${tag()}`, prompt: 'do it', schedule: { kind: 'daily', time: '09:00' }, mode: 'manual', model: 'm', effort: 'high' },
  });
  automationIds.push(a.id);
  return a.id;
}

async function makeSession(createdAt: Date, msgs: Date[] = []) {
  const s = await prisma.session.create({
    data: { slug: `svc-hist-${tag()}`, title: '历史任务会话', titleSource: 'user', model: 'm', createdAt, updatedAt: createdAt },
  });
  createdSessions.push(s.id);
  for (const at of msgs) {
    await prisma.message.create({ data: { sessionId: s.id, role: 'user', type: 'text', content: [], text: 'go', createdAt: at } });
  }
  await prisma.$executeRaw`UPDATE \`Session\` SET updatedAt = ${createdAt} WHERE id = ${s.id}`;
  return s;
}

beforeEach(() => __resetRunnerForTests());
afterEach(async () => {
  __resetRunnerForTests();
  await prisma.automation.deleteMany({ where: { id: { in: automationIds.splice(0) } } });
  await prisma.session.deleteMany({ where: { id: { in: createdSessions.splice(0) } } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('linkHistory', () => {
  it('writes a done history row (startedAt = session createdAt), refreshes lastRunAt / lastSessionId, ignores duplicates', async () => {
    const id = await makeAuto();
    const older = await makeSession(new Date('2026-11-04T18:00:00Z'));
    const newer = await makeSession(new Date('2026-11-18T18:00:00Z'));
    const r = await linkHistory(id, [{ session: older.slug }, { session: newer.id }, { session: 'nope-missing' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((o) => o.result)).toEqual(['linked', 'linked', 'skipped']);
    expect(r.value[2]!.reason).toBe('找不到这个会话');

    const runs = await prisma.automationRun.findMany({ where: { automationId: id }, orderBy: { startedAt: 'asc' } });
    expect(runs.map((x) => [x.trigger, x.status, x.note, x.dueAt])).toEqual([
      ['history', 'done', '历史会话', null],
      ['history', 'done', '历史会话', null],
    ]);
    expect(runs[0]!.startedAt.toISOString()).toBe('2026-11-04T18:00:00.000Z');

    const a = await prisma.automation.findUniqueOrThrow({ where: { id } });
    expect(a.lastRunAt?.toISOString()).toBe('2026-11-18T18:00:00.000Z');
    expect(a.lastSessionId).toBe(newer.id);
    expect(a.lastStatus).toBe('done');

    const again = await linkHistory(id, [{ session: newer.id }]);
    expect(again.ok && again.value[0]!.result).toBe('duplicate');
    expect(await prisma.automationRun.count({ where: { automationId: id } })).toBe(2);
  });

  it('with date: one session reused on several days → one row per day at the first user message that PT day', async () => {
    const id = await makeAuto();
    // 11/4 09:49 PT, 11/5 10:04 PT (and a later message on 11/5)
    const s = await makeSession(new Date('2026-10-27T19:04:00Z'), [
      new Date('2026-11-04T17:49:00Z'),
      new Date('2026-11-05T18:04:00Z'),
      new Date('2026-11-05T22:00:00Z'),
    ]);
    const r = await linkHistory(id, [
      { session: s.id, date: '2026-11-04' },
      { session: s.id, date: '2026-11-05' },
      { session: s.id, date: '2026-11-05' },
      { session: s.id, date: '2026-11-06' },
    ]);
    expect(r.ok && r.value.map((o) => o.result)).toEqual(['linked', 'linked', 'duplicate', 'skipped']);
    const a = await prisma.automation.findUniqueOrThrow({ where: { id } });
    expect(a.lastRunAt?.toISOString()).toBe('2026-11-05T18:04:00.000Z');
  });

  it('dryRun reports the same outcomes without writing', async () => {
    const id = await makeAuto();
    const s = await makeSession(new Date('2026-11-18T18:00:00Z'));
    const r = await linkHistory(id, [{ session: s.id }, { session: s.slug }, { session: 'nope' }], { dryRun: true });
    expect(r.ok && r.value.map((o) => o.result)).toEqual(['linked', 'duplicate', 'skipped']);
    expect(await prisma.automationRun.count({ where: { automationId: id } })).toBe(0);
    expect((await prisma.automation.findUniqueOrThrow({ where: { id } })).lastRunAt).toBeNull();
  });

  it('404 for an unknown automation', async () => {
    const r = await linkHistory('missing-automation', []);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});

describe('no-SOP prompt placeholders', () => {
  it('the first message of a prompt run has {prevWorkday} etc. rendered in PT', async () => {
    const { renderTemplate } = await import('./schedule.js');
    const id = await makeAuto();
    await prisma.automation.update({ where: { id }, data: { prompt: '总结 {prevWorkday} 的工作（今天 {today}，本周 {weekStart}–{weekEnd}）' } });
    handleUserMessage.mockClear();
    const r = await runAutomation(id, { trigger: 'manual' });
    expect(r.ok).toBe(true);
    await vi.waitFor(() => expect(handleUserMessage).toHaveBeenCalledTimes(1));
    const sent = handleUserMessage.mock.calls[0]![1];
    expect(sent).not.toMatch(/\{(prevWorkday|today|weekStart|weekEnd)\}/);
    expect(sent).toMatch(/^总结 \d{4}-\d{2}-\d{2} 的工作（今天 \d{4}-\d{2}-\d{2}，本周 \d{4}-\d{2}-\d{2}–\d{4}-\d{2}-\d{2}）$/);
    expect(renderTemplate('{prevWorkday}/{MDYY}', new Date('2026-11-30T18:00:00Z'))).toBe('2026-11-27/11/30/26');
  });
});

describe('history runs are never open', () => {
  it('not in openRuns, shown as lastRun; a manual run is not refused as「上次还没完成」', async () => {
    const id = await makeAuto();
    const s = await makeSession(new Date('2026-11-18T18:00:00Z'));
    await linkHistory(id, [{ session: s.id }]);
    const [dto] = await automationDTOs({ id });
    expect(dto!.openRuns).toHaveLength(0);
    expect(dto!.lastRun).toMatchObject({ trigger: 'history', status: 'done', sessionSlug: s.slug });

    const r = await runAutomation(id, { trigger: 'manual' });
    expect(r.ok).toBe(true);
  });

  it('a linked old session does not show in today', async () => {
    const id = await makeAuto();
    const s = await makeSession(new Date('2026-10-01T18:00:00Z'));
    await linkHistory(id, [{ session: s.id }]);
    const t = await getBoardToday();
    const all = [...t.running, ...t.waiting, ...t.done].map((c) => c.id);
    expect(all).not.toContain(s.id);
  });
});

describe('service create / update', () => {
  it('accepts monthly daysOfMonth and finds by name', async () => {
    const name = `svc 月度 ${tag()}`.slice(0, 60);
    const r = await createAutomation({ name, prompt: 'x', schedule: { kind: 'monthly', time: '09:00', daysOfMonth: [25, 10] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    automationIds.push(r.value.id);
    expect(r.value.schedule).toEqual({ kind: 'monthly', time: '09:00', daysOfMonth: [10, 25] });
    expect((await findAutomation(name))?.id).toBe(r.value.id);
    expect((await findAutomation(r.value.id))?.name).toBe(name);
    const u = await updateAutomation(r.value.id, { mode: 'auto' });
    expect(u).toMatchObject({ ok: false, status: 409 });
  });
});

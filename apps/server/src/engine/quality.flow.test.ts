import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const row = { id: 'run-2', sessionId: 's-f', name: '质检', status: 'idle', scheduledFor: null as Date | null, title: '' };
const injectAdvice = vi.fn(async (_sessionId: string, _text: string) => undefined);
vi.mock('../db/client.js', () => ({
  prisma: {
    agentRun: {
      findFirst: vi.fn(async () => ({ ...row })),
      create: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data) && { ...row }),
    },
    session: { findUnique: vi.fn(async () => ({ id: 's-f', status: 'active', qualityReviewMinutes: 10, accountMode: 'auto' })) },
    message: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'm', ...data })),
      findFirst: vi.fn(async () => null),
    },
  },
}));
vi.mock('../mappers.js', () => ({ toAgentRunDTO: (r: unknown) => r, toMessageDTO: (m: unknown) => m, toSessionDTO: (s: unknown) => s }));
vi.mock('../orchestrator/types.js', () => ({ getOrchestrator: () => ({ injectAdvice }) }));
vi.mock('../knowledge/recall.js', () => ({ recallBlock: async () => null }));

const { bus } = await import('../gateway/bus.js');
const { agentInbox } = await import('./inbox.js');
const { qualityAdvisor, MAX_GATE_BLOCKS } = await import('./quality.js');

type Priv = {
  collect: (...a: unknown[]) => Promise<unknown>;
  ask: (...a: unknown[]) => Promise<unknown>;
};
const priv = qualityAdvisor as unknown as Priv;
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const fakeData = () => ({
  session: { id: 's-f', accountMode: 'auto' },
  plan: [],
  digest: 'd',
  model: 'm',
  reviewStart: new Date(),
  newMsgs: 1,
  newTools: 1,
});
const note = (severity: string, title: string) => ({ id: title, severity, title, note: `${title} 说明` });

describe('pre-delivery gate', () => {
  beforeEach(async () => {
    qualityAdvisor.stop('s-f');
    await qualityAdvisor.configure('s-f', 10);
    vi.spyOn(priv, 'collect').mockResolvedValue(fakeData());
  });
  afterEach(() => vi.restoreAllMocks());

  it(`sends a failing deliverable back ${MAX_GATE_BLOCKS} times, then lets it through with the notes`, async () => {
    vi.spyOn(priv, 'ask').mockResolvedValue({ score: 40, summary: '只做了抽样', notes: [note('blocker', '只抽样就声称全部完成')] });
    for (let i = 1; i <= MAX_GATE_BLOCKS; i++) {
      const g = await qualityAdvisor.gate('s-f', '全部 40 行已更新', []);
      expect(g.block).toBe(true);
      expect(g.agentText).toContain(`第 ${i}/${MAX_GATE_BLOCKS} 次`);
    }
    const last = await qualityAdvisor.gate('s-f', '全部 40 行已更新', []);
    expect(last.block).toBe(false);
    expect(last.userNote).toContain('只抽样就声称全部完成');
  });

  it('passes a good deliverable and resets the counter', async () => {
    vi.spyOn(priv, 'ask')
      .mockResolvedValueOnce({ score: 30, summary: 'x', notes: [] })
      .mockResolvedValueOnce({ score: 92, summary: '核对无误', notes: [note('nit', '标题可以更短')] });
    expect((await qualityAdvisor.gate('s-f', 'a', [])).block).toBe(true); // low score alone blocks
    const ok = await qualityAdvisor.gate('s-f', 'a', []);
    expect(ok).toEqual({ block: false, userNote: undefined });
  });

  it('times out open / passes when the advisor gives no verdict', async () => {
    vi.spyOn(priv, 'ask').mockResolvedValue(null);
    expect((await qualityAdvisor.gate('s-f', 'a', [])).block).toBe(false);
  });
});

describe('turn-end hand-over and loop guard', () => {
  beforeEach(async () => {
    injectAdvice.mockClear();
    qualityAdvisor.stop('s-f');
    await qualityAdvisor.configure('s-f', 10);
    vi.spyOn(priv, 'collect').mockResolvedValue(fakeData());
  });
  afterEach(() => vi.restoreAllMocks());

  it('a concern found mid-turn waits, is handed over once at turn end, and that follow-up turn is not reviewed', async () => {
    bus.emit({ type: 'run.state', sessionId: 's-f', state: 'running' });
    await flush();
    vi.spyOn(priv, 'ask').mockResolvedValue({ score: 70, summary: 's', notes: [note('concern', '数字没有来源')] });
    await qualityAdvisor.review('s-f');
    expect(injectAdvice).not.toHaveBeenCalled(); // no interruption for a concern

    bus.emit({ type: 'run.state', sessionId: 's-f', state: 'idle' });
    await flush();
    expect(injectAdvice).toHaveBeenCalledTimes(1);
    expect(String(injectAdvice.mock.calls[0]![1])).toContain('数字没有来源');

    // The follow-up turn runs: the advisor's clock stays paused.
    bus.emit({ type: 'run.state', sessionId: 's-f', state: 'running' });
    await flush();
    expect(qualityAdvisor.working('s-f')).toBe(false);
    expect(row.title).toContain('主代理在处理质检意见');

    // A real user message gives the clock back.
    qualityAdvisor.onUserMessage('s-f');
    await flush();
    expect(qualityAdvisor.working('s-f')).toBe(true);
    bus.emit({ type: 'run.state', sessionId: 's-f', state: 'idle' });
    await flush();
  });

  it('a blocker interrupts immediately; after a user interrupt concerns are only held', async () => {
    bus.emit({ type: 'run.state', sessionId: 's-f', state: 'running' });
    await flush();
    vi.spyOn(priv, 'ask').mockResolvedValue({ score: 20, summary: 's', notes: [note('blocker', '写错了表')] });
    await qualityAdvisor.review('s-f');
    expect(injectAdvice).toHaveBeenCalledTimes(1);

    injectAdvice.mockClear();
    vi.spyOn(priv, 'ask').mockResolvedValue({ score: 70, summary: 's', notes: [note('concern', '另一个新问题')] });
    await qualityAdvisor.review('s-f', true);
    const deliver = vi.spyOn(agentInbox, 'deliver');
    qualityAdvisor.noteInterrupt('s-f');
    bus.emit({ type: 'run.state', sessionId: 's-f', state: 'idle' });
    await flush();
    expect(injectAdvice).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith('s-f', expect.stringContaining('另一个新问题'), 'next');
  });
});

describe('rule-based stuck detection', () => {
  beforeEach(async () => {
    injectAdvice.mockClear();
    qualityAdvisor.stop('s-f');
    await qualityAdvisor.configure('s-f', 10);
  });

  it('reports the same call four times in a row once, as a blocker, without a model call', async () => {
    const ask = vi.spyOn(priv, 'ask');
    bus.emit({ type: 'run.state', sessionId: 's-f', state: 'running' });
    for (let i = 0; i < 6; i++) {
      bus.emit({
        type: 'tool.started',
        sessionId: 's-f',
        toolCall: {
          id: `c${i}`,
          sessionId: 's-f',
          agentRunId: null,
          toolName: 'Bash',
          inputPreview: 'curl https://x/status',
          outputPreview: null,
          status: 'running',
          durationMs: null,
          createdAt: new Date().toISOString(),
        },
      });
    }
    await flush();
    expect(ask).not.toHaveBeenCalled();
    expect(injectAdvice).toHaveBeenCalledTimes(1);
    expect(String(injectAdvice.mock.calls[0]![1])).toContain('疑似卡住');
    bus.emit({ type: 'run.state', sessionId: 's-f', state: 'idle' });
    await flush();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the 质检 monitor row.
const row = { id: 'run-1', sessionId: 's-q', name: '质检', status: 'idle', scheduledFor: null as Date | null, title: '' };
vi.mock('../db/client.js', () => ({
  prisma: {
    agentRun: {
      findFirst: vi.fn(async () => ({ ...row })),
      create: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data) && { ...row }),
    },
    session: { findUnique: vi.fn(async () => ({ id: 's-q', status: 'active' })) },
  },
}));
vi.mock('../mappers.js', () => ({ toAgentRunDTO: (r: unknown) => r, toMessageDTO: (m: unknown) => m, toSessionDTO: (s: unknown) => s }));

const { bus } = await import('../gateway/bus.js');
const { hitl } = await import('./hitl.js');
const { qualityAdvisor } = await import('./quality.js');

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('quality advisor pauses while the main agent is not working', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    qualityAdvisor.stop('s-q');
    vi.useRealTimers();
  });

  it('starts paused when idle, runs while working, pauses on approval wait and turn end', async () => {
    await qualityAdvisor.configure('s-q', 10);
    expect(row.status).toBe('idle');
    expect(row.title).toContain('已暂停');

    bus.emit({ type: 'run.state', sessionId: 's-q', state: 'running' });
    await flush();
    expect(qualityAdvisor.working('s-q')).toBe(true);
    expect(row.status).toBe('scheduled');

    // 3 minutes of work, then a deliverable is submitted and waits for approval.
    vi.advanceTimersByTime(3 * 60_000);
    const pending = hitl.waitForApproval('ap-q', 's-q');
    await flush();
    expect(qualityAdvisor.working('s-q')).toBe(false);
    expect(row.status).toBe('idle');
    expect(row.scheduledFor).toBeNull();
    expect(row.title).toContain('等待你的回复或审批');

    // A long wait must not count: an hour passes, nothing fires.
    const reviewSpy = vi.spyOn(qualityAdvisor, 'review');
    vi.advanceTimersByTime(60 * 60_000);
    await flush();
    expect(reviewSpy).not.toHaveBeenCalled();

    // User approves → work resumes with the ~7 minutes that were left.
    hitl.resolveApproval('ap-q', { decision: 'revise' });
    await pending;
    await flush();
    expect(row.status).toBe('scheduled');
    const left = row.scheduledFor!.getTime() - Date.now();
    expect(left).toBeGreaterThan(6.9 * 60_000);
    expect(left).toBeLessThanOrEqual(7 * 60_000);

    // Turn ends → paused again.
    bus.emit({ type: 'run.state', sessionId: 's-q', state: 'idle' });
    await flush();
    expect(row.status).toBe('idle');
    expect(row.title).toContain('主代理未在工作');
    reviewSpy.mockRestore();
  });
});

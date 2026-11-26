import { describe, expect, it } from 'vitest';
import { hitl } from './hitl.js';
import { buildChapiToolServer } from './tools/chapiTools.js';

describe('hitl registry', () => {
  it('resolves a pending question once', async () => {
    const pending = hitl.waitForQuestion('q-1');
    expect(hitl.resolveQuestion('q-1', 'my answer')).toBe(true);
    expect(await pending).toBe('my answer');
    // already resolved/removed
    expect(hitl.resolveQuestion('q-1', 'again')).toBe(false);
  });

  it('resolves a pending approval with decision + feedback', async () => {
    const pending = hitl.waitForApproval('a-1');
    expect(hitl.resolveApproval('a-1', { decision: 'revise', feedback: 'tweak it' })).toBe(true);
    expect(await pending).toEqual({ decision: 'revise', feedback: 'tweak it' });
  });

  it('returns false for unknown ids', () => {
    expect(hitl.resolveQuestion('nope', 'x')).toBe(false);
    expect(hitl.resolveApproval('nope', { decision: 'approve' })).toBe(false);
  });
});

describe('chapi tool server', () => {
  it('builds without throwing (zod v3 + createSdkMcpServer)', () => {
    const server = buildChapiToolServer('session-x');
    expect(server).toBeTruthy();
    expect(server.type).toBe('sdk');
  });
});

describe('hitl wait tracking', () => {
  it('marks a session waiting while a question/approval is open', async () => {
    const seen: Array<[string, boolean]> = [];
    const off = hitl.onWaitChange((sid, w) => seen.push([sid, w]));
    const q = hitl.waitForQuestion('wq-1', 's-wait');
    expect(hitl.isWaiting('s-wait')).toBe(true);
    const a = hitl.waitForApproval('wa-1', 's-wait');
    hitl.resolveQuestion('wq-1', 'x');
    expect(hitl.isWaiting('s-wait')).toBe(true); // approval still open
    hitl.resolveApproval('wa-1', { decision: 'approve' });
    expect(hitl.isWaiting('s-wait')).toBe(false);
    await Promise.all([q, a]);
    expect(seen).toEqual([
      ['s-wait', true],
      ['s-wait', false],
    ]);
    off();
  });

  it('forgets waits when the turn ends (interrupted tool calls never pin the session)', async () => {
    const { bus } = await import('../gateway/bus.js');
    void hitl.waitForApproval('wa-2', 's-int');
    expect(hitl.isWaiting('s-int')).toBe(true);
    bus.emit({ type: 'run.state', sessionId: 's-int', state: 'idle' });
    expect(hitl.isWaiting('s-int')).toBe(false);
  });
});

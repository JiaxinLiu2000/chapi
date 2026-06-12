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

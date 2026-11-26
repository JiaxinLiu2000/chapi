import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db/client.js';
import { RunMonitor } from './monitoring.js';

/**
 * Seen 2026-11-23: a 33-day-old conversation reused its "main" agent row since its first
 * day; elapsed was computed from that startedAt (≈2.8e9 ms) and overflowed the INT column,
 * so finishing a run threw "Invalid prisma.agentRun.update() invocation".
 */
describe('RunMonitor — long-lived sessions', () => {
  let sessionId: string;
  const INT_MAX = 2_147_483_647;

  beforeEach(async () => {
    const s = await prisma.session.create({ data: { slug: `mon-long-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: 't', model: 'm' } });
    sessionId = s.id;
    await prisma.agentRun.create({
      data: {
        sessionId,
        name: 'main',
        status: 'idle',
        startedAt: new Date(Date.now() - 33 * 24 * 3600 * 1000),
        elapsedMs: 2_014_472_247,
      },
    });
  });
  afterEach(async () => {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
  });

  it('finishing a run on a month-old main row neither throws nor overflows elapsedMs', async () => {
    const m = new RunMonitor(sessionId);
    await m.ensureMainAgent('t');
    await expect(m.finishAll('done')).resolves.toBeUndefined();
    const row = await prisma.agentRun.findFirst({ where: { sessionId, name: 'main' } });
    expect(row!.elapsedMs).toBeLessThanOrEqual(INT_MAX);
    // active time keeps accumulating from what was recorded, not from the first day's startedAt
    expect(row!.elapsedMs).toBeGreaterThanOrEqual(2_014_472_247);
    expect(row!.elapsedMs).toBeLessThan(2_014_472_247 + 60_000);
  });
});

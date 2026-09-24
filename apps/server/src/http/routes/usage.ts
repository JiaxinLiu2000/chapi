import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db/client.js';

/**
 * Read-only rollup over the UsageEvent ledger: "which account/session/trigger is
 * actually spending tokens right now" as a query instead of log archaeology.
 */
export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { windowMin?: string } }>('/usage', async (req) => {
    const windowMin = Math.max(1, Math.min(10080, Number(req.query.windowMin) || 60));
    const since = new Date(Date.now() - windowMin * 60_000);

    const events = await prisma.usageEvent.findMany({
      where: { createdAt: { gte: since } },
      select: {
        account: true,
        trigger: true,
        sessionId: true,
        inputTokens: true,
        outputTokens: true,
        costUsd: true,
      },
    });

    const byAccount = new Map<
      string,
      { calls: number; costUsd: number; inputTokens: number; outputTokens: number }
    >();
    const bySession = new Map<string, { calls: number; costUsd: number; accounts: Set<string> }>();
    for (const e of events) {
      const a = byAccount.get(e.account) ?? { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      a.calls += 1;
      a.costUsd += e.costUsd;
      a.inputTokens += e.inputTokens;
      a.outputTokens += e.outputTokens;
      byAccount.set(e.account, a);

      const s = bySession.get(e.sessionId) ?? { calls: 0, costUsd: 0, accounts: new Set<string>() };
      s.calls += 1;
      s.costUsd += e.costUsd;
      s.accounts.add(e.account);
      bySession.set(e.sessionId, s);
    }

    const sessionIds = [...bySession.keys()];
    const sessions = sessionIds.length
      ? await prisma.session.findMany({
          where: { id: { in: sessionIds } },
          select: { id: true, title: true },
        })
      : [];
    const titleById = new Map(sessions.map((s) => [s.id, s.title]));

    const topSessions = [...bySession.entries()]
      .map(([sessionId, v]) => ({
        sessionId,
        title: titleById.get(sessionId) ?? sessionId,
        calls: v.calls,
        costUsd: v.costUsd,
        accounts: [...v.accounts],
      }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 20);

    return {
      windowMin,
      since: since.toISOString(),
      totalEvents: events.length,
      byAccount: Object.fromEntries(byAccount),
      topSessions,
    };
  });
}

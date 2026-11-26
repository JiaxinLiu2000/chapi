import type { FastifyInstance } from 'fastify';
import { createSessionSchema, renameSessionSchema } from '@chapi/shared';
import { prisma } from '../../db/client.js';
import { getOrchestrator } from '../../orchestrator/types.js';
import {
  createSession,
  deleteSession,
  getEarlierMessages,
  getSessionBySlug,
  getSessionDetail,
  listSessions,
  renameSession,
  searchSessions,
} from '../../services/sessions.js';

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/sessions', async () => {
    return { sessions: await listSessions() };
  });

  // Full-text search over conversation content (titles are filtered client-side).
  app.get<{ Querystring: { q?: string } }>('/sessions/search', async (req) => {
    return searchSessions(String(req.query.q ?? '').slice(0, 200));
  });

  app.patch<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const parsed = renameSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const session = await renameSession(req.params.id, parsed.data.title);
    if (!session) return reply.status(404).send({ error: 'session not found' });
    return { session };
  });

  app.post('/sessions', async (req, reply) => {
    const parsed = createSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const session = await createSession(parsed.data);
    return reply.status(201).send({ session });
  });

  app.get<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const detail = await getSessionDetail(req.params.id);
    if (!detail) return reply.status(404).send({ error: 'session not found' });
    return detail;
  });

  // Infinite-scroll-up: page in messages older than `before`, oldest-to-newest.
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    '/sessions/:id/messages',
    async (req, reply) => {
      const { before, limit } = req.query;
      if (!before) return reply.status(400).send({ error: 'before is required' });
      const n = Math.max(1, Math.min(500, Number(limit) || 200));
      return getEarlierMessages(req.params.id, before, n);
    },
  );

  app.get<{ Params: { slug: string } }>(
    '/sessions/by-slug/:slug',
    async (req, reply) => {
      const session = await getSessionBySlug(req.params.slug);
      if (!session) return reply.status(404).send({ error: 'session not found' });
      const detail = await getSessionDetail(session.id);
      if (!detail) return reply.status(404).send({ error: 'session not found' });
      return detail;
    },
  );

  app.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const existing = await prisma.session.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send({ error: 'session not found' });
    // Stop any active run before deleting so it can't write to a deleted session.
    await getOrchestrator().abandon(req.params.id).catch(() => undefined);
    await deleteSession(req.params.id);
    return { ok: true as const };
  });
}

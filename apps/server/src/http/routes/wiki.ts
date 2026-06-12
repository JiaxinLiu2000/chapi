import type { FastifyInstance } from 'fastify';
import { wikiSearchSchema } from '@chapi/shared';
import { prisma } from '../../db/client.js';
import { toWikiEntryDTO } from '../../mappers.js';
import { searchWiki } from '../../rag/wiki.js';

export async function wikiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/wiki', async () => {
    const entries = await prisma.wikiEntry.findMany({ orderBy: { updatedAt: 'desc' } });
    return { entries: entries.map(toWikiEntryDTO) };
  });

  app.get<{ Params: { slug: string } }>('/wiki/:slug', async (req, reply) => {
    const entry = await prisma.wikiEntry.findUnique({ where: { slug: req.params.slug } });
    if (!entry) return reply.status(404).send({ error: 'wiki entry not found' });
    return { entry: toWikiEntryDTO(entry) };
  });

  app.post('/wiki/search', async (req, reply) => {
    const parsed = wikiSearchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const hits = await searchWiki(parsed.data.query, parsed.data.k);
    return { hits };
  });
}

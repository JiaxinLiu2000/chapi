import type { FastifyInstance } from 'fastify';
import { wikiSearchSchema, wikiUpsertSchema, type WikiUpsertInput } from '@chapi/shared';
import { prisma } from '../../db/client.js';
import { toWikiEntryDTO } from '../../mappers.js';
import { scoreDataSources } from '../../learning/learner.js';
import {
  clearWiki,
  deleteWikiEntry,
  listTags,
  readWikiEntry,
  searchWiki,
  syncVault,
  updateWikiEntryById,
  wikiGraph,
  writeWikiEntry,
  type WriteWikiInput,
} from '../../rag/wiki.js';

/** Manual edits from the web UI → store input (data confidence computed from its sources unless set). */
function fromUpsert(b: WikiUpsertInput): Partial<WriteWikiInput> {
  const out: Partial<WriteWikiInput> = {
    title: b.title.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim(),
    kind: b.kind,
    ...(b.topics ? { topics: b.topics } : {}),
    ...(b.situation !== undefined ? { situation: b.situation } : {}),
    ...(b.solution !== undefined ? { solution: b.solution } : {}),
    ...(b.body !== undefined ? { body: b.body } : {}),
    ...(b.tags ? { tags: b.tags } : {}),
    ...(b.aliases ? { questions: b.aliases } : {}),
    ...(b.polarity !== undefined ? { polarity: b.polarity } : {}),
    ...(b.observedAt !== undefined ? { observedAt: b.observedAt ? new Date(b.observedAt) : null } : {}),
    ...(b.score !== undefined ? { score: b.score } : {}),
    noAutoLinks: true,
  };
  if (b.sourceRefs) {
    if (b.kind === 'data' && b.sourceRefs.length) {
      const { refs, score } = scoreDataSources(
        b.sourceRefs.map((s) => ({ url: s.ref, title: s.note, publishedAt: s.date, tier: s.tier })),
        undefined,
      );
      out.sourceRefs = refs;
      if (b.score === undefined) out.score = score;
    } else out.sourceRefs = b.sourceRefs;
  }
  return out;
}

export async function wikiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/wiki', async () => {
    const entries = await prisma.wikiEntry.findMany({ orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }] });
    return { entries: entries.map(toWikiEntryDTO) };
  });

  app.delete('/wiki', async () => {
    const removed = await clearWiki();
    return { ok: true as const, removed };
  });

  app.get('/wiki/graph', async () => wikiGraph());

  app.get('/wiki/tags', async () => ({ tags: await listTags() }));

  /** Pull edits made in Obsidian into chapi now (the file watcher normally does this). */
  app.post('/wiki/sync', async () => syncVault());

  // ── manual CRUD (web UI) ──
  app.post('/wiki/entries', async (req, reply) => {
    const parsed = wikiUpsertSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const input = fromUpsert(parsed.data);
    if (await prisma.wikiEntry.findFirst({ where: { title: input.title } }))
      return reply.status(409).send({ error: `已有同名知识点「${input.title}」` });
    const entry = await writeWikiEntry({ ...(input as WriteWikiInput), history: { op: 'create', note: '用户在网页上新增' } });
    return { entry };
  });

  app.put<{ Params: { id: string } }>('/wiki/entries/:id', async (req, reply) => {
    const parsed = wikiUpsertSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const entry = await updateWikiEntryById(req.params.id, {
      ...fromUpsert(parsed.data),
      history: { op: 'user_edit', note: '用户在网页上编辑' },
    });
    if (!entry) return reply.status(404).send({ error: 'wiki entry not found' });
    return { entry };
  });

  app.delete<{ Params: { id: string } }>('/wiki/entries/:id', async (req) => {
    await deleteWikiEntry(req.params.id);
    return { ok: true as const };
  });

  app.get<{ Params: { slug: string } }>('/wiki/:slug/links', async (req, reply) => {
    const r = await readWikiEntry(decodeURIComponent(req.params.slug));
    if (!r) return reply.status(404).send({ error: 'wiki entry not found' });
    return { links: r.links, backlinks: r.backlinks };
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

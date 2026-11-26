/**
 * Replace the wiki with atomic knowledge points (data / skill / preference).
 * Input: one or more JSON arrays of points (see the spec used to produce them):
 *   { title, kind, situation, solution, notes, tags, aliases, polarity, weight,
 *     sources, observedAt, volatility, sourceRefs, from: oldIds[], primary, related: titles[] }
 * Every current entry id must be covered by some point's `from`, or nothing changes.
 * Links: `related`, every non-primary point → its note's primary point, and the
 * old notes' [[links]] carried over between their primary points.
 *
 *   npx tsx scripts/atomize-wiki.ts <links.json> <points-A.json> [<points-B.json> …] [--dry-run]
 *   (links.json = [{ id, linksTo: oldIds[] }], e.g. the dump used to make the plan)
 */
import fs from 'node:fs/promises';
import type { KnowledgeKind, WikiSourceRef } from '@chapi/shared';
import { prisma } from '../src/db/client.js';
import { tagRegistry } from '../src/knowledge/tags.js';
import { scoreDataSources } from '../src/learning/learner.js';
import type { Volatility } from '../src/tools/confidence.js';
import { SYNC_LOCK, deleteWikiEntry, syncVault, updateWikiEntryById, writeWikiEntry } from '../src/rag/wiki.js';

interface Point {
  title: string;
  kind: KnowledgeKind;
  situation: string;
  solution: string;
  notes?: string;
  tags?: string[];
  aliases?: string[];
  polarity?: 'positive' | 'negative';
  weight?: number;
  sources?: Array<{ url: string; title?: string; publishedAt?: string; tier?: string }>;
  observedAt?: string;
  volatility?: Volatility;
  sourceRefs?: WikiSourceRef[];
  from: string[];
  primary?: boolean;
  related?: string[];
}

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const [linksPath, ...planPaths] = args.filter((a) => a !== '--dry-run');
if (!linksPath || !planPaths.length) throw new Error('usage: atomize-wiki.ts <links.json> <points.json>… [--dry-run]');

const oldLinks = JSON.parse(await fs.readFile(linksPath, 'utf8')) as Array<{ id: string; linksTo: string[] }>;
const raw = (await Promise.all(planPaths.map(async (p) => JSON.parse(await fs.readFile(p, 'utf8')) as Point[]))).flat();

// Merge same-title points across groups (same lesson found in two places).
const byTitle = new Map<string, Point>();
for (const p of raw) {
  const t = p.title.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim();
  const cur = byTitle.get(t);
  if (!cur) {
    byTitle.set(t, { ...p, title: t });
    continue;
  }
  cur.from = [...new Set([...cur.from, ...p.from])];
  cur.related = [...new Set([...(cur.related ?? []), ...(p.related ?? [])])];
  cur.tags = [...new Set([...(cur.tags ?? []), ...(p.tags ?? [])])];
  cur.sources = [...(cur.sources ?? []), ...(p.sources ?? [])];
  cur.sourceRefs = [...(cur.sourceRefs ?? []), ...(p.sourceRefs ?? [])];
  cur.weight = Math.min(85, Math.max(cur.weight ?? 50, p.weight ?? 50) + 5);
  cur.primary = cur.primary || p.primary;
  if ((p.notes ?? '').trim()) cur.notes = [cur.notes, p.notes].filter(Boolean).join('\n\n');
}
const points = [...byTitle.values()];

const old = await prisma.wikiEntry.findMany();
const covered = new Set(points.flatMap((p) => p.from));
const missing = old.filter((e) => !covered.has(e.id));
const bad = points.filter((p) => !['data', 'skill', 'preference'].includes(p.kind) || !p.title || !p.from?.length);
const kinds = points.reduce<Record<string, number>>((m, p) => ((m[p.kind] = (m[p.kind] ?? 0) + 1), m), {});
console.log(`plan: ${old.length} notes → ${points.length} points ${JSON.stringify(kinds)} (merged ${raw.length - points.length} duplicate titles)`);
if (missing.length || bad.length) {
  console.error({ missing: missing.map((e) => e.title), bad: bad.map((p) => p.title) });
  throw new Error('plan does not cover the current wiki — nothing changed');
}
if (dry) process.exit(0);

const createdOf = new Map(old.map((e) => [e.id, e.createdAt]));
const titleOf = new Map(old.map((e) => [e.id, e.title]));
const primaryOf = new Map<string, string>(); // old id → title of its primary point
for (const p of points) if (p.primary) for (const id of p.from) if (!primaryOf.has(id)) primaryOf.set(id, p.title);
for (const p of points) for (const id of p.from) if (!primaryOf.has(id)) primaryOf.set(id, p.title);

await fs.writeFile(SYNC_LOCK, String(process.pid), 'utf8');
try {
  for (const e of old) await deleteWikiEntry(e.id);
  await prisma.wikiTag.deleteMany({});
  tagRegistry.reset();

  // Pass 1: create every point.
  const ids = new Map<string, string>();
  for (const p of points) {
    const base = {
      title: p.title,
      kind: p.kind,
      situation: p.situation ?? '',
      solution: p.solution ?? '',
      body: p.notes ?? '',
      tags: p.tags ?? [],
      questions: p.aliases ?? [],
      noAutoLinks: true,
      history: { op: 'import', note: `从旧 Wiki 拆分：${p.from.map((id) => titleOf.get(id)).join('；')}`.slice(0, 300) },
    };
    const e =
      p.kind === 'data'
        ? await (async () => {
            const { refs, score } = scoreDataSources(p.sources?.length ? p.sources : [{ url: 'user' }], p.volatility);
            const observed = p.observedAt && !Number.isNaN(Date.parse(p.observedAt)) ? new Date(p.observedAt) : null;
            return writeWikiEntry({ ...base, sourceRefs: refs, score, observedAt: observed });
          })()
        : await writeWikiEntry({
            ...base,
            score: Math.max(0, Math.min(100, Math.round(p.weight ?? 50))),
            polarity: p.kind === 'preference' ? (p.polarity === 'negative' ? 'negative' : 'positive') : '',
            sourceRefs: p.sourceRefs ?? [],
          });
    ids.set(p.title, e.id);
    const first = p.from.map((id) => createdOf.get(id)!).filter(Boolean).sort((a, b) => a.getTime() - b.getTime())[0];
    if (first) await prisma.$executeRaw`UPDATE WikiEntry SET createdAt = ${first} WHERE id = ${e.id}`;
  }

  // Pass 2: links.
  const links = new Map<string, Set<string>>(points.map((p) => [p.title, new Set(p.related ?? [])]));
  for (const p of points) {
    for (const id of p.from) {
      const prim = primaryOf.get(id);
      if (prim && prim !== p.title) links.get(p.title)!.add(prim); // sub-point → its note's main point
    }
  }
  for (const o of oldLinks) {
    const a = primaryOf.get(o.id);
    for (const t of o.linksTo ?? []) {
      const b = primaryOf.get(t);
      if (a && b && a !== b) links.get(a)?.add(b); // old [[links]] carried over
    }
  }
  let n = 0;
  for (const [title, set] of links) {
    const id = ids.get(title);
    const targets = [...set].filter((t) => ids.has(t) && t !== title);
    if (!id || !targets.length) continue;
    await updateWikiEntryById(id, { links: targets, noAutoLinks: true });
    n += targets.length;
  }
  console.log(`links written: ${n}`);
} finally {
  await fs.rm(SYNC_LOCK, { force: true });
}
console.log('sync check:', await syncVault());
const after = await prisma.wikiEntry.groupBy({ by: ['kind'], _count: { _all: true }, _avg: { score: true } });
console.log('done:', JSON.stringify(after.map((g) => ({ kind: g.kind, n: g._count._all, avgScore: Math.round(g._avg.score ?? 0) }))));
console.log('tags:', await prisma.wikiTag.count());
await prisma.$disconnect();

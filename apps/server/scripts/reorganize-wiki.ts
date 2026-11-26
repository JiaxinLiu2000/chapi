/**
 * Replace the whole AI Wiki with a reorganized set of notes (merged duplicates,
 * Obsidian folders, [[links]]). Input: a JSON array of
 *   { title, category, tags, aliases, body, links, sourceRefs, mergedFrom: oldIds[] }
 * Every current entry id must be covered by exactly one `mergedFrom`, otherwise
 * nothing is changed. Back up first (GET /api/wiki → data/backups/).
 *
 *   npx tsx scripts/reorganize-wiki.ts <plan.json> [--dry-run]
 */
import fs from 'node:fs/promises';
import type { WikiSourceRef } from '@chapi/shared';
import { prisma } from '../src/db/client.js';
import { SYNC_LOCK, deleteWikiEntry, syncVault, writeWikiEntry } from '../src/rag/wiki.js';

interface PlanNote {
  title: string;
  category: string;
  tags: string[];
  aliases: string[];
  body: string;
  links: string[];
  sourceRefs: WikiSourceRef[];
  mergedFrom: string[];
}

const [planPath, flag] = process.argv.slice(2);
if (!planPath) throw new Error('usage: reorganize-wiki.ts <plan.json> [--dry-run]');
const plan = JSON.parse(await fs.readFile(planPath, 'utf8')) as PlanNote[];
const old = await prisma.wikiEntry.findMany();

const covered = plan.flatMap((n) => n.mergedFrom);
const missing = old.filter((e) => !covered.includes(e.id));
const dup = covered.filter((id, i) => covered.indexOf(id) !== i);
const titles = new Set(plan.map((n) => n.title));
const badLinks = plan.flatMap((n) => n.links.filter((l) => !titles.has(l)).map((l) => `${n.title} → ${l}`));
if (missing.length || dup.length || titles.size !== plan.length) {
  console.error({ missing: missing.map((e) => e.title), dup, dupTitles: plan.length - titles.size });
  throw new Error('plan does not cover the current wiki exactly — nothing changed');
}
if (badLinks.length) console.warn('links to unknown titles (dropped):', badLinks);
console.log(`plan: ${old.length} → ${plan.length} notes`);
if (flag === '--dry-run') process.exit(0);

await fs.writeFile(SYNC_LOCK, String(process.pid), 'utf8');
try {
  for (const e of old) await deleteWikiEntry(e.id);
  const created = new Map<string, Date>();
  for (const e of old) created.set(e.id, e.createdAt);
  // Pass 1: all notes (bodies may already carry inline [[links]]).
  for (const n of plan) {
    await writeWikiEntry({
      title: n.title,
      body: n.body,
      category: n.category,
      tags: n.tags,
      questions: n.aliases,
      sourceRefs: n.sourceRefs,
      noAutoLinks: true,
    });
    // Keep the oldest original date (pass 2 re-exports the note with it).
    const first = n.mergedFrom.map((id) => created.get(id)!).sort((a, b) => a.getTime() - b.getTime())[0];
    if (first) await prisma.$executeRaw`UPDATE WikiEntry SET createdAt = ${first} WHERE title = ${n.title}`;
  }
  // Pass 2: now every target exists → add the "## 相关" links.
  for (const n of plan) {
    await writeWikiEntry({
      title: n.title,
      body: n.body,
      category: n.category,
      tags: n.tags,
      questions: n.aliases,
      sourceRefs: n.sourceRefs,
      links: n.links,
      noAutoLinks: true,
    });
  }
} finally {
  await fs.rm(SYNC_LOCK, { force: true });
}
console.log('sync check:', await syncVault());
console.log(`done: ${await prisma.wikiEntry.count()} notes`);
await prisma.$disconnect();

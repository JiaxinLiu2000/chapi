/**
 * Delete knowledge points by title and clean up every [[link]] that pointed at them
 * (list items linking only to a deleted point are dropped; inline links become plain text).
 *   npx tsx scripts/prune-wiki.ts <titles.json>      (JSON array of exact titles)
 */
import fs from 'node:fs/promises';
import { prisma } from '../src/db/client.js';
import { safeFileName } from '../src/rag/vault.js';
import { SYNC_LOCK, deleteWikiEntry, syncVault, updateWikiEntryById } from '../src/rag/wiki.js';

const file = process.argv[2];
if (!file) throw new Error('usage: prune-wiki.ts <titles.json>');
const titles = JSON.parse(await fs.readFile(file, 'utf8')) as string[];
const all = await prisma.wikiEntry.findMany();
const doomed = all.filter((e) => titles.includes(e.title));
const missing = titles.filter((t) => !doomed.some((e) => e.title === t));
if (missing.length) throw new Error(`not found: ${missing.join(' | ')}`);

const names = new Set(doomed.flatMap((e) => [e.title, safeFileName(e.title)]).map((n) => n.toLowerCase()));
const LINK = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
const isDoomed = (t: string) => names.has(t.trim().toLowerCase());
const clean = (text: string | null): string =>
  (text ?? '')
    .split('\n')
    // a list item that is just a link to a deleted point → drop the line
    .filter((line) => !/^\s*[-*]\s*\[\[[^\]]+\]\]\s*$/.test(line) || !isDoomed(line.replace(/^\s*[-*]\s*\[\[([^\]|#]+).*$/, '$1')))
    .join('\n')
    // any other link to a deleted point → plain text
    .replace(LINK, (m, t: string, label?: string) => (isDoomed(t) ? (label || t).trim() : m))
    .replace(/\n## 相关\s*$/, '')
    .trim();

await fs.writeFile(SYNC_LOCK, String(process.pid), 'utf8');
let edited = 0;
try {
  for (const e of doomed) await deleteWikiEntry(e.id);
  for (const e of all) {
    if (doomed.includes(e)) continue;
    const body = clean(e.bodyMd);
    const situation = clean(e.situation);
    const solution = clean(e.solution);
    if (body !== e.bodyMd.trim() || situation !== (e.situation ?? '').trim() || solution !== (e.solution ?? '').trim()) {
      await updateWikiEntryById(e.id, { body, situation, solution, noAutoLinks: true });
      edited += 1;
    }
  }
} finally {
  await fs.rm(SYNC_LOCK, { force: true });
}
console.log(`deleted ${doomed.length}, cleaned links in ${edited}; sync:`, await syncVault());
console.log(`remaining: ${await prisma.wikiEntry.count()}`);
await prisma.$disconnect();

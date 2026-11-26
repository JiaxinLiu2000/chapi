/**
 * Bulk-assign content categories: `{ "<entryId>": ["primary", "second", "third"] }`.
 *   npx tsx scripts/set-categories.ts <map.json> [--rename "Old=New" ...]
 */
import fs from 'node:fs/promises';
import { prisma } from '../src/db/client.js';
import { SYNC_LOCK, syncVault, updateWikiEntryById } from '../src/rag/wiki.js';

const args = process.argv.slice(2);
const file = args[0];
if (!file) throw new Error('usage: set-categories.ts <map.json> [--rename "Old=New"]');
const renames = new Map<string, string>();
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--rename' && args[i + 1]) {
    const [a, b] = args[i + 1]!.split('=');
    renames.set(a!, b!);
    i++;
  }
}
const map = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string[]>;
const ids = new Set((await prisma.wikiEntry.findMany({ select: { id: true } })).map((e) => e.id));
const missing = [...ids].filter((id) => !map[id]);
console.log(`map covers ${Object.keys(map).filter((id) => ids.has(id)).length}/${ids.size}; uncategorized: ${missing.length}`);

await fs.writeFile(SYNC_LOCK, String(process.pid), 'utf8');
let n = 0;
try {
  for (const [id, cats] of Object.entries(map)) {
    if (!ids.has(id)) continue;
    const topics = cats.map((c) => renames.get(c) ?? c).slice(0, 3);
    await updateWikiEntryById(id, { topics, noAutoLinks: true });
    n += 1;
  }
} finally {
  await fs.rm(SYNC_LOCK, { force: true });
}
console.log(`updated ${n}; sync check:`, await syncVault());
await prisma.$disconnect();

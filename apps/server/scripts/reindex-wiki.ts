/**
 * Rebuild the LanceDB vectors for every knowledge point (e.g. after OpenAI credits
 * are topped up — while embeddings failed, points were saved without vectors and
 * search fell back to keywords). Content is unchanged; only the index is rewritten.
 *   npx tsx scripts/reindex-wiki.ts
 */
import { prisma } from '../src/db/client.js';
import { embedOne, embeddingsAvailable } from '../src/rag/embeddings.js';
import { lanceClear } from '../src/rag/lance.js';
import { updateWikiEntryById } from '../src/rag/wiki.js';

if (!(await embeddingsAvailable())) throw new Error('没有配置 OpenAI Key');
try {
  await embedOne('ping');
} catch (e) {
  throw new Error(`OpenAI 嵌入仍不可用：${e instanceof Error ? e.message : e}`);
}
await lanceClear();
const all = await prisma.wikiEntry.findMany({ select: { id: true, title: true } });
let n = 0;
for (const e of all) {
  // A no-op update re-embeds the point (indexEntry runs on every write); keep links/body as they are.
  await updateWikiEntryById(e.id, { noAutoLinks: true });
  n += 1;
  if (n % 25 === 0) console.log(`${n}/${all.length}`);
}
console.log(`reindexed ${n} points`);
await prisma.$disconnect();

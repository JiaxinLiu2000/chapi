import { randomUUID } from 'node:crypto';
import type { WikiEntryDTO, WikiSearchHit, WikiSourceRef } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { createLogger } from '../logger.js';
import { toWikiEntryDTO } from '../mappers.js';
import { embed, embedOne, embeddingsAvailable } from './embeddings.js';
import { lanceSearch, lanceUpsertEntry, type WikiVectorRow } from './lance.js';

const log = createLogger('rag:wiki');

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return base || `entry-${Date.now()}`;
}

/** Split body into overlapping chunks for embedding. */
function chunkText(text: string, size = 900, overlap = 150): string[] {
  const clean = text.trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    chunks.push(clean.slice(start, start + size));
    start += size - overlap;
  }
  return chunks;
}

export interface WriteWikiInput {
  title: string;
  body: string;
  sourceRefs?: WikiSourceRef[];
  tags?: string[];
  /** Alternate phrasings / hypothetical questions, embedded as extra indices to the same entry. */
  questions?: string[];
}

export async function writeWikiEntry(input: WriteWikiInput): Promise<WikiEntryDTO> {
  const slug = slugify(input.title);
  const sourceRefs = input.sourceRefs ?? [];
  const tags = input.tags ?? [];

  const entry = await prisma.wikiEntry.upsert({
    where: { slug },
    update: {
      title: input.title,
      bodyMd: input.body,
      sourceRefs: sourceRefs as unknown as object,
      tags: tags as unknown as object,
    },
    create: {
      slug,
      title: input.title,
      bodyMd: input.body,
      sourceRefs: sourceRefs as unknown as object,
      tags: tags as unknown as object,
    },
  });

  if (await embeddingsAvailable()) {
    try {
      const indexTexts = [input.title, ...chunkText(input.body), ...(input.questions ?? [])].filter(
        (t) => t.trim().length > 0,
      );
      const vectors = await embed(indexTexts);
      const primarySource = sourceRefs[0] ? JSON.stringify(sourceRefs[0]) : 'null';
      const rows: WikiVectorRow[] = indexTexts.map((chunk, i) => ({
        id: randomUUID(),
        entryId: entry.id,
        chunk,
        sourceRef: primarySource,
        vector: vectors[i] ?? [],
      }));
      await lanceUpsertEntry(entry.id, rows);
    } catch (err) {
      log.warn('embedding/index failed; entry saved without vectors', err);
    }
  }

  return toWikiEntryDTO(entry);
}

export async function searchWiki(query: string, k = 5): Promise<WikiSearchHit[]> {
  if (!(await embeddingsAvailable())) return [];
  const vector = await embedOne(query);
  const hits = await lanceSearch(vector, k);
  if (hits.length === 0) return [];

  const entryIds = [...new Set(hits.map((h) => h.entryId))];
  const entries = await prisma.wikiEntry.findMany({ where: { id: { in: entryIds } } });
  const byId = new Map(entries.map((e) => [e.id, e]));

  const out: WikiSearchHit[] = [];
  for (const h of hits) {
    const entry = byId.get(h.entryId);
    if (!entry) continue;
    let sourceRef: WikiSourceRef | null = null;
    try {
      sourceRef = h.sourceRef === 'null' ? null : (JSON.parse(h.sourceRef) as WikiSourceRef);
    } catch {
      sourceRef = null;
    }
    out.push({
      entry: toWikiEntryDTO(entry),
      chunk: h.chunk,
      score: 1 / (1 + h.distance),
      sourceRef,
    });
  }
  return out;
}

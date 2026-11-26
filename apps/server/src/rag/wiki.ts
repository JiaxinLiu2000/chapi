import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, WikiEntry } from '@prisma/client';
import type {
  KnowledgeHistoryItem,
  KnowledgeKind,
  WikiEntryDTO,
  WikiGraphResponse,
  WikiSearchHit,
  WikiSourceRef,
  WikiSyncResponse,
} from '@chapi/shared';
import { prisma } from '../db/client.js';
import { createLogger } from '../logger.js';
import { toWikiEntryDTO } from '../mappers.js';
import { TAG_KIND_FOR, tagRegistry } from '../knowledge/tags.js';
import { embed, embedOne, embeddingsAvailable } from './embeddings.js';
import { lanceClear, lanceDeleteEntry, lanceSearch, lanceUpsertEntry, type WikiVectorRow } from './lance.js';
import {
  ENTRIES_DIR,
  KIND_FOLDER,
  MOC_FILE,
  VAULT_DIR,
  buildGraph,
  ensureObsidianConfig,
  extractLinks,
  kindOf,
  linkResolver,
  listNoteFiles,
  noteRelPath,
  parseNote,
  removeVaultFile,
  renderMoc,
  renderNote,
  sha256,
  withRelatedSection,
  writeVaultFile,
} from './vault.js';

const log = createLogger('rag:wiki');

/**
 * The knowledge store. Every knowledge point is a WikiEntry (DB = index, the
 * Obsidian note = what people read/edit, LanceDB = vectors when available):
 *   kind  data | skill | preference
 *   score 0-100 — confidence for data, weight for skills and preferences
 * Recall ranks *relevant* points by score, so well-established knowledge comes first.
 */

/** Max auto-added related links per note, and the LanceDB distance under which notes count as related. */
const AUTO_RELATED = 3;
const RELATED_MAX_DISTANCE = 1.05;
const HISTORY_MAX = 60;
/** Content category of points nobody classified yet. */
export const UNCATEGORIZED = '未分类';

const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const asList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** Delete all wiki entries (DB), their vectors (LanceDB) and their vault files. Returns count removed. */
export async function clearWiki(): Promise<number> {
  const rows = await prisma.wikiEntry.findMany({ select: { relPath: true } });
  const { count } = await prisma.wikiEntry.deleteMany({});
  await lanceClear().catch(() => undefined);
  for (const r of rows) await removeVaultFile(r.relPath);
  await writeMoc();
  log.info(`cleared wiki: ${count} entries + vectors + notes`);
  return count;
}

export function slugify(title: string): string {
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

/** Full searchable text of a point. */
function pointText(e: Pick<WikiEntry, 'situation' | 'solution' | 'bodyMd'>): string {
  return [e.situation ?? '', e.solution ?? '', e.bodyMd].filter((x) => x.trim()).join('\n\n');
}

/** (Re)embed one entry into LanceDB. Returns the mean vector (for related-note lookup) or null. */
async function indexEntry(entry: WikiEntry): Promise<number[] | null> {
  if (!(await embeddingsAvailable())) return null;
  try {
    const sourceRefs = (entry.sourceRefs as unknown as WikiSourceRef[]) ?? [];
    const indexTexts = [entry.title, ...chunkText(pointText(entry)), ...asList(entry.aliases)].filter((t) => t.trim().length > 0);
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
    const dim = vectors[0]?.length ?? 0;
    if (!dim) return null;
    const mean = new Array<number>(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) mean[i]! += (v[i] ?? 0) / vectors.length;
    const norm = Math.hypot(...mean) || 1;
    return mean.map((x) => x / norm);
  } catch (err) {
    log.warn(`embedding/index failed; entry saved without vectors: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    return null;
  }
}

/** Titles of the notes most similar to `vector` (excluding `selfId`). */
async function similarTitles(vector: number[], selfId: string): Promise<string[]> {
  const hits = await lanceSearch(vector, 24).catch(() => []);
  const ids: string[] = [];
  for (const h of hits) {
    if (h.entryId === selfId || ids.includes(h.entryId) || h.distance > RELATED_MAX_DISTANCE) continue;
    ids.push(h.entryId);
    if (ids.length >= AUTO_RELATED) break;
  }
  if (!ids.length) return [];
  const rows = await prisma.wikiEntry.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
  return ids.map((id) => rows.find((r) => r.id === id)?.title).filter((t): t is string => Boolean(t));
}

/** Fallback relatedness without embeddings: same kind and ≥2 shared tags. */
async function tagRelatedTitles(entry: WikiEntry): Promise<string[]> {
  const tags = new Set(asList(entry.tags).map((t) => t.toLowerCase()));
  if (tags.size < 2) return [];
  const all = await prisma.wikiEntry.findMany({ select: { id: true, title: true, tags: true, score: true } });
  return all
    .filter((e) => e.id !== entry.id)
    .map((e) => ({ t: e.title, n: asList(e.tags).filter((x) => tags.has(x.toLowerCase())).length, s: e.score }))
    .filter((x) => x.n >= 2)
    .sort((a, b) => b.n - a.n || b.s - a.s)
    .slice(0, AUTO_RELATED)
    .map((x) => x.t);
}

/** Write an entry's note file (moving it if its kind/title changed) and record path + hash without touching updatedAt. */
async function exportEntry(entry: WikiEntry): Promise<WikiEntry> {
  const relPath = noteRelPath(KIND_FOLDER[kindOf(entry.kind)], entry.title);
  const text = renderNote(entry);
  await writeVaultFile(relPath, text);
  if (entry.relPath && entry.relPath !== relPath) await removeVaultFile(entry.relPath);
  const fileHash = sha256(text);
  await prisma.$executeRaw`UPDATE WikiEntry SET relPath = ${relPath}, fileHash = ${fileHash} WHERE id = ${entry.id}`;
  return { ...entry, relPath, fileHash };
}

let mocTimer: NodeJS.Timeout | null = null;
/** Regenerate the vault's table of contents (debounced). */
function writeMoc(): Promise<void> {
  if (mocTimer) clearTimeout(mocTimer);
  return new Promise((resolve) => {
    mocTimer = setTimeout(async () => {
      mocTimer = null;
      try {
        const rows = await prisma.wikiEntry.findMany({ select: { title: true, kind: true, score: true, polarity: true, tags: true, topics: true } });
        await writeVaultFile(MOC_FILE, renderMoc(rows));
      } catch (err) {
        log.warn('write MOC failed', err);
      }
      resolve();
    }, 500);
  });
}

function withHistory(prev: unknown, item: Omit<KnowledgeHistoryItem, 'at'> | undefined): Prisma.InputJsonValue | undefined {
  if (!item) return undefined;
  const list = (Array.isArray(prev) ? (prev as KnowledgeHistoryItem[]) : []).concat({ at: new Date().toISOString(), ...item });
  return list.slice(-HISTORY_MAX) as unknown as Prisma.InputJsonValue;
}

export interface WriteWikiInput {
  title: string;
  /** Free notes (details, examples, `## 相关` links). */
  body?: string;
  kind?: KnowledgeKind;
  /** 1-3 content categories (website / project / client / domain). Keeps the existing ones when omitted. */
  topics?: string[];
  /** 0-100 confidence (data) / weight (skill, preference). Keeps the existing score when omitted. */
  score?: number;
  polarity?: 'positive' | 'negative' | '';
  situation?: string;
  solution?: string;
  observedAt?: Date | null;
  sourceRefs?: WikiSourceRef[];
  tags?: string[];
  /** Alternate phrasings / hypothetical questions — Obsidian aliases, embedded as extra indices. */
  questions?: string[];
  /** Titles of existing notes this one relates to — written as [[wikilinks]]. */
  links?: string[];
  /** Skip the automatic "## 相关" suggestions (e.g. bulk imports that set links explicitly). */
  noAutoLinks?: boolean;
  /** Recorded in the point's history. */
  history?: Omit<KnowledgeHistoryItem, 'at'>;
}

async function resolveLinks(body: string, links: string[] | undefined, selfTitle: string): Promise<string> {
  if (!links?.length) return body;
  const all = await prisma.wikiEntry.findMany({ select: { id: true, title: true, aliases: true } });
  const resolve = linkResolver(all);
  const titles = links
    .map((t) => all.find((e) => e.id === resolve(t))?.title)
    .filter((t): t is string => Boolean(t) && t !== selfTitle);
  return withRelatedSection(body, [...new Set(titles)]);
}

async function finishWrite(entry: WikiEntry, noAutoLinks: boolean | undefined): Promise<WikiEntry> {
  const vector = await indexEntry(entry);
  if (!noAutoLinks) {
    const related = vector ? await similarTitles(vector, entry.id) : await tagRelatedTitles(entry);
    const withRelated = withRelatedSection(entry.bodyMd, related);
    if (withRelated !== entry.bodyMd) entry = await prisma.wikiEntry.update({ where: { id: entry.id }, data: { bodyMd: withRelated } });
  }
  entry = await exportEntry(entry).catch((err) => {
    log.warn('vault export failed', err);
    return entry;
  });
  void writeMoc();
  return entry;
}

/** Create or update (same title) a knowledge point. */
export async function writeWikiEntry(input: WriteWikiInput): Promise<WikiEntryDTO> {
  const slug = slugify(input.title);
  const existing = await prisma.wikiEntry.findUnique({ where: { slug } });
  return toWikiEntryDTO(await upsertPoint(existing, slug, input));
}

/** Edit a point by id (title may change; e.g. from the web editor or the learning agent). */
export async function updateWikiEntryById(id: string, input: Partial<WriteWikiInput>): Promise<WikiEntryDTO | null> {
  const existing = await prisma.wikiEntry.findUnique({ where: { id } });
  if (!existing) return null;
  const title = input.title ?? existing.title;
  let slug = slugify(title);
  if (slug !== existing.slug && (await prisma.wikiEntry.findUnique({ where: { slug } }))) slug = `${slug}-${Date.now().toString(36)}`;
  return toWikiEntryDTO(await upsertPoint(existing, slug, { ...input, title }));
}

async function upsertPoint(existing: WikiEntry | null, slug: string, input: WriteWikiInput): Promise<WikiEntry> {
  const kind = input.kind ?? kindOf(existing?.kind);
  const sourceRefs = input.sourceRefs ?? (existing ? ((existing.sourceRefs as unknown as WikiSourceRef[]) ?? []) : []);
  const rawTags = input.tags ?? (existing ? asList(existing.tags) : []);
  const tags = await tagRegistry.canonicalize(rawTags, TAG_KIND_FOR[kind]);
  const rawTopics = input.topics?.length ? input.topics : existing ? asList(existing.topics) : [];
  const topics = (await tagRegistry.canonicalize(rawTopics.length ? rawTopics : [UNCATEGORIZED], 'category')).slice(0, 3);
  const aliases = [...new Set((input.questions ?? (existing ? asList(existing.aliases) : [])).map((q) => q.trim()).filter(Boolean))];
  const body = await resolveLinks(input.body ?? existing?.bodyMd ?? '', input.links, input.title);
  const score = clampScore(input.score ?? existing?.score ?? 50);
  const data = {
    slug,
    title: input.title,
    bodyMd: body,
    sourceRefs: sourceRefs as unknown as object,
    tags: tags as unknown as object,
    aliases: aliases as unknown as object,
    category: KIND_FOLDER[kind],
    kind,
    topics: topics as unknown as object,
    score,
    polarity: kind === 'preference' ? input.polarity || existing?.polarity || 'positive' : '',
    situation: input.situation ?? existing?.situation ?? '',
    solution: input.solution ?? existing?.solution ?? '',
    observedAt: input.observedAt !== undefined ? input.observedAt : (existing?.observedAt ?? null),
    ...(input.history ? { history: withHistory(existing?.history, { score, ...input.history }) } : {}),
  };
  const entry = existing
    ? await prisma.wikiEntry.update({ where: { id: existing.id }, data })
    : await prisma.wikiEntry.create({ data: { ...data, history: withHistory(null, input.history ?? { op: 'create', score }) } });
  return finishWrite(entry, input.noAutoLinks);
}

/** Weight/confidence ±delta (clamped 0-100), recorded in history. */
export async function adjustScore(
  id: string,
  delta: number,
  item: Omit<KnowledgeHistoryItem, 'at' | 'delta' | 'score'>,
): Promise<WikiEntryDTO | null> {
  const e = await prisma.wikiEntry.findUnique({ where: { id } });
  if (!e) return null;
  const score = clampScore(e.score + delta);
  let entry = await prisma.wikiEntry.update({
    where: { id },
    data: { score, history: withHistory(e.history, { ...item, delta, score }) },
  });
  entry = await exportEntry(entry).catch(() => entry);
  void writeMoc();
  return toWikiEntryDTO(entry);
}

export async function deleteWikiEntry(id: string): Promise<void> {
  const row = await prisma.wikiEntry.findUnique({ where: { id } });
  if (!row) return;
  // File first: a vault sync running in between then sees "file gone" and deletes too,
  // instead of "file without DB row" and re-importing it.
  await removeVaultFile(row.relPath);
  await prisma.wikiEntry.delete({ where: { id } });
  await lanceDeleteEntry(id).catch(() => undefined);
  void writeMoc();
}

/**
 * Bulk jobs (e.g. scripts/reorganize-wiki.ts, another process) hold this lock
 * file so the server's vault watcher doesn't sync half-written state.
 */
export const SYNC_LOCK = path.join(VAULT_DIR, '.chapi-sync.lock');

async function syncPaused(): Promise<boolean> {
  try {
    const st = await fs.stat(SYNC_LOCK);
    return Date.now() - st.mtimeMs < 15 * 60_000; // stale locks expire
  } catch {
    return false;
  }
}

/** Full note by id, slug, title or alias — plus outgoing links and backlinks (titles). */
export async function readWikiEntry(
  key: string,
): Promise<{ entry: WikiEntryDTO; links: string[]; backlinks: string[] } | null> {
  const all = await prisma.wikiEntry.findMany();
  const resolve = linkResolver(all);
  const k = key.trim();
  const e = all.find((x) => x.id === k) ?? all.find((x) => x.slug === k) ?? all.find((x) => x.id === resolve(k));
  if (!e) return null;
  const links = extractLinks(e.bodyMd)
    .map((t) => all.find((x) => x.id === resolve(t))?.title)
    .filter((t): t is string => Boolean(t));
  const backlinks = all
    .filter((x) => x.id !== e.id && extractLinks(x.bodyMd).some((t) => resolve(t) === e.id))
    .map((x) => x.title);
  return { entry: toWikiEntryDTO(e), links: [...new Set(links)], backlinks };
}

export async function wikiGraph(): Promise<WikiGraphResponse> {
  return buildGraph(await prisma.wikiEntry.findMany());
}

/** Search tokens: latin words (≥2 chars) + CJK bigrams, so Chinese queries without spaces still match. */
export function searchTokens(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9][a-z0-9._-]+/g) ?? []) out.add(w);
  for (const run of text.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/** Keyword relevance 0..1: token overlap, title/alias/tag hits weigh double. */
function keywordRelevance(e: WikiEntry, terms: string[]): number {
  if (!terms.length) return 0;
  const head = `${e.title}\n${asList(e.aliases).join('\n')}\n${asList(e.tags).join(' ')}\n${asList(e.topics).join(' ')}`.toLowerCase();
  const body = pointText(e).toLowerCase();
  let score = 0;
  for (const t of terms) score += head.includes(t) ? 2 : body.includes(t) ? 1 : 0;
  // Long queries (e.g. a whole learning context) would make every point look irrelevant —
  // normalize by at most 20 terms, so "matches 20 of the query's ideas" already counts as fully relevant.
  return Math.min(1, score / (2 * Math.min(terms.length, 20)));
}

export interface KnowledgeHit {
  entry: WikiEntry;
  relevance: number;
}

/**
 * Relevant knowledge points, highest weight/confidence first. Vector relevance
 * when embeddings work, otherwise keyword overlap; `minRelevance` filters noise,
 * then the top relevant ones are re-ranked by score.
 */
export async function searchKnowledge(
  query: string,
  opts: { kind?: KnowledgeKind; k?: number; minRelevance?: number; tags?: string[]; topics?: string[] } = {},
): Promise<KnowledgeHit[]> {
  const k = opts.k ?? 8;
  const all = await prisma.wikiEntry.findMany(opts.kind ? { where: { kind: opts.kind } } : undefined);
  if (!all.length) return [];
  const rel = new Map<string, number>();

  let vectorOk = false;
  if (query.trim() && (await embeddingsAvailable())) {
    try {
      const hits = await lanceSearch(await embedOne(query), Math.max(30, k * 4));
      for (const h of hits) {
        const r = 1 / (1 + h.distance);
        if (r > (rel.get(h.entryId) ?? 0)) rel.set(h.entryId, r);
      }
      vectorOk = hits.length > 0;
    } catch (err) {
      log.warn(`vector search unavailable, using keywords: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
  }
  const terms = searchTokens(query);
  const tagSet = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
  const topicSet = new Set((opts.topics ?? []).map((t) => t.toLowerCase()));
  for (const e of all) {
    let r = keywordRelevance(e, terms);
    if (tagSet.size && asList(e.tags).some((t) => tagSet.has(t.toLowerCase()))) r = Math.max(r, 0.6);
    // Same content category (website / project) as what's being worked on → clearly relevant.
    if (topicSet.size && asList(e.topics).some((t) => topicSet.has(t.toLowerCase()))) r = Math.min(1, r + 0.3);
    if (vectorOk) r = Math.max(r * 0.8, rel.get(e.id) ?? 0);
    rel.set(e.id, r);
  }
  const min = opts.minRelevance ?? (vectorOk ? 0.45 : 0.25);
  return all
    .map((entry) => ({ entry, relevance: rel.get(entry.id) ?? 0 }))
    .filter((h) => h.relevance >= min)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, k * 3) // the relevant ones…
    .sort((a, b) => b.entry.score - a.entry.score || b.relevance - a.relevance) // …strongest first
    .slice(0, k);
}

/** Back-compat shape for `/wiki/search` and older callers. */
export async function searchWiki(query: string, k = 5): Promise<WikiSearchHit[]> {
  const hits = await searchKnowledge(query, { k });
  return hits.map(({ entry, relevance }) => {
    const sources = (entry.sourceRefs as unknown as WikiSourceRef[]) ?? [];
    return { entry: toWikiEntryDTO(entry), chunk: pointText(entry).slice(0, 900), score: relevance, sourceRef: sources[0] ?? null };
  });
}

export async function listTags(): Promise<Array<{ name: string; kind: string; aliases: string[]; count: number }>> {
  const [tags, entries] = await Promise.all([
    prisma.wikiTag.findMany(),
    prisma.wikiEntry.findMany({ select: { tags: true, topics: true } }),
  ]);
  const count = new Map<string, number>();
  for (const e of entries) {
    for (const t of asList(e.tags)) count.set(t, (count.get(t) ?? 0) + 1);
    for (const t of asList(e.topics)) count.set(`category:${t}`, (count.get(`category:${t}`) ?? 0) + 1);
  }
  return tags
    .map((t) => ({
      name: t.kind === 'category' ? t.name.replace(/^category:/, '') : t.name,
      kind: t.kind,
      aliases: asList(t.aliases),
      count: count.get(t.name) ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ── Vault ⇄ DB sync (edits made in Obsidian flow back into chapi) ──────────

let syncing: Promise<WikiSyncResponse> | null = null;

/**
 * Reconcile the vault with the DB: new/changed note files update the DB (and
 * vectors); notes deleted in Obsidian are deleted; DB entries without a file
 * are exported. A vault that suddenly lost most of its files is treated as a
 * missing folder, not a mass delete — those entries are re-exported instead.
 */
export function syncVault(): Promise<WikiSyncResponse> {
  if (syncing) return syncing;
  syncing = (async () => {
    const report: WikiSyncResponse = { created: 0, updated: 0, deleted: 0, exported: 0 };
    if (await syncPaused()) {
      log.info('vault sync paused (bulk job holds the lock)');
      return report;
    }
    await fs.mkdir(ENTRIES_DIR, { recursive: true });
    const files = await listNoteFiles();
    const db = await prisma.wikiEntry.findMany();
    const byId = new Map(db.map((e) => [e.id, e]));
    const byPath = new Map(db.filter((e) => e.relPath).map((e) => [e.relPath, e]));
    const seenIds = new Set<string>();

    for (const rel of files) {
      let text: string;
      try {
        text = await fs.readFile(path.join(VAULT_DIR, rel), 'utf8');
      } catch {
        continue;
      }
      const note = parseNote(rel, text);
      const match = (note.id && byId.get(note.id)) || byPath.get(rel) || db.find((e) => e.slug === slugify(note.title));
      if (match && seenIds.has(match.id)) continue; // duplicate copy of a note — first one wins
      if (match) seenIds.add(match.id);
      if (match && match.fileHash === note.hash && match.relPath === rel) continue; // unchanged (or our own write)

      const tags = await tagRegistry.canonicalize(note.tags, TAG_KIND_FOR[note.kind]);
      const topics = (await tagRegistry.canonicalize(note.topics.length ? note.topics : [UNCATEGORIZED], 'category')).slice(0, 3);
      const data = {
        title: note.title,
        bodyMd: note.body,
        situation: note.situation,
        solution: note.solution,
        tags: tags as unknown as object,
        aliases: note.aliases as unknown as object,
        sourceRefs: note.sourceRefs as unknown as object,
        category: note.category,
        kind: note.kind,
        topics: topics as unknown as object,
        polarity: note.polarity,
        observedAt: note.observedAt,
        ...(note.score !== null ? { score: note.score } : {}),
      };
      let entry: WikiEntry;
      if (match) {
        const slug = slugify(note.title);
        const clash = slug !== match.slug && db.some((e) => e.slug === slug && e.id !== match.id);
        entry = await prisma.wikiEntry.update({
          where: { id: match.id },
          data: {
            ...data,
            ...(clash ? {} : { slug }),
            history: withHistory(match.history, { op: 'user_edit', note: '在 Obsidian 中修改', score: note.score ?? match.score }),
          },
        });
        report.updated += 1;
      } else {
        let slug = slugify(note.title);
        if (db.some((e) => e.slug === slug)) slug = `${slug}-${Date.now().toString(36)}`;
        entry = await prisma.wikiEntry.create({
          data: { slug, ...data, history: withHistory(null, { op: 'create', note: '在 Obsidian 中新建', score: note.score ?? 50 }) },
        });
        seenIds.add(entry.id);
        report.created += 1;
      }
      await indexEntry(entry);
      if (!note.id || note.id !== entry.id || match?.relPath !== rel) {
        // New / moved note: write the id back into its properties (and normalize the file).
        await exportEntry({ ...entry, relPath: rel });
      } else {
        await prisma.$executeRaw`UPDATE WikiEntry SET relPath = ${rel}, fileHash = ${note.hash} WHERE id = ${entry.id}`;
      }
    }

    const missing = db.filter((e) => !seenIds.has(e.id));
    const withPath = missing.filter((e) => e.relPath);
    const massLoss = db.length >= 6 && withPath.length > db.length / 2;
    if (massLoss) log.warn(`vault is missing ${withPath.length}/${db.length} notes — re-exporting instead of deleting`);
    for (const e of missing) {
      if (e.relPath && !massLoss) {
        await prisma.wikiEntry.delete({ where: { id: e.id } }).catch(() => undefined);
        await lanceDeleteEntry(e.id).catch(() => undefined);
        report.deleted += 1;
      } else {
        await exportEntry(e);
        report.exported += 1;
      }
    }
    if (report.created || report.updated || report.deleted || report.exported) {
      await writeMoc();
      log.info(`vault sync: ${JSON.stringify(report)}`);
    }
    return report;
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

let watcher: fsSync.FSWatcher | null = null;
let watchTimer: NodeJS.Timeout | null = null;

/** Seed Obsidian config, reconcile, then watch entries/ for edits made in Obsidian. */
export async function initWikiVault(): Promise<void> {
  await fs.mkdir(ENTRIES_DIR, { recursive: true });
  await ensureObsidianConfig().catch((err) => log.warn('obsidian config failed', err));
  await syncVault().catch((err) => log.warn('initial vault sync failed', err));
  void writeMoc();
  if (watcher) return;
  try {
    watcher = fsSync.watch(ENTRIES_DIR, { recursive: true }, (_ev, file) => {
      if (file && !String(file).toLowerCase().endsWith('.md')) return;
      if (watchTimer) clearTimeout(watchTimer);
      watchTimer = setTimeout(() => void syncVault().catch((err) => log.warn('vault sync failed', err)), 1500);
    });
    log.info(`watching Obsidian vault ${VAULT_DIR}`);
  } catch (err) {
    log.warn('vault watcher unavailable; use POST /api/wiki/sync', err);
  }
}

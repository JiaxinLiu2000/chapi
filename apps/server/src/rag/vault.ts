import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { WikiEntry } from '@prisma/client';
import { KNOWLEDGE_SECTION_LABEL, type KnowledgeKind, type WikiGraphResponse, type WikiSourceRef } from '@chapi/shared';
import { config } from '../config.js';
import { asString, asStringList, parseFrontmatter, serializeFrontmatter, splitFrontmatter, type FmValue } from './frontmatter.js';

/**
 * The AI Wiki as an Obsidian vault: `workspaces/ai-wiki/` is the vault root,
 * every entry is `entries/<分类>/<标题>.md` with YAML properties (id, aliases,
 * tags, sources, dates) and `[[wikilinks]]` between notes. The DB row stays the
 * search index (plus LanceDB vectors); the file is what people read and edit.
 */

export const VAULT_DIR = config.paths.aiWiki;
export const ENTRIES_DIR = path.join(VAULT_DIR, 'entries');
export const DEFAULT_CATEGORY = '未分类';
export const MOC_FILE = '知识库目录.md';

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** File-system/Obsidian-safe note name (also what `[[…]]` links resolve against). */
export function safeFileName(title: string): string {
  const s = title
    .replace(/[\\/:*?"<>|#^[\]]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .trim()
    .replace(/^[.\s-]+|[.\s]+$/g, '');
  return (s || 'untitled').slice(0, 100).trim();
}

export function safeCategory(c: string | null | undefined): string {
  const s = (c ?? '')
    .split(/[\\/]/)
    .map((p) => safeFileName(p))
    .filter((p) => p && p !== 'untitled')
    .join('/');
  return s || DEFAULT_CATEGORY;
}

export function noteRelPath(category: string, title: string): string {
  return path.posix.join('entries', safeCategory(category), `${safeFileName(title)}.md`);
}

/** `[[Note]]` for an entry — `[[file|Title]]` when the title had unsafe characters. */
export function wikiLink(title: string): string {
  const f = safeFileName(title);
  return f === title ? `[[${f}]]` : `[[${f}|${title}]]`;
}

const LINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

/** Targets of all `[[wikilinks]]` in a note body (file names, as written). */
export function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) out.add(m[1]!.trim());
  return [...out];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export const KIND_FOLDER: Record<KnowledgeKind, string> = { skill: '技能', preference: '偏好', data: '数据' };
const FOLDER_KIND: Record<string, KnowledgeKind> = { 技能: 'skill', 偏好: 'preference', 数据: 'data' };

export function kindOf(v: string | null | undefined): KnowledgeKind {
  return v === 'data' || v === 'preference' || v === 'skill' ? v : 'skill';
}

type NoteFields = Pick<
  WikiEntry,
  | 'id'
  | 'title'
  | 'bodyMd'
  | 'tags'
  | 'sourceRefs'
  | 'aliases'
  | 'category'
  | 'createdAt'
  | 'updatedAt'
  | 'kind'
  | 'topics'
  | 'score'
  | 'polarity'
  | 'situation'
  | 'solution'
  | 'observedAt'
>;

/**
 * A knowledge point as an Obsidian note: typed properties up top (kind, weight /
 * confidence, polarity, tags, sources…), then the two structured sections
 * (情况/前提 → 方案) and free notes (incl. `## 相关` [[links]]).
 */
export function renderNote(e: NoteFields): string {
  const kind = kindOf(e.kind);
  const tags = ((e.tags as unknown as string[]) ?? []).map((t) => t.trim().replace(/\s+/g, '-').replace(/^#/, '')).filter(Boolean);
  const sources = ((e.sourceRefs as unknown as WikiSourceRef[]) ?? []).map((s) => ({
    kind: s.kind,
    ref: s.ref,
    ...(s.note ? { note: s.note } : {}),
    ...(s.date ? { date: s.date } : {}),
    ...(s.tier ? { tier: s.tier } : {}),
    ...(typeof s.confidence === 'number' ? { confidence: s.confidence } : {}),
  }));
  const props: Record<string, FmValue> = {
    id: e.id,
    title: e.title,
    categories: ((e.topics as unknown as string[] | null) ?? []) as FmValue[],
    kind,
    [kind === 'data' ? 'confidence' : 'weight']: e.score,
  };
  if (kind === 'preference') props.polarity = e.polarity || 'positive';
  props.aliases = ((e.aliases as unknown as string[] | null) ?? []) as FmValue[];
  props.tags = tags as FmValue[];
  if (kind === 'data' && e.observedAt) props.observed = iso(e.observedAt);
  props.sources = sources as unknown as FmValue[];
  props.created = iso(e.createdAt);
  props.updated = iso(e.updatedAt);
  const [l1, l2] = KNOWLEDGE_SECTION_LABEL[kind];
  const parts = [`## ${l1}`, (e.situation ?? '').trim() || '（未填写）', '', `## ${l2}`, (e.solution ?? '').trim() || '（未填写）'];
  const notes = e.bodyMd.trim();
  if (notes) parts.push('', notes.startsWith('## ') ? notes : `## 备注\n${notes}`);
  return `${serializeFrontmatter(props)}\n${parts.join('\n')}\n`;
}

export interface ParsedNote {
  relPath: string;
  id?: string;
  title: string;
  category: string;
  kind: KnowledgeKind;
  topics: string[];
  score: number | null;
  polarity: string;
  observedAt: Date | null;
  aliases: string[];
  tags: string[];
  sourceRefs: WikiSourceRef[];
  situation: string;
  solution: string;
  /** Everything except the two structured sections (notes, related links…). */
  body: string;
  hash: string;
}

const SITUATION_HEAD = /^(情况|前提|场景|数据对象|对象|situation|context)/i;
const SOLUTION_HEAD = /^(方案|数据内容|数据|期望做法|做法|solution|answer)/i;

/** Split a note body into its 情况 / 方案 sections and the remaining notes. */
export function splitSections(body: string): { situation: string; solution: string; notes: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let cur: 'situation' | 'solution' | 'notes' = 'notes';
  const acc = { situation: [] as string[], solution: [] as string[], notes: [] as string[] };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const t = h[1]!;
      if (SITUATION_HEAD.test(t)) {
        cur = 'situation';
        continue;
      }
      if (SOLUTION_HEAD.test(t)) {
        cur = 'solution';
        continue;
      }
      cur = 'notes';
      if (/^备注$/.test(t)) continue; // our own wrapper heading
    }
    acc[cur].push(line);
  }
  const clean = (a: string[]) => a.join('\n').trim().replace(/^（未填写）$/, '');
  return { situation: clean(acc.situation), solution: clean(acc.solution), notes: clean(acc.notes) };
}

export function parseNote(relPath: string, text: string): ParsedNote {
  const { fm, body } = splitFrontmatter(text);
  const props = fm ? parseFrontmatter(fm) : {};
  const rel = relPath.split(path.sep).join('/');
  const parts = rel.split('/');
  const folder = parts.length > 2 ? parts.slice(1, -1).join('/') : DEFAULT_CATEGORY;
  const base = parts[parts.length - 1]!.replace(/\.md$/i, '');
  const rawSources = Array.isArray(props.sources) ? props.sources : [];
  const sourceRefs: WikiSourceRef[] = [];
  for (const s of rawSources) {
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      const o = s as Record<string, FmValue>;
      const ref = asString(o.ref);
      if (!ref) continue;
      const note = asString(o.note);
      const date = asString(o.date);
      const tier = asString(o.tier);
      const conf = Number(o.confidence);
      sourceRefs.push({
        kind: asString(o.kind) ?? 'web',
        ref,
        ...(note ? { note } : {}),
        ...(date ? { date } : {}),
        ...(tier ? { tier } : {}),
        ...(Number.isFinite(conf) && o.confidence !== null && o.confidence !== undefined ? { confidence: conf } : {}),
      });
    } else if (typeof s === 'string' && s.trim()) {
      sourceRefs.push({ kind: /^https?:/.test(s) ? 'web' : 'raw-material', ref: s.trim() });
    }
  }
  // Moving a note into another kind folder in Obsidian changes its kind.
  const kind = FOLDER_KIND[folder.split('/')[0]!] ?? kindOf(asString(props.kind));
  const scoreRaw = Number(props.weight ?? props.confidence ?? props.score);
  const observed = asString(props.observed);
  const sec = splitSections(body);
  // The file name is the title (renaming in Obsidian renames the note); the `title`
  // property only restores characters a file name can't hold (: / ? …).
  const fmTitle = asString(props.title)?.trim();
  return {
    relPath: rel,
    id: asString(props.id),
    title: fmTitle && safeFileName(fmTitle) === base ? fmTitle : base,
    category: KIND_FOLDER[kind],
    kind,
    topics: asStringList(props.categories ?? props.category).slice(0, 3),
    score: Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : null,
    polarity: asString(props.polarity) === 'negative' ? 'negative' : kind === 'preference' ? 'positive' : '',
    observedAt: observed && !Number.isNaN(Date.parse(observed)) ? new Date(observed) : null,
    aliases: asStringList(props.aliases),
    tags: asStringList(props.tags).map((t) => t.replace(/^#/, '')),
    sourceRefs,
    situation: sec.situation,
    solution: sec.solution,
    body: sec.notes,
    hash: sha256(text),
  };
}

export async function writeVaultFile(relPath: string, text: string): Promise<void> {
  const abs = path.join(VAULT_DIR, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
}

export async function removeVaultFile(relPath: string): Promise<void> {
  if (!relPath) return;
  const abs = path.join(VAULT_DIR, relPath);
  await fs.rm(abs, { force: true }).catch(() => undefined);
  // Drop the category folder once it's empty.
  const dir = path.dirname(abs);
  if (path.resolve(dir) !== path.resolve(ENTRIES_DIR)) {
    const left = await fs.readdir(dir).catch(() => null);
    if (left && left.length === 0) await fs.rmdir(dir).catch(() => undefined);
  }
}

/** All note files under entries/ (relative, posix). */
export async function listNoteFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) await walk(abs);
      else if (it.name.toLowerCase().endsWith('.md')) out.push(path.relative(VAULT_DIR, abs).split(path.sep).join('/'));
    }
  }
  await walk(ENTRIES_DIR);
  return out;
}

/** Same colors the web graph uses for the three kinds. */
export const KIND_COLORS: Record<KnowledgeKind, string> = { skill: '#3b82f6', preference: '#3fb950', data: '#d29922' };
/** Negative preferences ("don't do X") are drawn fully red. */
export const NEGATIVE_COLOR = '#f85149';

/** Minimal Obsidian config so the folder opens as a vault; the graph is colored by kind folder. */
export async function ensureObsidianConfig(): Promise<void> {
  const dir = path.join(VAULT_DIR, '.obsidian');
  await fs.mkdir(dir, { recursive: true });
  const readJson = async (name: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const app = await readJson('app.json');
  if (!app) {
    await fs.writeFile(
      path.join(dir, 'app.json'),
      JSON.stringify(
        {
          newFileLocation: 'folder',
          newFileFolderPath: `entries/${KIND_FOLDER.skill}`,
          useMarkdownLinks: false,
          newLinkFormat: 'shortest',
          alwaysUpdateLinks: true,
          showFrontmatter: true,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  // Keep the user's other graph settings; (re)write only our color groups.
  const graph = (await readJson('graph.json')) ?? { showTags: false, showAttachments: false, showOrphans: true };
  graph.colorGroups = [
    { query: '[polarity:negative]', color: { a: 1, rgb: parseInt(NEGATIVE_COLOR.slice(1), 16) } },
  ].concat((Object.keys(KIND_FOLDER) as KnowledgeKind[]).map((k) => ({
    query: `path:"entries/${KIND_FOLDER[k]}"`,
    color: { a: 1, rgb: parseInt(KIND_COLORS[k].slice(1), 16) },
  })));
  await fs.writeFile(path.join(dir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');
}

export function renderMoc(entries: Array<Pick<WikiEntry, 'title' | 'kind' | 'score' | 'polarity' | 'tags' | 'topics'>>): string {
  const parts = [
    '# 知识库目录',
    '',
    `> 由 Chapi 自动生成（${new Date().toISOString().slice(0, 10)}，${entries.length} 个知识点）。先按内容分类（每个知识点的第一个分类），再按类型（技能/偏好/数据）；同类按权重/置信度从高到低。可直接在 Obsidian 里编辑，保存后自动同步回 Chapi。`,
  ];
  const groups = new Map<string, typeof entries>();
  for (const e of entries) {
    const t = ((e.topics as unknown as string[] | null) ?? [])[0] || '未分类';
    groups.set(t, [...(groups.get(t) ?? []), e]);
  }
  const order = [...groups.keys()].sort((x, y) => groups.get(y)!.length - groups.get(x)!.length || x.localeCompare(y));
  for (const topic of order) {
    const inTopic = groups.get(topic)!;
    parts.push('', `## ${topic}（${inTopic.length}）`);
    for (const kind of ['skill', 'preference', 'data'] as KnowledgeKind[]) {
      const list = inTopic.filter((e) => kindOf(e.kind) === kind).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
      if (!list.length) continue;
      const scoreName = kind === 'data' ? '置信度' : '权重';
      parts.push(`### ${KIND_FOLDER[kind]}`);
      for (const e of list) {
        const pol = kind === 'preference' ? (e.polarity === 'negative' ? ' 👎' : ' 👍') : '';
        const others = ((e.topics as unknown as string[] | null) ?? []).slice(1);
        parts.push(`- ${wikiLink(e.title)} — ${scoreName} ${e.score}${pol}${others.length ? ` · 也属于：${others.join('、')}` : ''}`);
      }
    }
  }
  return parts.join('\n') + '\n';
}

/** Resolve `[[target]]` strings to entry ids (by file name, title or alias; case-insensitive). */
export function linkResolver(entries: Array<Pick<WikiEntry, 'id' | 'title' | 'aliases'>>): (target: string) => string | null {
  const map = new Map<string, string>();
  for (const e of entries) {
    for (const k of [e.title, safeFileName(e.title), ...(((e.aliases as unknown as string[] | null) ?? []))]) {
      const key = k.trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, e.id);
    }
  }
  return (t) => map.get(t.trim().toLowerCase()) ?? map.get(safeFileName(t).toLowerCase()) ?? null;
}

export function buildGraph(entries: WikiEntry[]): WikiGraphResponse {
  const resolve = linkResolver(entries);
  const links: WikiGraphResponse['links'] = [];
  const seen = new Set<string>();
  const degree = new Map<string, number>();
  for (const e of entries) {
    for (const t of extractLinks(e.bodyMd)) {
      const target = resolve(t);
      if (!target || target === e.id) continue;
      const key = `${e.id}>${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: e.id, target });
      degree.set(e.id, (degree.get(e.id) ?? 0) + 1);
      degree.set(target, (degree.get(target) ?? 0) + 1);
    }
  }
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(safeCategory(e.category), (counts.get(safeCategory(e.category)) ?? 0) + 1);
  const categories = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || a.localeCompare(b));
  const topicCount = new Map<string, number>();
  for (const e of entries) for (const t of (e.topics as unknown as string[] | null) ?? []) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
  return {
    topics: [...topicCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    nodes: entries.map((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      category: safeCategory(e.category),
      kind: kindOf(e.kind),
      topics: (e.topics as unknown as string[] | null) ?? [],
      score: e.score,
      polarity: e.polarity,
      tags: (e.tags as unknown as string[]) ?? [],
      degree: degree.get(e.id) ?? 0,
      updatedAt: e.updatedAt.toISOString(),
    })),
    links,
    categories,
    vaultPath: VAULT_DIR,
  };
}

/** Append (or extend) a "## 相关" section with links that aren't in the body yet. */
export function withRelatedSection(body: string, titles: string[]): string {
  const present = new Set(extractLinks(body).map((t) => t.toLowerCase()));
  const add = titles.filter((t) => !present.has(safeFileName(t).toLowerCase()) && !present.has(t.toLowerCase()));
  if (add.length === 0) return body;
  const lines = add.map((t) => `- ${wikiLink(t)}`).join('\n');
  const m = body.match(/\n## 相关[^\n]*\n/);
  if (m && m.index !== undefined) {
    // insert at the end of the existing section (before the next heading or EOF)
    const start = m.index + m[0].length;
    const next = body.slice(start).search(/\n#{1,2} /);
    const end = next === -1 ? body.length : start + next;
    return `${body.slice(0, end).replace(/\s*$/, '')}\n${lines}${body.slice(end)}`;
  }
  return `${body.replace(/\s*$/, '')}\n\n## 相关\n${lines}`;
}

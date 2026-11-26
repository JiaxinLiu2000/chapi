import { prisma } from '../db/client.js';
import { createLogger } from '../logger.js';

const log = createLogger('knowledge:tags');

/**
 * Canonical tag registry. Knowledge points carry tags (tool tags on skills,
 * scenario tags on preferences, topic tags on data); different spellings of the
 * same thing ("Google Sheets", "google_sheets", "#google-sheet") must collapse to
 * one tag so recall and the graph don't split. Every tag goes through
 * `canonicalize()` before it's stored; known spellings are cached in memory and
 * persisted in WikiTag.aliases.
 */

export type TagKind = 'tool' | 'scenario' | 'topic' | 'category';

/** Display form: trimmed, no '#', half-width, spaces/underscores → '-', latin lowercased. */
export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/^#+/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.,;:]+|[-.,;:]+$/g, '')
    .replace(/[A-Z]+/g, (m) => m.toLowerCase())
    .slice(0, 60);
}

/** Matching key: also ignores '-', '.', '/' and a latin plural 's' ("google-sheets" ≡ "googlesheet"). */
export function tagKey(raw: string): string {
  const n = normalizeTag(raw).replace(/[-./]/g, '');
  return /[a-z]{4,}s$/.test(n) ? n.slice(0, -1) : n;
}

/** Content categories keep their display form ("Tower II 租金竞品", "apartments.com") — only whitespace is tidied. */
export function normalizeCategory(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, 40);
}

/**
 * Two namespaces that never mix: content categories, and ordinary tags (tool /
 * scenario / topic). A category row is stored as `category:<name>` so it can share
 * a name with a tag ("cloakbrowser" the category vs. the tool tag).
 */
const CAT_PREFIX = 'category:';
const ns = (kind: TagKind) => (kind === 'category' ? 'c:' : 't:');
const display = (raw: string, kind: TagKind) => (kind === 'category' ? normalizeCategory(raw) : normalizeTag(raw));
const rowName = (canonical: string, kind: TagKind) => (kind === 'category' ? `${CAT_PREFIX}${canonical}` : canonical);

class TagRegistry {
  private byKey = new Map<string, string>(); // namespaced key → canonical
  private kinds = new Map<string, TagKind>(); // namespaced canonical → kind
  private loaded: Promise<void> | null = null;

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const rows = await prisma.wikiTag.findMany().catch(() => []);
      for (const r of rows) {
        const kind = r.kind as TagKind;
        const name = kind === 'category' ? r.name.replace(CAT_PREFIX, '') : r.name;
        this.kinds.set(ns(kind) + name, kind);
        this.byKey.set(ns(kind) + tagKey(name), name);
        for (const a of (r.aliases as unknown as string[]) ?? []) this.byKey.set(ns(kind) + tagKey(a), name);
      }
    })();
    return this.loaded;
  }

  /** Map tags to their canonical spelling, registering new ones (and new spellings as aliases). */
  async canonicalize(tags: string[], kind: TagKind): Promise<string[]> {
    await this.load();
    const out: string[] = [];
    for (const raw of tags) {
      const norm = display(raw, kind);
      if (!norm) continue;
      const key = ns(kind) + tagKey(norm);
      let canonical = this.byKey.get(key);
      if (!canonical) {
        canonical = norm;
        this.byKey.set(key, canonical);
        this.kinds.set(ns(kind) + canonical, kind);
        const name = rowName(canonical, kind);
        await prisma.wikiTag
          .upsert({ where: { name }, update: {}, create: { name, kind, aliases: [] } })
          .catch((e) => log.warn('tag create failed', e));
      } else if (canonical !== norm) {
        await this.addAlias(canonical, norm, kind);
      }
      if (!out.includes(canonical)) out.push(canonical);
    }
    return out;
  }

  /** Record that `alias` means `canonical` (e.g. from the learning agent or a manual merge). */
  async addAlias(canonical: string, alias: string, kind: TagKind = 'topic'): Promise<void> {
    await this.load();
    const norm = display(alias, kind);
    if (!norm || norm === canonical) return;
    this.byKey.set(ns(kind) + tagKey(norm), canonical);
    const name = rowName(canonical, kind);
    const row = await prisma.wikiTag.findUnique({ where: { name } }).catch(() => null);
    const aliases = new Set(((row?.aliases as unknown as string[]) ?? []).concat(norm));
    await prisma.wikiTag
      .upsert({
        where: { name },
        update: { aliases: [...aliases] },
        create: { name, kind: this.kinds.get(ns(kind) + canonical) ?? kind, aliases: [...aliases] },
      })
      .catch((e) => log.warn('tag alias failed', e));
  }

  /** Canonical tags (optionally of one kind) — shown to the learning agent so it reuses them. */
  async list(kind?: TagKind): Promise<string[]> {
    await this.load();
    return [...this.kinds.entries()]
      .filter(([, k]) => !kind || k === kind)
      .map(([n]) => n.slice(2))
      .sort();
  }

  /** Forget the cache (after bulk edits from another process). */
  reset(): void {
    this.byKey.clear();
    this.kinds.clear();
    this.loaded = null;
  }
}

export const tagRegistry = new TagRegistry();

export const TAG_KIND_FOR: Record<'data' | 'skill' | 'preference', TagKind> = {
  data: 'topic',
  skill: 'tool',
  preference: 'scenario',
};

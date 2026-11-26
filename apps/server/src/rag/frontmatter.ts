/**
 * Minimal YAML front-matter for Obsidian notes. Covers what Obsidian's
 * properties editor writes and what we emit: scalars (bare / "double" /
 * 'single' quoted), flow lists `[a, b]`, block lists of scalars, and block
 * lists of flat maps (our `sources`). Anything fancier is kept as a raw string.
 */

export type FmValue = string | number | boolean | null | FmValue[] | { [k: string]: FmValue };
export type Frontmatter = Record<string, FmValue>;

export function splitFrontmatter(text: string): { fm: string | null; body: string } {
  const t = text.replace(/^﻿/, '');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { fm: null, body: t };
  return { fm: m[1]!, body: t.slice(m[0].length) };
}

function unquote(raw: string): FmValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map((x) => unquote(x));
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Split a flow list body on commas outside quotes. */
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      cur += c;
      if (c === q && s[i - 1] !== '\\') q = null;
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const indentOf = (l: string) => l.length - l.trimStart().length;

export function parseFrontmatter(fm: string): Frontmatter {
  const lines = fm.split(/\r?\n/);
  const out: Frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_\-一-鿿 ]+):(.*)$/);
    if (!m || indentOf(line) > 0) {
      i++;
      continue;
    }
    const key = m[1]!.trim();
    const rest = m[2]!.trim();
    if (rest) {
      out[key] = unquote(rest);
      i++;
      continue;
    }
    // Block value: list items (possibly maps) indented below.
    const items: FmValue[] = [];
    i++;
    while (i < lines.length && (lines[i]!.trim() === '' || indentOf(lines[i]!) > 0 || lines[i]!.startsWith('-'))) {
      const l = lines[i]!;
      const lm = l.match(/^(\s*)-\s?(.*)$/);
      if (!lm) {
        i++;
        continue;
      }
      const itemIndent = lm[1]!.length;
      const first = lm[2]!;
      const kv = first.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
      if (kv && !first.startsWith('"') && !first.startsWith("'")) {
        const obj: Record<string, FmValue> = { [kv[1]!]: unquote(kv[2]!) };
        i++;
        while (i < lines.length) {
          const nl = lines[i]!;
          if (!nl.trim()) {
            i++;
            continue;
          }
          if (indentOf(nl) <= itemIndent || nl.trimStart().startsWith('- ')) break;
          const nkv = nl.trim().match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
          if (nkv) obj[nkv[1]!] = unquote(nkv[2]!);
          i++;
        }
        items.push(obj);
      } else {
        items.push(unquote(first));
        i++;
      }
    }
    out[key] = items;
  }
  return out;
}

function q(s: string): string {
  return JSON.stringify(s);
}

function emitScalar(v: FmValue): string {
  if (v === null) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return q(String(v));
}

export function serializeFrontmatter(fm: Frontmatter): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
        continue;
      }
      lines.push(`${k}:`);
      for (const item of v) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const entries = Object.entries(item).filter(([, x]) => x !== undefined && x !== null && x !== '');
          entries.forEach(([ik, iv], idx) => lines.push(`${idx === 0 ? '  - ' : '    '}${ik}: ${emitScalar(iv)}`));
        } else lines.push(`  - ${emitScalar(item)}`);
      }
    } else lines.push(`${k}: ${emitScalar(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

export function asString(v: FmValue | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v) || typeof v === 'object') return undefined;
  return String(v);
}

export function asStringList(v: FmValue | undefined): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((x): x is string => Boolean(x && x.trim()));
  const s = asString(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

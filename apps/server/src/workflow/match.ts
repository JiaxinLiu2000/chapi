/**
 * Does a user request name a confirmed SOP? Deterministic token matching against each
 * SOP's name and aliases — the main AI can't be trusted to remember the catalog in a
 * long conversation full of old habits (spec §5.1).
 *
 * Tokens: ASCII words (≥2 chars) and CJK bigrams (a lone CJK char counts as itself);
 * generic words ("更新", "sop", …) are ignored and plurals folded. An alias matches when ≥60% of its
 * tokens appear in the request AND at least two of them do (one word like "tracker"
 * is never enough).
 */

export interface SopRef {
  slug: string;
  name: string;
  aliases: string[];
}

// Generic words that never identify an SOP. CJK ones are cut out of the text before
// bigramming, so "客户画像表更新" doesn't yield a stray "表更" token.
const STOP = new Set(['sop', 'the', 'and', 'update', 'please']);
const CJK_STOP = ['更新', '周更', '一下', '帮我', '按照', '流程', '工作流', '执行', '一次', '再做', '做一下'];
// Words whose plural is a different thing ("Tracker Updates" column ≠ "update the tracker").
const NO_STEM = new Set(['updates', 'sales', 'analytics', 'business', 'news']);
const MIN_SCORE = 0.6;
const MIN_HITS = 2;

/** profiles → profile, trackers → tracker (light plural folding). */
function stem(w: string): string {
  if (NO_STEM.has(w) || w.length < 4 || !w.endsWith('s') || w.endsWith('ss')) return w;
  return w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.slice(0, -1);
}

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  let t = s.toLowerCase();
  for (const w of CJK_STOP) t = t.split(w).join(' ');
  for (const w of t.match(/[a-z0-9]+/g) ?? []) if (w.length >= 2 && !STOP.has(w)) out.add(stem(w));
  for (const run of t.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

export function matchSops(text: string, sops: SopRef[]): SopRef[] {
  const have = tokens(text);
  const scored: { sop: SopRef; score: number; hits: number }[] = [];
  for (const sop of sops) {
    let best = { score: 0, hits: 0 };
    for (const cand of [sop.name, ...sop.aliases]) {
      const want = tokens(cand);
      if (!want.size) continue;
      const hits = [...want].filter((w) => have.has(w)).length;
      const score = hits / want.size;
      if (hits >= MIN_HITS && score >= MIN_SCORE && (score > best.score || (score === best.score && hits > best.hits))) best = { score, hits };
    }
    if (best.hits) scored.push({ sop, ...best });
  }
  return scored.sort((a, b) => b.score - a.score || b.hits - a.hits).map((x) => x.sop);
}

import { registrableDomain } from './siteRecon.js';

/**
 * Confidence of a researched fact, from (1) how reliable each source is and
 * (2) how fresh it is, combined across independent sources that agree.
 *
 * Per source:   c = R × (0.5 + 0.5 × F)
 *   R  reliability by tier: official 0.95 · reputable 0.80 · aggregator 0.65 · community 0.40 · unknown 0.30
 *   F  freshness = 0.5 ^ (ageDays / halfLife); halfLife by how fast the fact changes:
 *      fast 90 d (prices, rents, listings, news, people in roles) · medium 365 d (company facts,
 *      annual stats) · slow 1825 d (history, laws in force, definitions). Unknown date → F = 0.5.
 *      So a perfectly fresh source keeps its full R, an ancient one keeps half of it.
 * Agreeing sources (one per registrable domain — copies on the same site count once):
 *   C = 1 − (1 − c₁) × Π(1 − 0.8 × cᵢ)   the strongest counts fully; others are discounted
 *   by 0.8 because "independent" web sources often share one upstream (MLS, a press release).
 * Contradicting sources:  C_final = C × (1 − 0.5 × C_against), capped at 0.99.
 * Label: ≥ 0.85 高 · ≥ 0.60 中 · else 低.
 */

export type SourceTier = 'official' | 'reputable' | 'aggregator' | 'community' | 'unknown';
export type Volatility = 'fast' | 'medium' | 'slow';

export const TIER_RELIABILITY: Record<SourceTier, number> = {
  official: 0.95,
  reputable: 0.8,
  aggregator: 0.65,
  community: 0.4,
  unknown: 0.3,
};

export const HALF_LIFE_DAYS: Record<Volatility, number> = { fast: 90, medium: 365, slow: 1825 };

const TIER_LABEL: Record<SourceTier, string> = {
  official: '官方/一手',
  reputable: '权威媒体/学术/行业数据库',
  aggregator: '主流平台/聚合站',
  community: '论坛/博客/社交',
  unknown: '未知来源',
};

const REPUTABLE = [
  'reuters.com', 'bloomberg.com', 'wsj.com', 'nytimes.com', 'ft.com', 'apnews.com', 'bbc.co.uk', 'bbc.com',
  'cnbc.com', 'economist.com', 'latimes.com', 'washingtonpost.com', 'forbes.com', 'businessinsider.com',
  'therealdeal.com', 'bisnow.com', 'globest.com', 'multihousingnews.com', 'costar.com', 'nmhc.org',
  'sciencedirect.com', 'nature.com', 'springer.com', 'jstor.org', 'nih.gov', 'statista.com', 'pewresearch.org',
  'sec.gov', 'census.gov', 'bls.gov', 'hud.gov', 'federalreserve.gov', 'worldbank.org', 'imf.org', 'oecd.org',
];
const AGGREGATOR = [
  'zillow.com', 'redfin.com', 'apartments.com', 'realtor.com', 'trulia.com', 'rent.com', 'rentcafe.com',
  'zumper.com', 'hotpads.com', 'loopnet.com', 'crexi.com', 'wikipedia.org', 'crunchbase.com', 'linkedin.com',
  'yelp.com', 'glassdoor.com', 'indeed.com', 'zoominfo.com', 'rocketreach.co', 'pitchbook.com', 'bizjournals.com',
  'yahoo.com', 'msn.com', 'google.com', 'apple.com', 'propertyshark.com', 'hellodata.ai', 'niche.com',
];
const COMMUNITY = [
  'reddit.com', 'quora.com', 'medium.com', 'substack.com', 'twitter.com', 'x.com', 'facebook.com',
  'instagram.com', 'tiktok.com', 'youtube.com', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'pinterest.com',
  'stackexchange.com', 'stackoverflow.com', 'biggerpockets.com', 'city-data.com', 'nextdoor.com',
];

/** Best guess of a source's tier from its URL; the agent should override (e.g. a company's own site = official). */
export function inferTier(url: string): SourceTier {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  const dom = registrableDomain(host);
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(host) || /\.gov\.[a-z]{2}$/.test(host)) return 'official';
  if (dom === 'sec.gov' || dom === 'census.gov') return 'official';
  if (REPUTABLE.includes(dom)) return 'reputable';
  if (/\.edu$|\.ac\.[a-z]{2}$/.test(host)) return 'reputable';
  if (AGGREGATOR.includes(dom)) return 'aggregator';
  if (COMMUNITY.includes(dom)) return 'community';
  return 'unknown';
}

/** Parse YYYY, YYYY-MM, YYYY-MM-DD (or anything Date understands). */
export function parseSourceDate(s?: string | null): Date | null {
  if (!s) return null;
  const t = s.trim();
  let m = t.match(/^(\d{4})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), 6, 1)); // mid-year
  m = t.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15));
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function freshness(date: Date | null, volatility: Volatility, now = new Date()): number {
  if (!date) return 0.5;
  const ageDays = Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS[volatility]);
}

export interface SourceInput {
  url: string;
  title?: string;
  publishedAt?: string;
  tier?: SourceTier;
  /** false = this source reports a different value (contradicts the claim). */
  agrees?: boolean;
}

export interface ClaimInput {
  claim: string;
  value?: string;
  volatility?: Volatility;
  sources: SourceInput[];
}

export interface ScoredSource {
  url: string;
  domain: string;
  tier: SourceTier;
  reliability: number;
  freshness: number;
  confidence: number;
  agrees: boolean;
  ageDays: number | null;
}

export interface ScoredClaim {
  claim: string;
  value?: string;
  confidence: number;
  label: '高' | '中' | '低';
  independentSources: number;
  against: number;
  sources: ScoredSource[];
}

export function labelFor(c: number): '高' | '中' | '低' {
  return c >= 0.85 ? '高' : c >= 0.6 ? '中' : '低';
}

/** Noisy-OR with the strongest source at full weight and the rest discounted. */
function combine(cs: number[]): number {
  if (cs.length === 0) return 0;
  const sorted = [...cs].sort((a, b) => b - a);
  let miss = 1 - sorted[0]!;
  for (const c of sorted.slice(1)) miss *= 1 - 0.8 * c;
  return 1 - miss;
}

/** Keep the most confident source per registrable domain. */
function bestPerDomain(list: ScoredSource[]): ScoredSource[] {
  const by = new Map<string, ScoredSource>();
  for (const s of list) {
    const cur = by.get(s.domain);
    if (!cur || s.confidence > cur.confidence) by.set(s.domain, s);
  }
  return [...by.values()];
}

export function scoreClaim(input: ClaimInput, now = new Date()): ScoredClaim {
  const vol = input.volatility ?? 'medium';
  const scored: ScoredSource[] = input.sources.map((s) => {
    const tier = s.tier ?? inferTier(s.url);
    const date = parseSourceDate(s.publishedAt);
    const R = TIER_RELIABILITY[tier];
    const F = freshness(date, vol, now);
    let domain = s.url;
    try {
      domain = registrableDomain(new URL(s.url).hostname);
    } catch {
      /* keep raw */
    }
    return {
      url: s.url,
      domain,
      tier,
      reliability: R,
      freshness: F,
      confidence: R * (0.5 + 0.5 * F),
      agrees: s.agrees !== false,
      ageDays: date ? Math.round(Math.max(0, now.getTime() - date.getTime()) / 86_400_000) : null,
    };
  });
  const pro = bestPerDomain(scored.filter((s) => s.agrees));
  const con = bestPerDomain(scored.filter((s) => !s.agrees));
  const cPro = combine(pro.map((s) => s.confidence));
  const cCon = combine(con.map((s) => s.confidence));
  const c = Math.min(0.99, cPro * (1 - 0.5 * cCon));
  return {
    claim: input.claim,
    value: input.value,
    confidence: c,
    label: labelFor(c),
    independentSources: pro.length,
    against: con.length,
    sources: scored,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function formatScoredClaim(s: ScoredClaim): string {
  const head = `${s.claim}${s.value ? ` = ${s.value}` : ''} → 置信度 ${pct(s.confidence)}（${s.label}）· ${s.independentSources} 个独立来源支持${
    s.against ? ` · ${s.against} 个来源矛盾` : ''
  }${s.independentSources < 3 ? ' · ⚠️ 来源不足 3 个，能找就再找' : ''}`;
  const rows = s.sources.map(
    (x) =>
      `  - ${x.agrees ? '✓' : '✗'} ${x.domain} [${TIER_LABEL[x.tier]} R=${x.reliability}] ${
        x.ageDays === null ? '日期未知' : `${x.ageDays} 天前`
      } F=${x.freshness.toFixed(2)} → ${pct(x.confidence)}  ${x.url}`,
  );
  return [head, ...rows].join('\n');
}

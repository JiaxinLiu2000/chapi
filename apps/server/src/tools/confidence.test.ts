import { describe, expect, it } from 'vitest';
import { freshness, inferTier, parseSourceDate, scoreClaim } from './confidence.js';
import { classify, registrableDomain, type ProbeResult } from './siteRecon.js';

const NOW = new Date('2026-10-20T00:00:00Z');

describe('confidence', () => {
  it('infers tiers from domains', () => {
    expect(inferTier('https://www.census.gov/x')).toBe('official');
    expect(inferTier('https://www.reuters.com/a')).toBe('reputable');
    expect(inferTier('https://www.zillow.com/b')).toBe('aggregator');
    expect(inferTier('https://old.reddit.com/r/x')).toBe('community');
    expect(inferTier('https://some-blog.net')).toBe('unknown');
  });

  it('decays freshness by half-life and penalizes unknown dates', () => {
    expect(freshness(new Date('2026-07-22T00:00:00Z'), 'fast', NOW)).toBeCloseTo(0.5, 2);
    expect(freshness(null, 'slow', NOW)).toBe(0.5);
    expect(parseSourceDate('2025')?.getUTCMonth()).toBe(6);
  });

  it('a single fresh official source is high; stale fast data drops to about half', () => {
    const fresh = scoreClaim({ claim: 'x', volatility: 'fast', sources: [{ url: 'https://hud.gov/a', publishedAt: '2026-10-01' }] }, NOW);
    expect(fresh.label).toBe('高');
    const stale = scoreClaim({ claim: 'x', volatility: 'fast', sources: [{ url: 'https://hud.gov/a', publishedAt: '2023-01-01' }] }, NOW);
    expect(stale.confidence).toBeGreaterThan(0.47);
    expect(stale.confidence).toBeLessThan(0.5);
  });

  it('stacks agreeing independent sources, counts one domain once', () => {
    const one = scoreClaim({ claim: 'rent', volatility: 'fast', sources: [{ url: 'https://zillow.com/a', publishedAt: '2026-10-10' }] }, NOW);
    const three = scoreClaim(
      {
        claim: 'rent',
        volatility: 'fast',
        sources: [
          { url: 'https://zillow.com/a', publishedAt: '2026-10-10' },
          { url: 'https://www.zillow.com/b', publishedAt: '2026-10-10' },
          { url: 'https://apartments.com/c', publishedAt: '2026-10-12' },
          { url: 'https://redfin.com/d', publishedAt: '2026-10-15' },
        ],
      },
      NOW,
    );
    expect(three.independentSources).toBe(3);
    expect(three.confidence).toBeGreaterThan(one.confidence + 0.2);
    expect(three.label).toBe('高');
  });

  it('contradicting sources reduce confidence', () => {
    const base = { claim: 'units', volatility: 'medium' as const };
    const agree = scoreClaim({ ...base, sources: [{ url: 'https://a.com', tier: 'reputable' }, { url: 'https://b.com', tier: 'reputable' }] }, NOW);
    const conflict = scoreClaim(
      { ...base, sources: [{ url: 'https://a.com', tier: 'reputable' }, { url: 'https://b.com', tier: 'reputable' }, { url: 'https://c.com', tier: 'official', agrees: false }] },
      NOW,
    );
    expect(conflict.confidence).toBeLessThan(agree.confidence);
    expect(conflict.against).toBe(1);
  });
});

const probe = (p: Partial<ProbeResult>): ProbeResult => ({
  url: 'https://example.com/',
  finalUrl: 'https://example.com/',
  status: 200,
  headers: {},
  setCookies: [],
  body: '<html><body>' + 'content '.repeat(400) + '</body></html>',
  elapsedMs: 100,
  ...p,
});

describe('site recon classifier', () => {
  it('registrable domain handles www and two-level suffixes', () => {
    expect(registrableDomain('www.apartments.com')).toBe('apartments.com');
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('plain unprotected site is L0 and reachable', () => {
    const v = classify(probe({}));
    expect(v.level).toBe(0);
    expect(v.contentReachable).toBe(true);
  });

  it('cloudflare CDN without challenge is L1, challenge page is L3', () => {
    expect(classify(probe({ headers: { server: 'cloudflare', 'cf-ray': 'x' } })).level).toBe(1);
    const ch = classify(
      probe({ status: 403, headers: { server: 'cloudflare', 'cf-ray': 'x' }, body: '<title>Just a moment...</title>' }),
    );
    expect(ch.level).toBe(3);
    expect(ch.contentReachable).toBe(false);
  });

  it('akamai sensor cookies are L2, known strict domains are L3', () => {
    expect(classify(probe({ setCookies: ['_abck=abc; path=/', 'bm_sz=1'] })).level).toBe(2);
    expect(classify(probe({ url: 'https://www.apartments.com/', finalUrl: 'https://www.apartments.com/' })).level).toBe(3);
  });

  it('json endpoints and embedded data are surfaced as data hints', () => {
    const v = classify(probe({ headers: { 'content-type': 'application/json' }, body: '{"a":1}' }));
    expect(v.level).toBe(0);
    expect(v.dataHints[0]).toContain('JSON');
    const n = classify(probe({ body: '<script id="__NEXT_DATA__" type="application/json">{}</script>' + 'x '.repeat(1000) }));
    expect(n.dataHints.some((d) => d.includes('__NEXT_DATA__'))).toBe(true);
  });

  it('reads crawl-delay from robots.txt', () => {
    const v = classify(probe({}), 'User-agent: *\nCrawl-delay: 10\nDisallow: /private');
    expect(v.robots).toEqual({ crawlDelay: 10, disallowsAll: false });
    expect(v.level).toBe(1);
  });
});

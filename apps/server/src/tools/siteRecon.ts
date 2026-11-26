import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('tools:siteRecon');

/**
 * Anti-bot reconnaissance: before scraping a site, look at how hard it defends
 * itself and pick the cheapest strategy that will still work — call a public
 * API / plain HTTP for unprotected sites, escalate to the human-paced
 * cloakbrowser protocol only for sites with real bot management.
 *
 *   L0 none      plain HTTP returns full content, no bot vendor       → API/HTTP directly, high concurrency, no delays
 *   L1 light     CDN / rate-limit headers, no challenge               → HTTP client with browser headers, small jitter, backoff on 429
 *   L2 medium    bot vendor present but not challenging, or JS-only   → cloakbrowser, deep links OK, 1–3 s jitter, one page
 *   L3 strong    challenge / block from Akamai, DataDome, PX, Kasada…  → full human-like protocol (warmup, click in, click next, slow)
 */

export type AntiBotLevel = 0 | 1 | 2 | 3;

export interface ProbeResult {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
  body: string;
  elapsedMs: number;
  error?: string;
}

export interface Signal {
  vendor: string;
  detail: string;
  /** Minimum level this signal implies. */
  level: AntiBotLevel;
}

export interface ReconVerdict {
  domain: string;
  level: AntiBotLevel;
  vendors: string[];
  signals: Signal[];
  contentReachable: boolean;
  dataHints: string[];
  robots: { crawlDelay: number | null; disallowsAll: boolean } | null;
}

/** Sites known to run aggressive bot management (seen blocking us or widely documented). */
const KNOWN_STRICT: Record<string, string> = {
  'apartments.com': 'Akamai Bot Manager',
  'zillow.com': 'PerimeterX/HUMAN',
  'redfin.com': 'bot management + rate limits',
  'realtor.com': 'Kasada',
  'linkedin.com': 'login wall + behavioral detection',
  'indeed.com': 'Cloudflare challenge',
  'google.com': 'reCAPTCHA (/sorry/) on automated search',
  'rocketreach.co': 'Cloudflare + account limits',
  'costar.com': 'Akamai',
  'loopnet.com': 'Akamai',
  'trulia.com': 'PerimeterX/HUMAN',
  'craigslist.org': 'IP rate limiting',
};

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  // co.uk / com.au style second-level suffixes
  const sld = parts[parts.length - 2]!;
  if (['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(sld) && parts[parts.length - 1]!.length === 2) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

const has = (s: string, re: RegExp) => re.test(s);

/** Pure classifier over one plain-HTTP probe (unit-tested). */
export function classify(p: ProbeResult, robotsTxt?: string | null): ReconVerdict {
  const host = (() => {
    try {
      return new URL(p.finalUrl || p.url).hostname;
    } catch {
      return p.url;
    }
  })();
  const domain = registrableDomain(host);
  const h = p.headers;
  const cookies = p.setCookies.join('\n').toLowerCase();
  const body = p.body.slice(0, 400_000);
  const lower = body.toLowerCase();
  const signals: Signal[] = [];
  const add = (vendor: string, detail: string, level: AntiBotLevel) => signals.push({ vendor, detail, level });
  const blocked = p.status === 403 || p.status === 429 || p.status === 503 || p.status === 401;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Vendors inject their sensor scripts into normal pages too — a marker only
  // means "challenged" when the page is blocked or has next to no content.
  const thin = blocked || text.length < 2000;

  // ── Cloudflare
  const cf = (h.server ?? '').toLowerCase().includes('cloudflare') || 'cf-ray' in h;
  const cfChallenge =
    has(lower, /<title>just a moment\.\.\.|attention required! \| cloudflare|cf_chl_opt/) ||
    (thin && has(lower, /cf-chl-|challenge-platform/)) ||
    h['cf-mitigated'] === 'challenge';
  if (cfChallenge) add('Cloudflare', '返回了 JS/人机验证挑战页', 3);
  else if (cf && cookies.includes('__cf_bm')) add('Cloudflare', 'Bot Management cookie __cf_bm（未触发挑战）', 2);
  else if (cf) add('Cloudflare', 'CDN（未见挑战）', blocked ? 3 : 1);

  // ── Akamai Bot Manager
  const akCookie = /(^|\n|;\s*)(_abck|bm_sz|ak_bmsc|bm_sv|bm_mi)=/.test(cookies);
  const akServer = (h.server ?? '').toLowerCase().includes('akamai');
  const akDenied = has(lower, /access denied[\s\S]{0,400}reference #|errors\.edgesuite\.net/);
  if (akDenied) add('Akamai', '返回 Akamai "Access Denied" 拦截页', 3);
  else if (akCookie) add('Akamai', 'Bot Manager 传感器 cookie（_abck/bm_sz）', blocked ? 3 : 2);
  else if (akServer) add('Akamai', 'Akamai 边缘服务器', 1);

  // ── DataDome
  if (cookies.includes('datadome=') || 'x-datadome' in h || lower.includes('captcha-delivery.com'))
    add('DataDome', lower.includes('captcha-delivery.com') || blocked ? '返回 DataDome 验证码' : 'DataDome cookie', blocked || lower.includes('captcha-delivery.com') ? 3 : 2);

  // ── PerimeterX / HUMAN
  if (/(^|\n|;\s*)_px(hd|vid|3|2)?=/.test(cookies) || has(lower, /px-captcha|perimeterx|human security|_pxappid/))
    add('PerimeterX/HUMAN', has(lower, /px-captcha|press & hold/) ? '返回 "Press & Hold" 验证' : 'PX 传感器', has(lower, /px-captcha|press & hold/) || blocked ? 3 : 2);

  // ── Kasada
  if (Object.keys(h).some((k) => k.startsWith('x-kpsdk')) || lower.includes('kpsdk'))
    add('Kasada', 'Kasada 挑战', 3);

  // ── Imperva / Incapsula
  if (cookies.includes('incap_ses_') || cookies.includes('visid_incap_') || 'x-iinfo' in h || lower.includes('_incapsula_resource')) {
    const challenged = thin && lower.includes('_incapsula_resource');
    add('Imperva', challenged ? '返回 Incapsula 挑战' : 'Imperva 传感器 cookie/脚本（未触发挑战）', challenged ? 3 : 2);
  }

  // ── AWS WAF
  if (cookies.includes('aws-waf-token') || Object.keys(h).some((k) => k.startsWith('x-amzn-waf')) || lower.includes('awswaf'))
    add('AWS WAF', 'AWS WAF / bot control', blocked ? 3 : 2);

  // ── Generic captcha / rate limit / blocks
  if (has(lower, /g-recaptcha|recaptcha\/api\.js|hcaptcha\.com\/1\/api|turnstile\/v0/) && !signals.some((s) => s.level === 3))
    add('Captcha', '页面嵌有 reCAPTCHA/hCaptcha/Turnstile', 2);
  if (p.status === 429 || 'retry-after' in h) add('Rate limit', `HTTP ${p.status}${h['retry-after'] ? `，Retry-After=${h['retry-after']}` : ''}`, 2);
  else if (Object.keys(h).some((k) => k.startsWith('x-ratelimit') || k === 'ratelimit-limit'))
    add('Rate limit', '响应带限流头（x-ratelimit-*）', 1);
  if ((p.status === 403 || p.status === 401) && !signals.some((s) => s.level === 3))
    add('Block', `纯 HTTP 请求被拒（HTTP ${p.status}）`, 3);
  if (p.finalUrl && /\/sorry\/|\/captcha|\/blocked|\/challenge/i.test(new URL(p.finalUrl, p.url).pathname))
    add('Block', `被重定向到拦截页 ${p.finalUrl}`, 3);
  if (p.error) add('Network', `纯 HTTP 请求失败：${p.error}`, 2);

  const known = KNOWN_STRICT[domain];
  if (known) add('Known', `已知强反爬站点（${known}）`, 3);

  // ── Is the content actually there without a browser?
  const isJson = (h['content-type'] ?? '').includes('json');
  const dataHints: string[] = [];
  if (isJson) dataHints.push('URL 本身返回 JSON —— 直接当 API 调用');
  if (lower.includes('id="__next_data__"')) dataHints.push('Next.js：页面内嵌 __NEXT_DATA__ JSON（可直接解析，或调 /_next/data/<buildId>/…json）');
  if (lower.includes('application/ld+json')) dataHints.push('有 JSON-LD 结构化数据（schema.org）');
  if (/window\.__(initial_state|preloaded_state|apollo_state|nuxt)__/i.test(body)) dataHints.push('页面内嵌初始状态 JSON（__INITIAL_STATE__/__APOLLO_STATE__/__NUXT__）');
  if (lower.includes('/wp-json/')) dataHints.push('WordPress REST API（/wp-json/wp/v2/…）');
  if (lower.includes('cdn.shopify.com')) dataHints.push('Shopify：/products.json、/collections/<x>/products.json');
  if (lower.includes('/graphql')) dataHints.push('页面引用 /graphql 端点');
  if (/["'](\/api\/[a-z0-9/_-]{2,})/i.test(body)) dataHints.push(`页面引用内部 API（如 ${body.match(/["'](\/api\/[a-z0-9/_-]{2,})/i)![1]}）`);
  const spaShell = text.length < 600 && /<div id="(root|app|__next)"/i.test(body);
  if (spaShell) dataHints.push('纯前端渲染的空壳页：内容靠 JS/XHR 加载 → 在浏览器里看 Network 找 JSON 接口');
  const contentReachable =
    p.status >= 200 && p.status < 300 && !p.error && (isJson || text.length >= 1500 || (!spaShell && text.length >= 80)) &&
    !signals.some((s) => s.level === 3 && s.vendor !== 'Known');

  let robots: ReconVerdict['robots'] = null;
  if (robotsTxt) {
    const star = robotsTxt.split(/\n(?=user-agent:)/i).find((b) => /user-agent:\s*\*/i.test(b)) ?? '';
    const delay = star.match(/crawl-delay:\s*([\d.]+)/i);
    robots = { crawlDelay: delay ? Number(delay[1]) : null, disallowsAll: /disallow:\s*\/\s*(\n|$)/i.test(star) };
    if (robots.crawlDelay && robots.crawlDelay >= 5) add('robots.txt', `Crawl-delay ${robots.crawlDelay}s`, 1);
  }

  let level: AntiBotLevel = signals.reduce<AntiBotLevel>((m, s) => (s.level > m ? s.level : m), 0);
  // Reachable but rendered client-side only → needs a browser (or its XHR API).
  if (level < 2 && !contentReachable && spaShell && !dataHints.some((d) => d.startsWith('URL 本身'))) level = Math.max(level, 1) as AntiBotLevel;
  if (level === 0 && !contentReachable && !p.error && p.status >= 400) level = 2;

  return {
    domain,
    level,
    vendors: [...new Set(signals.filter((s) => !['Known', 'Rate limit', 'Block', 'Network', 'robots.txt', 'Captcha'].includes(s.vendor)).map((s) => s.vendor))],
    signals,
    contentReachable,
    dataHints,
    robots,
  };
}

export const STRATEGY: Record<AntiBotLevel, { name: string; method: string; concurrency: string; delay: string; rules: string[] }> = {
  0: {
    name: 'L0 无防护',
    method: '直接调 API / 纯 HTTP（httpx/requests 或 Node fetch），**不需要浏览器**',
    concurrency: '同域 4–8 并发',
    delay: '无需人为延时（≤0.2s 即可）',
    rules: ['优先找 JSON 接口/内嵌数据，跳过渲染网页', '仍遵守 robots.txt；遇到 429/503 立即指数退避并降为 L1'],
  },
  1: {
    name: 'L1 轻度',
    method: '纯 HTTP 客户端 + 真实浏览器请求头（UA/Accept-Language/Referer），可直接请求深层 URL 和 API',
    concurrency: '同域 2–3 并发',
    delay: '每请求随机 0.5–1.5s',
    rules: ['遇 429 按 Retry-After / 指数退避', '连续出现 403/挑战页 → 升级为 L2（site_recon 报告 blocked）'],
  },
  2: {
    name: 'L2 中度',
    method: 'cloakbrowser（chapi_browser）渲染；可直接 goto 深层 URL / 拼分页参数；也可在浏览器里拦截 XHR JSON',
    concurrency: '单页面顺序（浏览器单驱动）',
    delay: '每页随机 1–3s，每 20–30 页长停 10–20s',
    rules: ['不必全程拟人点进，但别瞬间连跳', '被挑战/验证码 → 立即升级 L3 并报告 blocked'],
  },
  3: {
    name: 'L3 强',
    method: 'cloakbrowser + **完整拟人协议**：warmup 首页 → human_click 点进详情 → click_next 翻页',
    concurrency: '单页面顺序，绝不并发',
    delay: '动作间 human_pause（0.6–2.4s）、每页 3–8s，长批量中途长停',
    rules: ['绝不冷 goto 深层详情 URL、绝不拼 ?page=N', '先小批（≤3 页）验证不被封再放量', '验证码/拦截 → 停手、降速或 ask_user'],
  },
};

// ── Per-domain profile cache (data/site-profiles.json) ─────────────────────

interface SiteProfile {
  domain: string;
  level: AntiBotLevel;
  vendors: string[];
  checkedAt: string;
  /** Escalated after a real block reported by the agent; sticky for 30 days. */
  blockedAt?: string;
  note?: string;
}

const PROFILE_TTL_MS = 7 * 86_400_000;
const BLOCK_STICKY_MS = 30 * 86_400_000;

function profilesFile(): string {
  return path.join(config.paths.data, 'site-profiles.json');
}

async function loadProfiles(): Promise<Record<string, SiteProfile>> {
  try {
    return JSON.parse(await fs.readFile(profilesFile(), 'utf8')) as Record<string, SiteProfile>;
  } catch {
    return {};
  }
}

async function saveProfiles(p: Record<string, SiteProfile>): Promise<void> {
  await fs.mkdir(path.dirname(profilesFile()), { recursive: true });
  await fs.writeFile(profilesFile(), JSON.stringify(p, null, 2), 'utf8');
}

const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

async function probe(url: string, timeoutMs = 15_000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const body = (await res.text()).slice(0, 600_000);
    return { url, finalUrl: res.url, status: res.status, headers, setCookies, body, elapsedMs: Date.now() - started };
  } catch (e) {
    return {
      url,
      finalUrl: url,
      status: 0,
      headers: {},
      setCookies: [],
      body: '',
      elapsedMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function fetchRobots(origin: string): Promise<string | null> {
  try {
    const r = await fetch(`${origin}/robots.txt`, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return null;
    const t = await r.text();
    return /user-agent/i.test(t) ? t.slice(0, 50_000) : null;
  } catch {
    return null;
  }
}

/** Probe a URL (or reuse a fresh cached profile) and describe the strategy to use. */
export async function siteRecon(
  url: string,
  opts: { report?: 'blocked' | 'ok'; note?: string; refresh?: boolean } = {},
): Promise<string> {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return `无效 URL：${url}`;
  }
  const domain = registrableDomain(u.hostname);
  const profiles = await loadProfiles();
  const prev = profiles[domain];

  if (opts.report) {
    const base = prev ?? { domain, level: 1 as AntiBotLevel, vendors: [], checkedAt: new Date().toISOString() };
    if (opts.report === 'blocked') {
      base.level = Math.min(3, base.level + 1) as AntiBotLevel;
      base.blockedAt = new Date().toISOString();
    } else if (opts.report === 'ok' && base.blockedAt) {
      // Worked fine at this level; keep the level but stop treating it as freshly blocked.
      delete base.blockedAt;
    }
    if (opts.note) base.note = opts.note.slice(0, 300);
    profiles[domain] = base;
    await saveProfiles(profiles);
    return `已记录 ${domain}：${opts.report === 'blocked' ? `被拦截 → 升级为 ${STRATEGY[base.level].name}` : '当前策略可用'}。\n${formatStrategy(base.level)}`;
  }

  const fresh = prev && Date.now() - Date.parse(prev.checkedAt) < PROFILE_TTL_MS;
  if (fresh && !opts.refresh) {
    return `${domain}（缓存，${prev.checkedAt.slice(0, 10)} 侦察）：${STRATEGY[prev.level].name}${
      prev.vendors.length ? ` · ${prev.vendors.join(', ')}` : ''
    }${prev.blockedAt ? ` · ${prev.blockedAt.slice(0, 10)} 曾被拦截` : ''}${prev.note ? `\n备注：${prev.note}` : ''}\n${formatStrategy(prev.level)}\n（需要重新侦察传 refresh=true）`;
  }

  const [p, robots] = await Promise.all([probe(u.toString()), fetchRobots(u.origin)]);
  const v = classify(p, robots);
  let level = v.level;
  if (prev?.blockedAt && Date.now() - Date.parse(prev.blockedAt) < BLOCK_STICKY_MS && prev.level > level) {
    level = prev.level; // a real block beats an optimistic probe
  }
  profiles[domain] = {
    domain,
    level,
    vendors: v.vendors,
    checkedAt: new Date().toISOString(),
    ...(prev?.blockedAt ? { blockedAt: prev.blockedAt } : {}),
    ...(prev?.note ? { note: prev.note } : {}),
  };
  await saveProfiles(profiles).catch((e) => log.warn('save site profiles failed', e));

  const lines = [
    `${domain} 反爬等级：**${STRATEGY[level].name}**${level !== v.level ? `（探测为 L${v.level}，但近期曾被拦截，按 L${level} 处理）` : ''}`,
    `纯 HTTP 探测：HTTP ${p.status || '失败'} · ${p.elapsedMs}ms · ${p.body.length} 字节 · 内容${v.contentReachable ? '可直接拿到' : '拿不到/不完整'}`,
    v.signals.length ? `信号：\n${v.signals.map((s) => `- ${s.vendor}：${s.detail}（≥L${s.level}）`).join('\n')}` : '信号：未发现任何反爬厂商/挑战/限流迹象',
    v.dataHints.length ? `数据入口线索：\n${v.dataHints.map((d) => `- ${d}`).join('\n')}` : '',
    v.robots ? `robots.txt：${v.robots.disallowsAll ? '禁止所有爬虫（User-agent: *  Disallow: /）' : '允许'}${v.robots.crawlDelay ? `，Crawl-delay ${v.robots.crawlDelay}s` : ''}` : '',
    formatStrategy(level),
    '注：纯 HTTP 能过不代表高频也能过——放量前先小批验证；中途被拦截请调用 site_recon(url, report="blocked") 升级等级。',
  ];
  return lines.filter(Boolean).join('\n');
}

function formatStrategy(level: AntiBotLevel): string {
  const s = STRATEGY[level];
  return [`建议策略（${s.name}）：`, `- 方式：${s.method}`, `- 并发：${s.concurrency}`, `- 延时：${s.delay}`, ...s.rules.map((r) => `- ${r}`)].join('\n');
}

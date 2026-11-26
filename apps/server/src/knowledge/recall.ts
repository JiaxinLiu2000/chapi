import type { WikiEntry } from '@prisma/client';
import { KNOWLEDGE_KIND_LABEL, type KnowledgeKind } from '@chapi/shared';
import { searchKnowledge } from '../rag/wiki.js';

/**
 * "Read the vault before acting": the knowledge graph is pushed to the agent at
 * the moments it matters (a new user request, planning, a step going wrong, a
 * sub-agent starting, first use of a tool) instead of hoping it remembers to
 * search. Points come relevance-filtered and strongest (weight / confidence) first.
 */

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function formatPoint(e: WikiEntry, detail = 220): string {
  const kind = (e.kind as KnowledgeKind) ?? 'skill';
  const label = KNOWLEDGE_KIND_LABEL[kind] ?? '技能';
  const score = kind === 'data' ? `置信度${e.score}` : `权重${e.score}`;
  const pol = kind === 'preference' ? (e.polarity === 'negative' ? '·避免' : '·期望') : '';
  const when = clip(e.situation, 90);
  const what = clip(e.solution, detail);
  const date = kind === 'data' && e.observedAt ? ` · ${e.observedAt.toISOString().slice(0, 10)}` : '';
  const topics = ((e.topics as unknown as string[] | null) ?? []).filter((t) => t !== '未分类');
  return `- [${topics.length ? `${topics.join('/')}·` : ''}${label}·${score}${pol}] ${e.title}${when ? `｜前提：${when}` : ''}${what ? `｜${kind === 'data' ? '数据' : '做法'}：${what}` : ''}${date}`;
}

export async function recallBlock(
  query: string,
  opts: { heading: string; kinds?: KnowledgeKind[]; k?: number; tags?: string[]; minRelevance?: number } = { heading: '' },
): Promise<string | null> {
  const kinds = opts.kinds ?? ['preference', 'skill', 'data'];
  const per = Math.max(2, Math.ceil((opts.k ?? 8) / kinds.length) + 1);
  const hits = (
    await Promise.all(kinds.map((kind) => searchKnowledge(query, { kind, k: per, tags: opts.tags, minRelevance: opts.minRelevance })))
  ).flat();
  if (!hits.length) return null;
  const top = hits
    .sort((a, b) => b.entry.score - a.entry.score || b.relevance - a.relevance)
    .slice(0, opts.k ?? 8);
  return [
    `${opts.heading}（来自知识图谱，按权重/置信度排序；与用户本轮明确要求冲突时以用户为准；需要细节用 wiki_read 读全文）`,
    ...top.map((h) => formatPoint(h.entry)),
  ].join('\n');
}

/** Tool families → the query/tags used to recall skill points on their first use in a run. */
export function toolFamily(toolName: string, input: unknown): { key: string; query: string } | null {
  const cmd = typeof (input as { command?: unknown })?.command === 'string' ? String((input as { command: string }).command) : '';
  if (toolName.startsWith('mcp__google_workspace__')) {
    const t = toolName.replace('mcp__google_workspace__', '');
    const fam = /sheet/.test(t) ? 'google-sheets' : /doc/.test(t) ? 'google-docs' : /gmail|draft|mail/.test(t) ? 'gmail' : /drive/.test(t) ? 'google-drive' : 'google-workspace';
    return { key: fam, query: `${fam} google workspace ${t.replace(/_/g, ' ')}` };
  }
  if (toolName.startsWith('mcp__gmail__')) {
    const t = toolName.replace('mcp__gmail__', '');
    return { key: 'gmail', query: `gmail google workspace ${t.replace(/_/g, ' ')}` };
  }
  if (toolName === 'Bash') {
    if (/chapi_browser|playwright|cloakbrowser/.test(cmd)) return { key: 'cloakbrowser', query: 'cloakbrowser chapi_browser playwright 抓取 浏览器' };
    if (/openpyxl|xlsx|excel/i.test(cmd)) return { key: 'excel', query: 'excel openpyxl xlsx 表格' };
    if (/httpx|requests|curl/.test(cmd)) return { key: 'http', query: 'httpx requests api 抓取 反爬' };
    return null;
  }
  if (toolName === 'mcp__chapi__verify_email') return { key: 'email-verify', query: '邮箱验证 email verify' };
  if (toolName === 'mcp__chapi__pdf_edit') return { key: 'pdf', query: 'pdf 模板 替换' };
  if (toolName === 'WebFetch' || toolName === 'mcp__chapi__site_recon') return { key: 'web', query: '网页抓取 反爬 搜索' };
  return null;
}

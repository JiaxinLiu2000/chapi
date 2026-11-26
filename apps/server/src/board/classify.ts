/**
 * AI classification of sessions into projects + short per-project summaries for /board.
 * Unassigned = Session.projectId null (there is no「未归类」row). Sessions with
 * projectSource 'user' are never touched.
 */
import { prisma } from '../db/client.js';
import { complete } from '../engine/llm.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';

const log = createLogger('board-classify');

const BATCH = 40;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const norm = (s: string) => s.trim().toLowerCase();

/** Parse a model reply as a JSON object, tolerating ```json fences and surrounding prose. */
function parseJson(raw: string): Record<string, unknown> | null {
  let t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(t);
  if (direct) return direct;
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    t = t.slice(a, b + 1);
    return tryParse(t);
  }
  return null;
}

/** Set projectId without bumping updatedAt (history order is by updatedAt). */
async function setProject(sessionId: string, projectId: string | null): Promise<void> {
  await prisma.$executeRaw`UPDATE \`Session\` SET projectId = ${projectId}, projectSource = 'ai' WHERE id = ${sessionId} AND projectSource <> 'user'`;
}

async function askJson(prompt: string, sessionId?: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await complete({
        system: '你是一个把对话归类到业务项目的助手。严格只输出 JSON，不要任何解释或 markdown。',
        prompt,
        model: (await settings.getModels()).subagent,
        sessionId,
        trigger: 'summarize',
      });
      const j = parseJson(raw);
      if (j) return j;
    } catch (err) {
      log.warn(`classify model call failed: ${errText(err)}`);
    }
  }
  return null;
}

async function describeSession(s: { id: string; title: string }): Promise<string> {
  const [first, mem] = await Promise.all([
    prisma.message.findFirst({ where: { sessionId: s.id, role: 'user', NOT: { text: '' } }, orderBy: { createdAt: 'asc' }, select: { text: true } }),
    prisma.memorySummary.findFirst({ where: { sessionId: s.id }, orderBy: { createdAt: 'desc' }, select: { summary: true } }),
  ]);
  return JSON.stringify({ id: s.id, title: s.title, firstMessage: (first?.text ?? '').slice(0, 300), summary: (mem?.summary ?? '').slice(0, 300) });
}

let inFlight: Promise<{ projects: number; assigned: number }> | null = null;

/** True while a classifyAll run is in flight (drives the board's 「归类中…」). */
export function isClassifying(): boolean {
  return inFlight !== null;
}

export function classifyAll(opts: { sessionIds?: string[] } = {}): Promise<{ projects: number; assigned: number }> {
  if (inFlight) return inFlight;
  const p = runClassifyAll(opts).finally(() => {
    inFlight = null;
  });
  inFlight = p;
  return p;
}

async function runClassifyAll(opts: { sessionIds?: string[] }): Promise<{ projects: number; assigned: number }> {
  const sessions = await prisma.session.findMany({
    where: { status: { not: 'deleted' }, projectSource: { not: 'user' }, ...(opts.sessionIds ? { id: { in: opts.sessionIds } } : {}) },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true },
  });
  // name(lowercase) → id, seeded with existing live projects so re-runs reuse rows
  const projects = new Map<string, { id: string; name: string }>();
  // Archived (merged / removed) names stay taken: never recreate them. The merge target
  // isn't recorded, so sessions the model puts under such a name are left unassigned.
  const retired = new Set<string>();
  for (const p of await prisma.project.findMany({ orderBy: { sortOrder: 'asc' } })) {
    if (p.archived) retired.add(norm(p.name));
    else if (!projects.has(norm(p.name))) projects.set(norm(p.name), { id: p.id, name: p.name });
  }
  const usedProjects = new Set<string>();
  let assigned = 0;
  let first = true; // the first batch may propose new projects (existing names are offered for reuse)

  for (let i = 0; i < sessions.length; i += BATCH) {
    const batch = sessions.slice(i, i + BATCH);
    const items = (await Promise.all(batch.map(describeSession))).join('\n');
    const known = [...projects.values()].map((p) => p.name);
    const prompt = first
      ? `下面是一批 AI 助手对话（每行一个 JSON：id、标题、首条用户消息、最新摘要）。请先提出 8–15 个有业务含义的项目名（中文，或用户自己的英文项目名；粒度类似“某某楼盘分析”“某产品开发”“课程学习”），已有项目：${JSON.stringify(known)}，能复用就复用同名。再把每个对话归到其中一个项目；确实归不进任何项目的就写 null。\n输出严格 JSON：{"projects": ["项目名",...], "assign": {"<id>": "项目名或null"}}\n\n对话：\n${items}`
      : `下面是一批 AI 助手对话（每行一个 JSON）。已有项目：${JSON.stringify(known)}。只能从已有项目里选，不要新建；归不进的写 null。\n输出严格 JSON：{"assign": {"<id>": "项目名或null"}}\n\n对话：\n${items}`;
    const out = await askJson(prompt);
    if (!out) {
      log.warn(`classifyAll: batch ${i / BATCH + 1} skipped (unparseable model output)`);
      continue;
    }
    if (first) {
      for (const raw of Array.isArray(out.projects) ? out.projects : []) {
        if (typeof raw !== 'string' || !raw.trim() || norm(raw) === '未归类' || projects.has(norm(raw)) || retired.has(norm(raw))) continue;
        const max = await prisma.project.aggregate({ _max: { sortOrder: true } });
        const row = await prisma.project.create({ data: { name: raw.trim(), sortOrder: (max._max.sortOrder ?? -1) + 1 } });
        projects.set(norm(row.name), { id: row.id, name: row.name });
      }
      first = false;
    }
    const assign = out.assign && typeof out.assign === 'object' ? (out.assign as Record<string, unknown>) : {};
    for (const s of batch) {
      const v = assign[s.id];
      const proj = typeof v === 'string' ? projects.get(norm(v)) : undefined;
      await setProject(s.id, proj?.id ?? null);
      if (proj) {
        assigned++;
        usedProjects.add(proj.id);
      }
    }
  }
  bus.emit({ type: 'board.changed' });
  return { projects: usedProjects.size ? usedProjects.size : 0, assigned };
}

export async function classifySession(id: string): Promise<void> {
  const s = await prisma.session.findUnique({ where: { id }, select: { id: true, title: true, status: true, projectSource: true } });
  if (!s || s.status === 'deleted' || s.projectSource === 'user') return;
  const list = await prisma.project.findMany({ where: { archived: false }, orderBy: { sortOrder: 'asc' } });
  if (list.length === 0) return;
  const prompt = `已有项目：${JSON.stringify(list.map((p) => p.name))}。判断下面这个对话属于哪个已有项目；只能从中选择，都不属于就写 null。\n输出严格 JSON：{"project": "项目名或null"}\n\n对话：\n${await describeSession(s)}`;
  const out = await askJson(prompt, id);
  if (!out) return;
  const name = typeof out.project === 'string' ? norm(out.project) : '';
  const proj = list.find((p) => norm(p.name) === name);
  await setProject(id, proj?.id ?? null);
  bus.emit({ type: 'board.changed' });
}

export async function summarizeProject(id: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return;
  const sessions = await prisma.session.findMany({
    where: { projectId: id, status: { not: 'deleted' } },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: { id: true, title: true },
  });
  if (sessions.length === 0) return;
  const lines: string[] = [];
  for (const s of sessions) {
    const mem = await prisma.memorySummary.findFirst({ where: { sessionId: s.id }, orderBy: { createdAt: 'desc' }, select: { summary: true } });
    const tasks = await prisma.planTask.findMany({
      where: { sessionId: s.id, status: { in: ['pending', 'in_progress', 'blocked', 'problem', 'failed', 'error'] } },
      orderBy: { ordinal: 'asc' },
      take: 5,
      select: { text: true },
    });
    lines.push(
      `- ${s.title}${mem ? `\n  摘要：${mem.summary.slice(0, 300)}` : ''}${tasks.length ? `\n  未完成：${tasks.map((t) => t.text.slice(0, 80)).join('；')}` : ''}`,
    );
  }
  try {
    const raw = await complete({
      system: '你为项目看板写简短的中文项目总结。只输出总结正文。',
      prompt: `项目「${project.name}」最近的对话如下：\n${lines.join('\n')}\n\n用 2–3 句中文概括该项目当前状态和下一步；不要写日期和价格数字；只输出总结。`,
      model: (await settings.getModels()).subagent,
      trigger: 'summarize',
    });
    const summary = raw.trim();
    if (!summary) return;
    await prisma.project.update({ where: { id }, data: { summary, summaryAt: new Date() } });
    bus.emit({ type: 'board.changed' });
  } catch (err) {
    log.warn(`summarizeProject ${id} failed: ${errText(err)}`);
  }
}

/** Summarize projects with activity since their last summary. */
export async function refreshSummariesDaily(opts: { projectIds?: string[] } = {}): Promise<void> {
  const projects = await prisma.project.findMany({ where: { archived: false, ...(opts.projectIds ? { id: { in: opts.projectIds } } : {}) } });
  for (const p of projects) {
    try {
      const agg = await prisma.session.aggregate({ where: { projectId: p.id, status: { not: 'deleted' } }, _max: { updatedAt: true } });
      const last = agg._max.updatedAt;
      if (!last || (p.summaryAt && last <= p.summaryAt)) continue;
      await summarizeProject(p.id);
    } catch (err) {
      log.warn(`refresh summary ${p.id} failed: ${errText(err)}`);
    }
  }
}

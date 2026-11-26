import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRun, PendingQuestion, PlanTask, WikiEntry } from '@prisma/client';
import type { KnowledgeKind, WikiSourceRef } from '@chapi/shared';
import { sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { sessionUsage, toAgentRunDTO, toPendingQuestionDTO } from '../mappers.js';
import { settings } from '../secrets.js';
import { chooseActiveAccount } from '../engine/accounts.js';
import { emitAttention } from '../engine/attention.js';
import { agentInbox } from '../engine/inbox.js';
import { complete } from '../engine/llm.js';
import { buildCanUseTool } from '../engine/permissions.js';
import { onPlanTransitions, type StepTransition } from '../engine/plan.js';
import { tagRegistry } from '../knowledge/tags.js';
import { scoreClaim, type SourceInput, type SourceTier, type Volatility } from '../tools/confidence.js';
import { adjustScore, searchKnowledge, updateWikiEntryById, writeWikiEntry } from '../rag/wiki.js';

const log = createLogger('learning');

/** Max time the skill-conflict fixer may search/try before the point just gets −1. */
const RESOLVE_TIMEOUT_MS = 6 * 60_000;

/**
 * 学习 — the learning agent. Runs beside the main agent (never blocks it) and
 * turns what just happened into atomic knowledge points in the graph:
 *   data        third-party facts (confidence + sources + timestamp)
 *   skill       how tools/methods work (weight + tool tags)
 *   preference  what the user wants in a situation (weight + scenario tags + ±)
 * Triggers: a plan step closing (done / problem / failed / blocked / a replaced
 * step's new approach succeeding or failing), user messages after the first,
 * answers to the agent's questions, approval decisions, archiving.
 * Rules (applied here, deterministically, on the model's proposals):
 *   same skill/preference → weight +1 · same data, new source → merge sources + stack confidence ·
 *   same data, same source → skip · different data → keep both · preference conflict → ask the
 *   user (not via the main agent) and inherit the old weight · skill conflict → search & try a fix,
 *   update it if solved, else weight −1.
 */

export type LearnEvent =
  | { type: 'plan'; stepId: string; status: string; replacedId?: string | null }
  | { type: 'user'; text: string; whileWorking: boolean }
  | { type: 'answer'; question: string; options: string[] | null; answer: string }
  | { type: 'approval'; summary: string; decision: string; feedback: string | null }
  | { type: 'archive' };

interface Proposal {
  op: 'create' | 'reinforce' | 'merge_source' | 'skip' | 'conflict';
  targetId?: string;
  kind: KnowledgeKind;
  title: string;
  /** 1-3 content categories (website / project / client / domain). */
  categories?: string[];
  situation?: string;
  solution?: string;
  tags?: string[];
  polarity?: 'positive' | 'negative';
  score?: number;
  sources?: Array<{ url: string; title?: string; publishedAt?: string; tier?: SourceTier }>;
  volatility?: Volatility;
  observedAt?: string;
  contradicts?: string;
  conflictDetail?: string;
  question?: string;
  options?: string[];
  aliases?: string[];
  reason?: string;
}

const SYSTEM = `你是 Chapi 的"学习代理"：独立于主代理运行，把刚发生的事情提炼成**原子知识点**写入团队知识图谱（Obsidian）。
不要写成一大段总结——拆成 0~N 个知识点，每个只讲一件事、能独立复用。

三类知识点：
- data（数据）：来自文档 / 互联网 / 用户提供的第三方事实或数据（数字、名单、地址、规则原文…）。必须给 sources（URL、文件路径，或 "user" 表示用户提供）和数据时间 observedAt。
- skill（技能）：工作中积累的工具/方法用法——某工具怎么用、什么情况下用什么方法、易错点及解决办法。tags 写工具/方法标签。
- preference（偏好）：用户处理某类内容时**希望**（polarity=positive）或**不希望**（negative）的做法。tags 写使用场景标签。

每个知识点都要给 categories（内容分类，1~3 个，**最重要的放第一个**）：按内容归类——是哪个网站（如 apartments.com、Zillow）、哪个项目/客户（如 Tower II 租金竞品、Metropolis、Brodsky）、哪个工具/平台（如 Google Sheets、cloakbrowser）或哪个领域（如 加州 HOA 法规）。**优先放进给出的已有分类**，确实没有合适的才新建（名称简短，2~12 个字）。

每个知识点都要写清：
- situation：情况/前提（什么场景、什么条件下适用；data 写数据对象与口径）
- solution：方案（具体怎么做；data 写数据内容本身；preference 写期望/避免的做法）

对每个知识点，对照「已有相关知识点」选 op：
- create：全新的知识点
- reinforce：skill/preference 与某个已有点**含义相同** → 给 targetId（措辞不同也算相同）
- merge_source：data 与已有点是**同一数据**（同对象同数值）但来源不同 → 给 targetId 和新的 sources
- skip：data 与已有点同来源同数据；或不值得记
- conflict：skill/preference 与某个已有点**矛盾** → 给 targetId 和 conflictDetail（矛盾在哪）；preference 冲突还必须给 question（直接问用户的一个具体问题）和 options（2~4 个选项）
- data 与已有数据**不一致**（不同来源、不同结果）→ op=create，并给 contradicts=已有点 id（两条都保留，靠置信度区分）

要点：
- 用户明确表达的要求、纠正、选择、审批意见 → 一定要记成 preference（或更新已有偏好）。
- **先逐条对照已有偏好**：只要用户这次的要求与某个已有偏好相反或改变了它（哪怕只说"这次"、只改一部分），就用 op=conflict（不要另建一条相反的偏好）；question 要问清楚是"只这一次"还是"以后都这样"，options 里包含这两种。
- 步骤失败/遇到问题/受阻 → 提炼"在什么情况下会出问题、应该怎么做"为 skill；成功的非显而易见做法也记成 skill；换方案成功 → 记"旧方案在此情况下不可行、新方案可行"。
- 纯一次性的过程细节、没有复用价值的内容不要记；宁少勿滥。
- 新建时可给 score：skill/preference 初始权重 40~70（用户明确说的偏好 65，推断的 50）；data 不用给（系统按来源可靠度和新鲜度计算）。
- tags 3~6 个，**优先复用给出的已有标签**，同义词不要新造。
- title 简洁具体，不要用 \\ / : * ? " < > | # ^ [ ] 这些字符。

只输出一个 JSON：
{"intent":"supplement|correction|preference|feedback|none","points":[{"op":"...","targetId":"...","kind":"data|skill|preference","title":"...","categories":["..."],"situation":"...","solution":"...","tags":["..."],"polarity":"positive|negative","score":50,"sources":[{"url":"...","title":"...","publishedAt":"YYYY-MM-DD","tier":"official|reputable|aggregator|community|unknown"}],"volatility":"fast|medium|slow","observedAt":"YYYY-MM-DD","contradicts":"...","conflictDetail":"...","question":"...","options":["..."],"aliases":["不同问法"],"reason":"为什么记这一条"}]}`;

function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const t = fenced?.[1] ?? text;
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const KINDS: KnowledgeKind[] = ['data', 'skill', 'preference'];
const OPS = ['create', 'reinforce', 'merge_source', 'skip', 'conflict'];

export function parseProposals(text: string): { intent: string; points: Proposal[] } {
  const o = parseJsonObject(text);
  if (!o) return { intent: 'none', points: [] };
  const raw = Array.isArray(o.points) ? (o.points as Array<Record<string, unknown>>) : [];
  const points: Proposal[] = [];
  for (const p of raw) {
    const kind = String(p.kind ?? '') as KnowledgeKind;
    const op = String(p.op ?? 'create');
    const title = String(p.title ?? '').trim();
    if (!KINDS.includes(kind) || !OPS.includes(op) || !title) continue;
    points.push({
      ...(p as unknown as Proposal),
      op: op as Proposal['op'],
      kind,
      title: title.replace(/[\\/:*?"<>|#^[\]]/g, '-').slice(0, 120),
      tags: Array.isArray(p.tags) ? (p.tags as string[]).map(String).slice(0, 8) : [],
      categories: Array.isArray(p.categories) ? (p.categories as string[]).map(String).filter(Boolean).slice(0, 3) : [],
      sources: Array.isArray(p.sources) ? (p.sources as Proposal['sources']) : [],
      targetId: p.targetId ? String(p.targetId) : undefined,
    });
  }
  return { intent: String(o.intent ?? 'none'), points: points.slice(0, 12) };
}

const normRef = (r: string) =>
  r.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

/** Data point sources → stored refs (each with its own confidence) + the stacked confidence (0-100). */
export function scoreDataSources(
  sources: Array<{ url: string; title?: string; publishedAt?: string; tier?: string }>,
  volatility: Volatility | undefined,
): { refs: WikiSourceRef[]; score: number } {
  const inputs: SourceInput[] = sources.map((s) => ({
    url: /^https?:/i.test(s.url) ? s.url : `https://local.invalid/${encodeURIComponent(s.url)}`,
    publishedAt: s.publishedAt,
    tier: (s.tier as SourceTier | undefined) ?? (s.url === 'user' ? 'reputable' : undefined),
  }));
  const scored = scoreClaim({ claim: '', volatility: volatility ?? 'medium', sources: inputs });
  const refs: WikiSourceRef[] = sources.map((s, i) => ({
    kind: /^https?:/i.test(s.url) ? 'web' : s.url === 'user' ? 'user' : 'raw-material',
    ref: s.url,
    ...(s.title ? { note: s.title } : {}),
    ...(s.publishedAt ? { date: s.publishedAt } : {}),
    tier: scored.sources[i]!.tier,
    confidence: Math.round(scored.sources[i]!.confidence * 100),
  }));
  return { refs, score: Math.round(scored.confidence * 100) };
}

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

class Learner {
  private queues = new Map<string, { events: LearnEvent[]; timer: NodeJS.Timeout | null; chain: Promise<void> }>();

  constructor() {
    onPlanTransitions((sessionId, transitions) => void this.onPlan(sessionId, transitions));
  }

  // ── monitor row ────────────────────────────────────────────────────────────
  private async row(sessionId: string): Promise<AgentRun> {
    const r = await prisma.agentRun.findFirst({ where: { sessionId, name: '学习' }, orderBy: { createdAt: 'desc' } });
    return r ?? prisma.agentRun.create({ data: { sessionId, name: '学习', title: '学习代理', status: 'idle', startedAt: new Date() } });
  }

  private async setRow(sessionId: string, data: Partial<Pick<AgentRun, 'status' | 'summary' | 'currentTool' | 'currentActivity' | 'title' | 'endedAt'>>) {
    try {
      const r = await this.row(sessionId);
      const u = await prisma.agentRun.update({ where: { id: r.id }, data });
      bus.emit({ type: 'agent.status', sessionId, agent: toAgentRunDTO(u) });
    } catch {
      /* session may be gone */
    }
  }

  // ── triggers ───────────────────────────────────────────────────────────────
  private async onPlan(sessionId: string, transitions: StepTransition[]): Promise<void> {
    for (const t of transitions) {
      if (!['done', 'failed', 'problem', 'blocked'].includes(t.to)) continue; // 'replaced' waits for the new approach's outcome
      if (t.step.learnedStatus === t.to) continue;
      await prisma.planTask.update({ where: { id: t.step.id }, data: { learnedStatus: t.to } }).catch(() => undefined);
      this.enqueue(sessionId, { type: 'plan', stepId: t.step.id, status: t.to, replacedId: t.step.replacesId });
    }
  }

  /** Queue an event; events arriving close together are learned in one batch. */
  enqueue(sessionId: string, ev: LearnEvent): void {
    let q = this.queues.get(sessionId);
    if (!q) {
      q = { events: [], timer: null, chain: Promise.resolve() };
      this.queues.set(sessionId, q);
    }
    q.events.push(ev);
    if (q.timer) clearTimeout(q.timer);
    const delay = ev.type === 'plan' ? 8_000 : 3_000;
    q.timer = setTimeout(() => this.flush(sessionId), delay);
  }

  private flush(sessionId: string): Promise<void> {
    const q = this.queues.get(sessionId);
    if (!q) return Promise.resolve();
    if (q.timer) clearTimeout(q.timer);
    q.timer = null;
    const batch = q.events.splice(0);
    if (!batch.length) return q.chain;
    q.chain = q.chain.then(() => this.learn(sessionId, batch)).catch((e) => log.warn('learning batch failed', e));
    return q.chain;
  }

  /** Learn everything queued right now (used when archiving). */
  async learnNow(sessionId: string, ev?: LearnEvent): Promise<void> {
    if (ev) this.enqueue(sessionId, ev);
    await this.flush(sessionId);
  }

  // ── context ────────────────────────────────────────────────────────────────
  private async windowOps(sessionId: string, from: Date, to: Date): Promise<string> {
    const [msgs, tools] = await Promise.all([
      prisma.message.findMany({
        where: { sessionId, createdAt: { gte: from, lte: to }, type: { notIn: ['quality'] } },
        orderBy: { createdAt: 'asc' },
        take: 40,
      }),
      prisma.toolCall.findMany({ where: { sessionId, createdAt: { gte: from, lte: to } }, orderBy: { createdAt: 'asc' }, take: 120 }),
    ]);
    const lines = [
      ...msgs.filter((m) => m.text.trim()).map((m) => ({ at: m.createdAt, s: `【${m.role === 'user' ? '用户' : '主代理'}】${clip(m.text, 900)}` })),
      ...tools.map((t) => ({
        at: t.createdAt,
        s: `· ${t.toolName}(${t.inputPreview.replace(/\s+/g, ' ').slice(0, 160)}) ${t.status === 'error' ? `✗ ${(t.outputPreview ?? '').split('\n').find((l) => l.trim())?.slice(0, 240) ?? ''}` : `✓ ${clip((t.outputPreview ?? '').replace(/\s+/g, ' '), 240)}`}`,
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    const text = lines.map((l) => l.s).join('\n');
    return text.length > 22_000 ? `…(更早的已省略)\n${text.slice(-22_000)}` : text || '(这段时间没有记录到操作)';
  }

  private async recent(sessionId: string, n = 12): Promise<string> {
    const rows = await prisma.message.findMany({
      where: { sessionId, type: { notIn: ['quality'] } },
      orderBy: { createdAt: 'desc' },
      take: n,
    });
    return rows
      .reverse()
      .filter((m) => m.text.trim())
      .map((m) => `【${m.role === 'user' ? '用户' : 'AI'}】${clip(m.text, 700)}`)
      .join('\n');
  }

  private async describe(sessionId: string, ev: LearnEvent, plan: PlanTask[]): Promise<string> {
    switch (ev.type) {
      case 'plan': {
        const step = plan.find((p) => p.id === ev.stepId) ?? (await prisma.planTask.findUnique({ where: { id: ev.stepId } }));
        if (!step) return '';
        const replaced = ev.replacedId ? await prisma.planTask.findUnique({ where: { id: ev.replacedId } }) : null;
        const idx = plan.findIndex((p) => p.id === step.id);
        const prevEnd = idx > 0 ? plan[idx - 1]!.endedAt : null;
        const from = replaced?.startedAt ?? step.startedAt ?? prevEnd ?? step.createdAt;
        const to = step.endedAt ?? new Date();
        const label: Record<string, string> = { done: '完成', failed: '失败', problem: '遇到问题', blocked: '受阻' };
        const head = replaced
          ? `## 更换方案并${ev.status === 'done' ? '成功' : ev.status === 'failed' ? '失败' : label[ev.status]}（${ev.status === 'done' ? '正面' : '负面'}导向）\n原方案「${replaced.text}」被放弃，原因：${replaced.reason ?? '(未写)'}\n新方案「${step.text}」→ ${label[ev.status] ?? ev.status}${step.reason ? `，原因：${step.reason}` : ''}`
          : `## 任务步骤「${step.text}」→ ${label[ev.status] ?? ev.status}（${ev.status === 'done' ? '正面' : '负面'}导向）${step.reason ? `\n原因：${step.reason}` : ''}`;
        return `${head}\n### 这个步骤期间的操作（${from.toISOString().slice(11, 19)}–${to.toISOString().slice(11, 19)} UTC）\n${await this.windowOps(sessionId, from, to)}`;
      }
      case 'user':
        return `## 用户发言（${ev.whileWorking ? '主代理工作中途插话' : '主代理待机时发言'}）\n${ev.text}\n请判断用户是在补充意见、纠正错误、表达偏好还是别的，并据此学习。\n### 最近对话\n${await this.recent(sessionId)}`;
      case 'answer':
        return `## 主代理向用户提问，用户做出了选择/回答\n问题：${ev.question}\n${ev.options?.length ? `选项：${ev.options.join(' / ')}\n` : ''}用户回答：${ev.answer}\n### 最近对话\n${await this.recent(sessionId, 8)}`;
      case 'approval':
        return `## 用户对成果审批：${ev.decision === 'approve' ? '通过' : ev.decision === 'revise' ? '要求修改' : '驳回'}${ev.feedback ? `\n用户意见：${ev.feedback}` : ''}\n成果摘要：${clip(ev.summary, 2500)}\n### 最近对话\n${await this.recent(sessionId, 8)}`;
      case 'archive':
        return `## 用户把任务标记为「出色完成」并归档——回顾整个任务，补充之前没学到的可复用知识\n### 最近对话\n${await this.recent(sessionId, 40)}`;
    }
  }

  /** The short text each event is really about — searched on its own so the right existing points surface. */
  private async focusOf(ev: LearnEvent): Promise<string> {
    switch (ev.type) {
      case 'plan': {
        const step = await prisma.planTask.findUnique({ where: { id: ev.stepId } });
        const old = ev.replacedId ? await prisma.planTask.findUnique({ where: { id: ev.replacedId } }) : null;
        return [step?.text, step?.reason, old?.text, old?.reason].filter(Boolean).join('\n');
      }
      case 'user':
        return ev.text;
      case 'answer':
        return `${ev.question}\n${ev.answer}`;
      case 'approval':
        return `${ev.feedback ?? ''}\n${ev.summary.slice(0, 600)}`;
      case 'archive':
        return '';
    }
  }

  /** Existing points the model must compare against: per-event focused search first, then the whole context. */
  private async candidates(events: LearnEvent[], context: string): Promise<WikiEntry[]> {
    const out = new Map<string, WikiEntry>();
    for (const ev of events) {
      const focus = (await this.focusOf(ev)).trim();
      if (!focus) continue;
      for (const h of await searchKnowledge(focus, { k: 14, minRelevance: 0.15 })) out.set(h.entry.id, h.entry);
    }
    for (const h of await searchKnowledge(context.slice(0, 6000), { k: 16, minRelevance: 0.12 })) {
      if (out.size >= 30) break;
      out.set(h.entry.id, h.entry);
    }
    return [...out.values()];
  }

  private formatCandidate(e: WikiEntry): string {
    const src = ((e.sourceRefs as unknown as WikiSourceRef[]) ?? []).map((s) => s.ref).slice(0, 4).join(', ');
    return `- id=${e.id} | ${e.kind} | 分类：${((e.topics as string[]) ?? []).join('、') || '未分类'} | ${e.kind === 'data' ? '置信度' : '权重'}${e.score}${e.kind === 'preference' ? ` | ${e.polarity}` : ''} | ${e.title}\n  前提：${clip(e.situation, 200)}\n  方案：${clip(e.solution, 300)}\n  tags：${((e.tags as string[]) ?? []).join(', ')}${src ? `\n  来源：${src}` : ''}`;
  }

  // ── the learning pass ──────────────────────────────────────────────────────
  private async learn(sessionId: string, events: LearnEvent[]): Promise<void> {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) return;
    await this.setRow(sessionId, { status: 'running', currentTool: '学习', currentActivity: `整理 ${events.length} 个事件`, endedAt: null });
    const tally = { create: 0, reinforce: 0, merge: 0, ask: 0, fix: 0, skip: 0 };
    try {
      const [plan, firstUser] = await Promise.all([
        prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } }),
        prisma.message.findFirst({ where: { sessionId, role: 'user', type: 'user' }, orderBy: { createdAt: 'asc' } }),
      ]);
      const parts = (await Promise.all(events.map((e) => this.describe(sessionId, e, plan)))).filter(Boolean);
      if (!parts.length) return;
      const context = parts.join('\n\n');
      const cands = await this.candidates(events, context);
      const tags = {
        category: (await tagRegistry.list('category')).filter((t) => t !== '未分类').slice(0, 200),
        tool: (await tagRegistry.list('tool')).slice(0, 200),
        scenario: (await tagRegistry.list('scenario')).slice(0, 200),
        topic: (await tagRegistry.list('topic')).slice(0, 200),
      };
      const prompt = [
        `## 用户的任务目标\n${clip(firstUser?.text ?? session.title, 1500)}`,
        `## 当前任务流\n${plan.map((t, i) => `${i + 1}. [${t.status}] ${t.text}${t.reason ? `（${t.reason}）` : ''}`).join('\n') || '(无)'}`,
        context,
        `## 已有相关知识点\n${cands.map((c) => this.formatCandidate(c)).join('\n') || '(无)'}`,
        `## 已有内容分类（categories 优先从这里选）\n${tags.category.join('、') || '(无)'}`,
        `## 已有标签（优先复用）\n技能工具标签：${tags.tool.join(', ') || '(无)'}\n偏好场景标签：${tags.scenario.join(', ') || '(无)'}\n数据主题标签：${tags.topic.join(', ') || '(无)'}`,
        '请输出 JSON。',
      ].join('\n\n');
      const out = await complete({
        system: SYSTEM,
        prompt,
        model: (await settings.getModels()).learning,
        accountMode: (session.accountMode as 'auto' | 'primary' | 'fallback') ?? 'auto',
        sessionId,
        trigger: 'learning',
      });
      const { intent, points } = parseProposals(out);
      const byId = new Map(cands.map((c) => [c.id, c]));
      const note = `${events.map((e) => (e.type === 'plan' ? `步骤${e.status}` : e.type)).join('+')}${intent !== 'none' ? ` · ${intent}` : ''}`;
      for (const p of points) {
        try {
          const r = await this.apply(sessionId, p, byId, note);
          tally[r] += 1;
        } catch (err) {
          // Fallback: the old knowledge stays as it was.
          log.warn(`apply ${p.op} "${p.title}" failed`, err);
        }
      }
      const changed = tally.create + tally.reinforce + tally.merge;
      if (changed) {
        const s = await prisma.session.update({ where: { id: sessionId }, data: { learnings: { increment: changed } } }).catch(() => null);
        if (s) bus.emit({ type: 'usage.updated', sessionId, usage: sessionUsage(s) });
      }
    } catch (err) {
      log.warn('learning failed', err);
    } finally {
      const summary = [
        tally.create && `新增 ${tally.create}`,
        tally.reinforce && `强化 ${tally.reinforce}`,
        tally.merge && `合并来源 ${tally.merge}`,
        tally.ask && `待你确认 ${tally.ask}`,
        tally.fix && `技能冲突处理中 ${tally.fix}`,
      ]
        .filter(Boolean)
        .join(' · ');
      await this.setRow(sessionId, {
        status: 'idle',
        currentTool: null,
        currentActivity: null,
        endedAt: new Date(),
        summary: summary || '这次没有需要记录的新知识',
      });
    }
  }

  private async apply(
    sessionId: string,
    p: Proposal,
    byId: Map<string, WikiEntry>,
    note: string,
  ): Promise<'create' | 'reinforce' | 'merge' | 'ask' | 'fix' | 'skip'> {
    const target = p.targetId ? byId.get(p.targetId) ?? (await prisma.wikiEntry.findUnique({ where: { id: p.targetId } })) : null;
    const hist = { sessionId, note: clip(`${note}：${p.reason ?? ''}`, 200) };

    if (p.op === 'skip') return 'skip';

    if (p.op === 'reinforce' && target && target.kind !== 'data') {
      await adjustScore(target.id, +1, { op: 'reinforce', ...hist });
      return 'reinforce';
    }

    if (p.kind === 'data' && (p.op === 'merge_source' || p.op === 'reinforce') && target?.kind === 'data') {
      const have = (target.sourceRefs as unknown as WikiSourceRef[]) ?? [];
      const seen = new Set(have.map((s) => normRef(s.ref)));
      const fresh = (p.sources ?? []).filter((s) => s.url && !seen.has(normRef(s.url)));
      if (!fresh.length) return 'skip'; // same data from the same source
      const all = [
        ...have.map((s) => ({ url: s.ref, title: s.note, publishedAt: s.date, tier: s.tier })),
        ...fresh,
      ];
      const { refs, score } = scoreDataSources(all, p.volatility);
      await updateWikiEntryById(target.id, {
        sourceRefs: refs,
        score,
        history: { op: 'merge_source', delta: score - target.score, ...hist },
        noAutoLinks: true,
      });
      return 'merge';
    }

    if (p.op === 'conflict' && target && target.kind === 'preference') {
      await this.askPreference(sessionId, target, p);
      return 'ask';
    }
    if (p.op === 'conflict' && target && target.kind === 'skill') {
      void this.resolveSkill(sessionId, target, p);
      return 'fix';
    }

    // create (also: data that contradicts another data point — both are kept)
    const base = {
      title: p.title,
      kind: p.kind,
      topics: p.categories?.length ? p.categories : undefined,
      situation: p.situation ?? '',
      solution: p.solution ?? '',
      tags: p.tags ?? [],
      questions: p.aliases ?? [],
      links: p.contradicts && byId.get(p.contradicts) ? [byId.get(p.contradicts)!.title] : undefined,
    };
    const exists = await prisma.wikiEntry.findFirst({ where: { title: p.title } });
    if (exists && exists.kind !== 'data') {
      await adjustScore(exists.id, +1, { op: 'reinforce', ...hist });
      return 'reinforce';
    }
    if (p.kind === 'data') {
      const { refs, score } = scoreDataSources(p.sources?.length ? p.sources : [{ url: 'user' }], p.volatility);
      const observed = p.observedAt && !Number.isNaN(Date.parse(p.observedAt)) ? new Date(p.observedAt) : new Date();
      await writeWikiEntry({
        ...base,
        title: exists ? `${p.title}（另一来源）` : p.title,
        sourceRefs: refs,
        score,
        observedAt: observed,
        body: p.contradicts && byId.get(p.contradicts) ? `与 [[${byId.get(p.contradicts)!.title}]] 的数据不一致，两者都保留，按置信度取用。` : '',
        history: { op: 'create', ...hist },
      });
      return 'create';
    }
    const initial = Math.max(30, Math.min(80, Math.round(p.score ?? (p.kind === 'preference' ? 55 : 50))));
    await writeWikiEntry({
      ...base,
      polarity: p.kind === 'preference' ? (p.polarity === 'negative' ? 'negative' : 'positive') : '',
      score: initial,
      history: { op: 'create', ...hist },
    });
    return 'create';
  }

  // ── preference conflict: ask the user directly (never through / never blocking the main agent) ──
  private async askPreference(sessionId: string, target: WikiEntry, p: Proposal): Promise<void> {
    const question = (p.question ?? '').trim() || `你之前的偏好是「${target.title}」：${clip(target.solution, 200)}。这次的情况似乎不同：${clip(p.conflictDetail ?? p.solution, 200)}。以后应该按哪种来？`;
    const options = p.options?.length ? p.options.slice(0, 4) : ['按原来的偏好', '按这次的新做法', '视情况而定（我来补充说明）'];
    const q = await prisma.pendingQuestion.create({
      data: {
        sessionId,
        question: `【学习代理·偏好确认】${question}`,
        options: options as unknown as object,
        status: 'open',
        source: 'learning',
        meta: { entryId: target.id, proposal: p, oldScore: target.score } as unknown as object,
      },
    });
    bus.emit({ type: 'question.open', sessionId, question: toPendingQuestionDTO(q) });
    bus.emit({ type: 'notification', sessionId, level: 'question', title: '学习代理想确认你的偏好（不影响主代理）', body: question });
    void emitAttention(sessionId, 'question', question);
  }

  /** The user answered a learning question → rewrite the preference, keeping its old weight. */
  async onLearningAnswer(q: PendingQuestion, answer: string): Promise<void> {
    const meta = (q.meta ?? {}) as { entryId?: string; proposal?: Proposal; oldScore?: number };
    const old = meta.entryId ? await prisma.wikiEntry.findUnique({ where: { id: meta.entryId } }) : null;
    if (!old) return;
    try {
      const out = await complete({
        system: '你在维护团队知识图谱里的一条"用户偏好"。根据用户对冲突问题的回答，写出更新后的这条偏好。只输出 JSON。',
        prompt: [
          `原偏好：${old.title}\n前提：${old.situation}\n做法：${old.solution}\n正负：${old.polarity}\ntags：${((old.tags as string[]) ?? []).join(', ')}`,
          `新观察到的情况：${meta.proposal?.situation ?? ''}\n新做法：${meta.proposal?.solution ?? ''}\n矛盾：${meta.proposal?.conflictDetail ?? ''}`,
          `问用户：${q.question}\n用户回答：${answer}`,
          '输出 {"title":"...","situation":"...","solution":"...","polarity":"positive|negative","tags":["..."],"summary":"一句话说明改了什么"}。如果用户坚持原偏好，就保持原内容（可补充适用条件）；如果用户选择新做法，就改成新做法；视情况而定就把条件写清楚。',
        ].join('\n\n'),
        model: (await settings.getModels()).learning,
        sessionId: q.sessionId,
        trigger: 'learning',
      });
      const o = parseJsonObject(out);
      if (!o?.solution) throw new Error('no updated preference in reply');
      const updated = await updateWikiEntryById(old.id, {
        title: String(o.title ?? old.title).replace(/[\\/:*?"<>|#^[\]]/g, '-'),
        situation: String(o.situation ?? old.situation ?? ''),
        solution: String(o.solution),
        polarity: o.polarity === 'negative' ? 'negative' : 'positive',
        tags: Array.isArray(o.tags) ? (o.tags as string[]) : undefined,
        score: meta.oldScore ?? old.score, // inherits the weight it had before the conflict
        history: { op: 'resolve', note: clip(`用户确认：${answer}`, 200), sessionId: q.sessionId },
        noAutoLinks: true,
      });
      if (updated) {
        await agentInbox.deliver(
          q.sessionId,
          `[知识更新] 用户刚确认了一条偏好，已更新知识图谱（接下来照此执行）：「${updated.title}」——${clip(updated.solution, 400)}${o.summary ? `（${String(o.summary)}）` : ''}`,
          'now',
        );
      }
    } catch (err) {
      log.warn('preference conflict resolution failed — keeping the old point', err);
    }
  }

  // ── skill conflict: search for a fix and try it; update if solved, else weight −1 ──
  private async resolveSkill(sessionId: string, target: WikiEntry, p: Proposal): Promise<void> {
    await this.setRow(sessionId, { status: 'running', currentTool: '学习', currentActivity: `技能冲突：查找并尝试「${target.title}」的替代方案` });
    try {
      const session = await prisma.session.findUnique({ where: { id: sessionId } });
      const acct = await chooseActiveAccount((session?.accountMode as 'auto' | 'primary' | 'fallback') ?? 'auto');
      const sandbox = sessionPaths(sessionId).sandbox;
      const env: Record<string, string | undefined> = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
      delete env.ANTHROPIC_API_KEY;
      if (acct.token) env.CLAUDE_CODE_OAUTH_TOKEN = acct.token;
      // Bounded: a fix search that runs on and on is worth less than a −1 now.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), RESOLVE_TIMEOUT_MS);
      const q = query({
        prompt: [
          `知识图谱里的技能知识点「${target.title}」这次和实际情况矛盾。`,
          `原来的前提：${target.situation}\n原来的方案：${target.solution}`,
          `这次的情况：${p.situation ?? ''}\n矛盾在哪：${p.conflictDetail ?? p.solution ?? ''}`,
          '请：1) 用 WebSearch/WebFetch 查官方文档、issue、论坛找可行的替代方案；2) 如果能在沙盘里安全地快速验证（小脚本、设超时、不要动共享浏览器、不要访问需要登录的站点），就实际试一下；3) 最后只输出 JSON：',
          '{"resolved":true|false,"situation":"适用前提（可更新）","solution":"验证可行的新方案（resolved=true 时必填）","evidence":"怎么验证的/为什么可信","sources":["URL"]}',
        ].join('\n\n'),
        options: {
          model: (await settings.getModels()).learning,
          cwd: sandbox,
          additionalDirectories: [sandbox],
          systemPrompt: '你是学习代理的技能修复助手：查找并验证某个工具用法问题的替代方案。只在会话沙盘里写文件。',
          settingSources: [],
          mcpServers: {},
          allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'],
          canUseTool: buildCanUseTool(sessionId, 'web'),
          permissionMode: 'default',
          maxTurns: 16,
          abortController: abort,
          env,
        },
      });
      let text = '';
      try {
        for await (const m of q) {
          if (m.type !== 'assistant') continue;
          const c = (m as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(c)) for (const b of c as Array<{ type?: string; text?: string }>) if (b.type === 'text') text += b.text ?? '';
        }
      } finally {
        clearTimeout(timer);
      }
      const o = parseJsonObject(text);
      if (o?.resolved === true && typeof o.solution === 'string' && o.solution.trim()) {
        const updated = await updateWikiEntryById(target.id, {
          situation: typeof o.situation === 'string' && o.situation.trim() ? o.situation : (target.situation ?? ''),
          solution: o.solution,
          history: { op: 'resolve', note: clip(`冲突后找到并验证新方案：${String(o.evidence ?? '')}`, 200), sessionId },
          noAutoLinks: true,
        });
        if (updated)
          await agentInbox.deliver(sessionId, `[知识更新] 技能「${updated.title}」与实际情况矛盾，学习代理已查到并验证了新方案：${clip(updated.solution, 500)}`, 'now');
      } else {
        await adjustScore(target.id, -1, { op: 'weaken', note: clip(`冲突未解决：${p.conflictDetail ?? ''}`, 200), sessionId });
      }
    } catch (err) {
      log.warn('skill conflict resolution failed', err);
      await adjustScore(target.id, -1, { op: 'weaken', note: '冲突未解决（修复过程出错）', sessionId }).catch(() => undefined);
    } finally {
      await this.setRow(sessionId, { status: 'idle', currentTool: null, currentActivity: null });
    }
  }
}

export const learner = new Learner();

/** User messages injected by the platform itself, not typed by the user. */
export function isSystemInjected(text: string): boolean {
  return /^\[(定时任务|质检反馈|知识更新|系统说明|工作流)\]/.test(text.trim());
}


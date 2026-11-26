/**
 * The remote-chat "translator" agent (WeChat / Discord): rewrites chapi output into
 * short phone-friendly pushes, maps free-text phone replies back onto question
 * options, and learns how the user likes pushes written (stored as `preference`
 * knowledge points tagged 手机推送, so they show up — and can be edited — in the
 * knowledge base).
 *
 * Runs on the same model as the session's sub-agents. Every call degrades to a
 * deterministic fallback, so a model hiccup never blocks a push or an answer.
 */
import { prisma } from '../db/client.js';
import { complete } from '../engine/llm.js';
import { createLogger } from '../logger.js';
import { adjustScore, writeWikiEntry } from '../rag/wiki.js';
import { settings } from '../secrets.js';
import { discordSafe, toPlainText } from './format.js';

const log = createLogger('remote:translator');

export const PREF_TAG = '手机推送';
const PREF_TITLE_PREFIX = '手机推送：';
const LEGACY_PREFIXES = ['微信推送：'];
const PREF_SITUATION = '在手机上（微信 / Discord）接收 chapi 的推送消息';

/** plain = WeChat bubble (no Markdown); discord = light Markdown, no tables. */
export type PushStyle = 'plain' | 'discord';

export type PushKind = 'completion' | 'question' | 'approval' | 'error' | 'detail';
const KIND_LABEL: Record<PushKind, string> = {
  completion: '完成结果',
  question: '提问',
  approval: '审批',
  error: '出错',
  detail: '详细',
};

type CompleteFn = typeof complete;

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** First {...} JSON object in a model reply. */
function parseJson<T>(raw: string): T | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

export class Translator {
  private prefCache: { at: number; text: string } | null = null;

  constructor(
    private readonly llm: CompleteFn = complete,
    readonly style: PushStyle = 'plain',
  ) {}

  /** Shape model output for the target chat. */
  private shape(text: string): string {
    return this.style === 'discord' ? discordSafe(text) : toPlainText(text);
  }

  /** Same model the session's sub-agents use (falls back to the global sub-agent model). */
  private async modelFor(sessionId?: string): Promise<string> {
    if (sessionId) {
      const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { subagentModel: true } });
      if (s?.subagentModel) return s.subagentModel;
    }
    return (await settings.getModels()).subagent;
  }

  private async run(sessionId: string | undefined, system: string, prompt: string): Promise<string> {
    return this.llm({ system, prompt, model: await this.modelFor(sessionId), sessionId, trigger: 'remote' });
  }

  /** The user's learned push preferences, strongest first. */
  async preferences(): Promise<string> {
    if (this.prefCache && Date.now() - this.prefCache.at < 60_000) return this.prefCache.text;
    const rows = await prisma.wikiEntry
      .findMany({ where: { kind: 'preference' }, select: { title: true, solution: true, polarity: true, score: true, tags: true } })
      .catch(() => []);
    const mine = rows
      .filter(
        (r) =>
          [PREF_TITLE_PREFIX, ...LEGACY_PREFIXES].some((p) => r.title.startsWith(p)) ||
          (Array.isArray(r.tags) && (r.tags as string[]).some((t) => t === PREF_TAG || t === '微信推送')),
      )
      .filter((r) => r.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((r) => `- ${r.polarity === 'negative' ? '避免：' : ''}${(r.solution || r.title.replace(/^[^：]*：/, '')).trim()}`);
    const text = mine.length ? mine.join('\n') : '（暂无）';
    this.prefCache = { at: Date.now(), text };
    return text;
  }

  private async baseRules(budget: number): Promise<string> {
    return [
      `你是 chapi 的「手机推送编辑」。用户不在电脑前，在${this.style === 'discord' ? ' Discord' : '微信'}上看 AI 助手的工作进展。`,
      '硬性规则：',
      this.style === 'discord'
        ? '1. 可以用少量 Discord Markdown（**加粗**关键数字、「- 」列表），不要用表格、标题和代码块。'
        : '1. 纯文本，不用 Markdown（不要 #、**、表格、代码块）；列表用「1.」或「·」。',
      `2. 默认不超过 ${budget} 个汉字，先一句话结论，再最多 4 条要点（关键数字/结果/需要用户做的事）。`,
      '3. 删掉过程描述、工具与步骤细节、客套、重复、“如需…请告诉我”之类的废话。',
      '4. 不编造、不改数字；URL 原样保留（最多 3 个最重要的）。',
      '5. 用中文；专有名词、文件名保持原样。',
      '用户对微信推送的偏好（优先于上面的默认长度/格式）：',
      await this.preferences(),
    ].join('\n');
  }

  /** A finished turn → one short push, or null when there's nothing new for the user. */
  async composeCompletion(input: { sessionId: string; title: string; text: string }): Promise<string | null> {
    const raw = input.text.trim();
    if (!raw) return null;
    const system = `${await this.baseRules(150)}\n6. 如果这轮输出对用户没有新信息（比如只是“好的，我继续”），只输出 SKIP。\n只输出消息正文。`;
    try {
      const out = (await this.run(input.sessionId, system, `任务：${input.title}\n\n本轮 AI 输出：\n${clip(raw, 12_000)}`)).trim();
      if (!out || /^SKIP\b/i.test(out)) return null;
      return this.shape(out);
    } catch (err) {
      log.warn('composeCompletion failed, using fallback', err);
      return clip(this.shape(raw), 300);
    }
  }

  /** Long question/options → short versions (same option count/order). Short ones pass through. */
  async composeQuestion(input: { sessionId: string; question: string; options: string[] | null }): Promise<{ question: string; options: string[] | null }> {
    const opts = input.options;
    const long = input.question.length > 80 || (opts ?? []).some((o) => o.length > 28);
    if (!long) return { question: toPlainText(input.question), options: opts };
    const system = `${await this.baseRules(80)}\n把 AI 的提问压缩成手机上一眼能看懂的版本：问题 ≤60 字，每个选项 ≤20 字，选项数量和顺序必须与原来完全一致、意思不能变。只输出 JSON：{"q":"问题","o":["选项1",...]}`;
    try {
      const j = parseJson<{ q?: string; o?: string[] }>(
        await this.run(input.sessionId, system, JSON.stringify({ question: input.question, options: opts ?? [] })),
      );
      if (j?.q && (!opts || (Array.isArray(j.o) && j.o.length === opts.length))) {
        return { question: toPlainText(j.q), options: opts ? j.o!.map((o) => toPlainText(o)) : null };
      }
    } catch (err) {
      log.warn('composeQuestion failed, using fallback', err);
    }
    return { question: clip(toPlainText(input.question), 120), options: opts?.map((o) => clip(o, 40)) ?? null };
  }

  async composeApproval(input: { sessionId: string; summary: string }): Promise<string> {
    const system = `${await this.baseRules(100)}\n把待审批成果的摘要压缩成：做了什么 + 关键结果（≤100 字）。只输出正文。`;
    try {
      const out = (await this.run(input.sessionId, system, clip(input.summary, 8000))).trim();
      if (out) return this.shape(out);
    } catch (err) {
      log.warn('composeApproval failed, using fallback', err);
    }
    return clip(this.shape(input.summary), 200);
  }

  /** "/详细": a fuller (but still phone-sized) version of a push. */
  async composeDetail(input: { sessionId?: string; fullText: string }): Promise<string> {
    const system = `${await this.baseRules(600)}\n这次用户主动要“详细版”：保留结构和所有关键数字/链接，可以到 800 字，但仍然去掉过程和废话。只输出正文。`;
    try {
      const out = (await this.run(input.sessionId, system, clip(input.fullText, 16_000))).trim();
      if (out) return this.shape(out);
    } catch (err) {
      log.warn('composeDetail failed, using fallback', err);
    }
    return this.shape(input.fullText);
  }

  /**
   * Free-text reply to a question with options → the answer string the agent sees.
   * The user's own words are always kept verbatim (paraphrasing loses nuance); the
   * model only recognises which option(s) they mean, if any, and puts that in front.
   */
  async interpretAnswer(input: { sessionId: string; question: string; options: string[]; reply: string }): Promise<string> {
    const system =
      '用户在手机上回复 AI 的提问。判断他的回复对应哪个选项。只输出 JSON：{"pick":[对应的选项序号，从1开始，可多个；不对应任何选项或看不出就留空]}';
    try {
      const j = parseJson<{ pick?: number[] }>(
        await this.run(
          input.sessionId,
          system,
          `问题：${input.question}\n选项：\n${input.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\n用户回复：${input.reply}`,
        ),
      );
      const picks = (j?.pick ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= input.options.length);
      if (picks.length) return `${picks.map((n) => input.options[n - 1]).join('、')}（原话：${input.reply}）`;
    } catch (err) {
      log.warn('interpretAnswer failed', err);
    }
    return input.reply; // not one of the options → their own answer, verbatim
  }

  /**
   * Is this message feedback on how pushes are written (vs. an instruction for the task)?
   * Returns the preference to remember + a short acknowledgement, or null.
   */
  async classifyFeedback(input: { reply: string; lastPush?: string }): Promise<{ preference: string; ack: string } | null> {
    const system =
      '判断这条手机消息是不是在评价“推送消息本身的写法”（长短、详略、频率、格式、语气），而不是给任务下指令或回答问题。' +
      '只输出 JSON：{"feedback":true或false,"preference":"一句可执行的偏好，例如：完成推送控制在 80 字内，只说结论和数字","ack":"一句很短的确认，例如：好，以后推送只说结论"}';
    try {
      const j = parseJson<{ feedback?: boolean; preference?: string; ack?: string }>(
        await this.run(undefined, system, `${input.lastPush ? `上一条推送：${clip(input.lastPush, 600)}\n\n` : ''}用户消息：${input.reply}`),
      );
      if (j?.feedback && j.preference?.trim()) return { preference: j.preference.trim(), ack: (j.ack ?? '').trim() || '好的，记住了。' };
    } catch (err) {
      log.warn('classifyFeedback failed', err);
    }
    return null;
  }

  /** Remember an explicit push preference (knowledge base, kind=preference). */
  async recordPreference(preference: string, sessionId?: string): Promise<void> {
    this.prefCache = null;
    await writeWikiEntry({
      title: `${PREF_TITLE_PREFIX}${clip(preference, 40).replace(/[\\/:*?"<>|]/g, ' ')}`,
      kind: 'preference',
      polarity: 'positive',
      score: 70,
      situation: PREF_SITUATION,
      solution: preference,
      tags: [PREF_TAG],
      history: { op: 'create', note: '用户在手机上的反馈', ...(sessionId ? { sessionId } : {}) },
    }).catch((err) => log.warn('recordPreference failed', err));
  }

  /** "/详细" on a kind of push is a weak signal that kind should be longer by default. */
  async nudgeDetail(kind: PushKind, sessionId?: string): Promise<void> {
    if (kind === 'detail') return;
    this.prefCache = null;
    const title = `${PREF_TITLE_PREFIX}${KIND_LABEL[kind]}推送可以更详细一些`;
    const existing = await prisma.wikiEntry.findFirst({ where: { title } }).catch(() => null);
    if (existing) {
      await adjustScore(existing.id, 8, { op: 'reinforce', note: '用户又要了一次 /详细', ...(sessionId ? { sessionId } : {}) }).catch(() => undefined);
      return;
    }
    await writeWikiEntry({
      title,
      kind: 'preference',
      polarity: 'positive',
      score: 35, // below the 40 threshold: it takes a few "/详细" before it changes the default
      situation: `${PREF_SITUATION}（${KIND_LABEL[kind]}类）`,
      solution: `${KIND_LABEL[kind]}推送多给一些要点和数字（可放宽到 250 字左右）`,
      tags: [PREF_TAG],
      history: { op: 'create', note: '用户要了 /详细', ...(sessionId ? { sessionId } : {}) },
    }).catch((err) => log.warn('nudgeDetail failed', err));
  }
}

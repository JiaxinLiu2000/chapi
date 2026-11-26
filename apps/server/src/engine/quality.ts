import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRun, PlanTask } from '@prisma/client';
import type { RunState } from '@chapi/shared';
import { config, sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { recallBlock } from '../knowledge/recall.js';
import { createLogger } from '../logger.js';
import { toAgentRunDTO, toMessageDTO, toSessionDTO } from '../mappers.js';
import { settings } from '../secrets.js';
import { getOrchestrator } from '../orchestrator/types.js';
import { chooseActiveAccount } from './accounts.js';
import { emitAttention } from './attention.js';
import { hitl } from './hitl.js';
import { agentInbox } from './inbox.js';
import { updatePlanStep } from './plan.js';

const log = createLogger('quality');

/**
 * 质检 = an independent *advisor* agent, modelled on oh-my-pi's advisor/watchdog:
 * a second model on its own context that skims what the main agent did since its
 * last look (messages, one card per tool call, failed results, plan, deliverables),
 * verifies suspicions with read-only tools, and raises at most a few notes graded
 * nit / concern / blocker.
 *
 * When it looks:
 *   - on a timer that counts the main agent's *working* time only (paused while the
 *     turn is over, while it waits on the user, and during a turn the advisor itself
 *     triggered — no advisor → agent → advisor loops);
 *   - synchronously before a deliverable reaches the user (`gate`, called by
 *     request_approval): a blocker or a low score sends the work back, at most
 *     MAX_GATE_BLOCKS times, then it goes through with the notes attached;
 *   - rule-based stuck detection on every tool call (no model call).
 *
 * Routing while the main agent works ("in progress"): only blockers interrupt;
 * concerns are collected and handed over once when the turn ends (one follow-up
 * turn at most, none after a user interrupt or a follow-up turn); nits ride along
 * with the next turn. A verdict that lands while the agent isn't working never
 * interrupts or starts a turn. Notes repeating an earlier one are dropped unless
 * their severity went up.
 */

export type Severity = 'nit' | 'concern' | 'blocker';

export interface AdvisorNote {
  id: string;
  severity: Severity;
  title: string;
  note: string;
  where?: string;
  fix?: string;
  planStep?: string;
}

export interface Verdict {
  score: number;
  summary: string;
  notes: AdvisorNote[];
}

/** Max notes accepted from one review (omp: 3). */
export const MAX_NOTES_PER_REVIEW = 3;
/** How many times the pre-delivery gate may send the work back before letting it through. */
export const MAX_GATE_BLOCKS = 2;
/** Below this score the pre-delivery gate sends the work back (even without a blocker). */
export const GATE_MIN_SCORE = 60;
const GATE_TIMEOUT_MS = 120_000;
const DIGEST_MAX_CHARS = 36_000;
const MSG_MAX_CHARS = 1_500;

const SEVERITIES: Severity[] = ['nit', 'concern', 'blocker'];
const RANK: Record<Severity, number> = { nit: 0, concern: 1, blocker: 2 };

const SYSTEM = [
  '你是"质检顾问"(advisor)——一个独立于主代理的第二模型，像资深同事从旁看一眼主代理的工作。你**只读**，绝不修改任何文件或产物。',
  '',
  '目标：尽早发现会让任务**失败、返工或误导用户**的问题，而不是挑刺。重点看：',
  '- 方向是否偏离用户的真实需求/明确要求（对照用户原话和用户的偏好规则）；',
  '- 数据/事实是否可疑：数字异常、来源不可靠或过旧、口径混乱、未核验就当结论（可用 Read/Grep/Glob 抽查沙盘里的文件**核实后再提**）；',
  '- 跳过了验证、遗漏步骤、产物不完整、格式不可用；',
  '- 低效或危险的做法：反复失败却不换方法、无意义的等待/重试、可能被封禁或违反限制的操作。',
  '',
  '严重度：',
  '- nit：小建议，主代理下一轮顺带参考即可；',
  '- concern：明显的问题，应当处理或给出理由；',
  '- blocker：继续下去结果会错/作废，必须马上停下处理。典型 blocker：只抽样却声称全部完成；用占位/假数据/示例冒充真实结果；没有对照用户原话逐项核对就说"完成"；关键数字或结论从未验证；交付物缺失、链接打不开或内容与描述不符；违反用户明确禁止的做法。',
  '',
  '规则：',
  '- 最多 3 条，宁缺毋滥。一切正常就返回空 notes（不要写"看起来不错"之类的废话）。',
  '- 不要重复"已提出的建议"里的内容；问题仍未解决且更严重时可以升级严重度重提。',
  '- 不要复述主代理已经看到的报错，除非它在无视它。',
  '- 每条要具体：指出位置（文件/步骤/工具调用）、问题、可执行的修改建议。',
  '',
  '务必**只输出一个 JSON**，不要任何多余文字：',
  '{"score":0-100,"summary":"一句话总体判断","notes":[{"severity":"nit|concern|blocker","title":"短标题","note":"问题说明","where":"文件/步骤","fix":"修改建议","planStep":"相关任务流步骤原文(可选)"}]}',
].join('\n');

const NOISE = /^(lgtm|looks good|ok|okay|none|n\/a|无|没有问题|暂无问题|一切正常|看起来不错|no issues?)[.。!！\s]*$/i;

/** Parse the advisor's JSON; drops noise, clamps to MAX_NOTES_PER_REVIEW (blockers first). */
export function parseVerdict(text: string): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as {
      score?: unknown;
      summary?: unknown;
      notes?: unknown;
      issues?: unknown; // legacy field name
    };
    const raw = Array.isArray(o.notes) ? o.notes : Array.isArray(o.issues) ? o.issues : [];
    const notes: AdvisorNote[] = [];
    for (const r of raw as Array<Record<string, unknown>>) {
      if (!r || typeof r !== 'object') continue;
      let sev = String(r.severity ?? 'nit').toLowerCase();
      // legacy high/medium/low
      if (sev === 'high') sev = 'blocker';
      else if (sev === 'medium') sev = 'concern';
      else if (sev === 'low') sev = 'nit';
      const severity = (SEVERITIES as string[]).includes(sev) ? (sev as Severity) : 'nit';
      const note = String(r.note ?? r.problem ?? '').trim();
      const title = String(r.title ?? '').trim() || note.slice(0, 40);
      if (!note || NOISE.test(note)) continue;
      notes.push({
        id: randomUUID().slice(0, 8),
        severity,
        title: title.slice(0, 80),
        note: note.slice(0, 800),
        where: r.where ? String(r.where).slice(0, 200) : undefined,
        fix: r.fix ? String(r.fix).slice(0, 600) : undefined,
        planStep: r.planStep ? String(r.planStep).slice(0, 300) : undefined,
      });
    }
    notes.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
    return {
      score: Math.max(0, Math.min(100, Number(o.score) || 0)),
      summary: String(o.summary ?? '').slice(0, 200),
      notes: notes.slice(0, MAX_NOTES_PER_REVIEW),
    };
  } catch {
    return null;
  }
}

/**
 * Where a note goes:
 *   steer    — straight into the running turn (blockers only)
 *   turnEnd  — collected, handed over once when the current turn ends (concerns)
 *   aside    — rides along with the next turn (nits)
 *   preserve — the agent isn't working: everything waits for its next turn
 */
export type Channel = 'steer' | 'turnEnd' | 'aside' | 'preserve';

export function routeNote(severity: Severity, live: boolean): Channel {
  if (!live) return 'preserve';
  if (severity === 'blocker') return 'steer';
  return severity === 'concern' ? 'turnEnd' : 'aside';
}

const SEV_LABEL: Record<Severity, string> = { nit: '建议', concern: '问题', blocker: '阻断' };
const CHANNEL_LABEL: Record<Channel, string> = {
  steer: '已即时反馈给主代理',
  turnEnd: '本轮结束时交给主代理处理',
  aside: '主代理下一轮顺带参考',
  preserve: '主代理下次开始工作时交付',
};

export function formatNoteForAgent(n: AdvisorNote): string {
  return `- [${n.severity}] ${n.title}${n.where ? `（${n.where}）` : ''}：${n.note}${n.fix ? ` → 建议：${n.fix}` : ''}`;
}

// ── De-duplication across reviews ─────────────────────────────────────────

/** Normalised note key: lower-case, no spaces/punctuation. */
export function noteKey(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 1) out.add(s);
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Same issue? Equal keys, one containing the other, or ≥ 50% shared character bigrams. */
export function similarKeys(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 4) return true;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter) >= 0.5;
}

interface DeliveredNote {
  title: string;
  key: string;
  severity: Severity;
  review: number;
}

/** Drop notes that repeat an earlier one at the same or a lower severity (escalations pass). */
export function dropRepeats<T extends { title: string; severity: Severity }>(
  notes: T[],
  delivered: Array<{ key: string; severity: Severity }>,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const n of notes) {
    const k = noteKey(n.title);
    const prior = delivered.filter((d) => similarKeys(k, d.key));
    const top = prior.reduce((m, d) => Math.max(m, RANK[d.severity]), -1);
    if (prior.length && RANK[n.severity] <= top) dropped.push(n);
    else kept.push(n);
  }
  return { kept, dropped };
}

// ── Rule-based stuck detection (no model call) ────────────────────────────

export interface ToolEvent {
  id: string;
  name: string;
  input: string;
  status?: string;
  error?: string;
}

/** Tools that legitimately repeat (waiting on the user, bookkeeping). */
const STUCK_IGNORE = /ask_user|request_approval|notify_user|get_current_time|update_plan_step|set_plan|schedule_task|TodoWrite/i;
export const STUCK_REPEAT = 4;
export const STUCK_SAME_ERROR = 3;

function errorLine(s: string): string {
  const first = s.split('\n').find((l) => l.trim()) ?? '';
  return first.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Same call 4× in a row, or the same error 3× among the last 10 results → stuck. */
export function detectStuck(history: ToolEvent[]): { signature: string; reason: string } | null {
  const calls = history.filter((h) => !STUCK_IGNORE.test(h.name));
  const tail = calls.slice(-STUCK_REPEAT);
  if (tail.length === STUCK_REPEAT && tail.every((h) => h.name === tail[0]!.name && h.input === tail[0]!.input)) {
    const arg = tail[0]!.input.replace(/\s+/g, ' ').slice(0, 100);
    return {
      signature: `repeat:${tail[0]!.name}:${arg}`,
      reason: `连续 ${STUCK_REPEAT} 次执行完全相同的调用 ${tail[0]!.name}(${arg})`,
    };
  }
  const counts = new Map<string, number>();
  for (const h of calls.slice(-10)) {
    if (h.status !== 'error' || !h.error) continue;
    const line = errorLine(h.error);
    if (!line) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
    if ((counts.get(line) ?? 0) >= STUCK_SAME_ERROR) {
      return { signature: `error:${line}`, reason: `同一个错误已出现 ${STUCK_SAME_ERROR} 次：${line}` };
    }
  }
  return null;
}

// ── Advisor context: the user's own rules ────────────────────────────────

export const ADVISOR_GUIDE_PATH = path.join(config.paths.skills, 'quality-advisor', 'GUIDE.md');
const DEFAULT_GUIDE = `# 质检顾问指南（用户维护）

质检顾问每次检查都会读这份文件。写下希望它**特别盯住**的规则（一条一行，越具体越好）。

- 改 Google Sheet 前必须先读当前内容（read_sheet_values），按实际格式写入，不凭记忆覆写。
- Google Sheets 写入一律用 RAW 模式；USER_ENTERED 会把 "09,10" 变日期、"-2.7%" 变小数、"+" 开头变公式。
- 下拉列不要写空字符串（会让下拉消失）；只写有值的列。
- 同事会同时改表：每批写入前重读现状、去重、接在最后一行下面。
- 电话号码用纯号码（203-422-7700），不加 +、= 或国家码；每行电话要在该行链接的页面里真实出现。
- 邮件只能建草稿，绝不发送；Slack 只读。
- 与用户沟通、审批摘要、汇报一律中文；总结里的名词也写中文（专有名词除外）。
- 最终产物要在 Google Drive，并用 save_artifact 登记链接。
- 数据要带来源，关键数字多来源核实；不能把抽样结果说成全部完成。
`;

async function readGuide(): Promise<string> {
  try {
    return await fs.readFile(ADVISOR_GUIDE_PATH, 'utf8');
  } catch {
    try {
      await fs.mkdir(path.dirname(ADVISOR_GUIDE_PATH), { recursive: true });
      await fs.writeFile(ADVISOR_GUIDE_PATH, DEFAULT_GUIDE, 'utf8');
    } catch (err) {
      log.warn('could not seed advisor guide', err);
    }
    return DEFAULT_GUIDE;
  }
}

/** Truncate the middle of long text so both the ask and its conclusion survive. */
function clip(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const half = Math.floor(max / 2) - 10;
  return `${t.slice(0, half)} …(略 ${t.length - 2 * half} 字)… ${t.slice(-half)}`;
}

interface AdvisorState {
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  /** Bumped on every (re)arm — a timer whose generation is stale does nothing. */
  gen: number;
  nextAt: number | null;
  reviewing: boolean;
  /** Activity at/after this instant hasn't been reviewed yet. */
  cursor: Date | null;
  lastReviewAt: number | null;
  reviewCount: number;
  delivered: DeliveredNote[];
  /** Timer stopped because the main agent isn't working; resumes with remainingMs. */
  paused: boolean;
  remainingMs: number | null;
  /** Why it's paused (shown on the monitor card). */
  pausedFor: string | null;
  /** Concerns found mid-turn, handed over when the turn ends. */
  pendingConcerns: AdvisorNote[];
  /** The current turn was started by the advisor (no new reviews in it). */
  qcTurn: boolean;
  /** The user interrupted the current turn (no automatic follow-up). */
  interrupted: boolean;
  /** Times the pre-delivery gate has sent the current deliverable back. */
  gateBlocks: number;
  /** Recent tool calls, for stuck detection. */
  tools: ToolEvent[];
  /** Stuck signatures already reported. */
  stuckSeen: Set<string>;
}

type ReviewData = {
  session: NonNullable<Awaited<ReturnType<typeof prisma.session.findUnique>>>;
  plan: PlanTask[];
  digest: string;
  model: string;
  reviewStart: Date;
  newMsgs: number;
  newTools: number;
};

class QualityAdvisor {
  private states = new Map<string, AdvisorState>();
  private runStates = new Map<string, RunState>();

  constructor() {
    bus.on((e) => {
      if (e.type === 'run.state') {
        this.runStates.set(e.sessionId, e.state);
        if (e.state !== 'running' && e.state !== 'paused') void this.onTurnEnd(e.sessionId);
        void this.sync(e.sessionId);
      } else if (e.type === 'tool.started') {
        this.onTool(e.sessionId, { id: e.toolCall.id, name: e.toolCall.toolName, input: e.toolCall.inputPreview });
      } else if (e.type === 'tool.finished') {
        this.onToolDone(e.sessionId, e.toolCallId, e.status, e.outputPreview);
      }
    });
    hitl.onWaitChange((sessionId) => void this.sync(sessionId));
  }

  /** The main agent is mid-turn, not blocked on the user, and not in an advisor-triggered turn. */
  working(sessionId: string): boolean {
    const s = this.states.get(sessionId);
    return this.runStates.get(sessionId) === 'running' && !hitl.isWaiting(sessionId) && !s?.qcTurn;
  }

  private pauseReason(sessionId: string): string {
    if (hitl.isWaiting(sessionId)) return '等待你的回复或审批';
    if (this.states.get(sessionId)?.qcTurn) return '主代理在处理质检意见';
    return '主代理未在工作';
  }

  /** A real user message arrived: whatever runs next is the user's turn again. */
  onUserMessage(sessionId: string): void {
    const s = this.states.get(sessionId);
    if (!s) return;
    s.qcTurn = false;
    s.interrupted = false;
    void this.sync(sessionId);
  }

  /** The user stopped the turn: no automatic follow-up from collected concerns. */
  noteInterrupt(sessionId: string): void {
    const s = this.states.get(sessionId);
    if (s) s.interrupted = true;
  }

  /** Turn over: hand the collected concerns over once (a follow-up turn), else hold them. */
  private async onTurnEnd(sessionId: string): Promise<void> {
    const s = this.states.get(sessionId);
    if (!s) return;
    const wasQcTurn = s.qcTurn;
    const interrupted = s.interrupted;
    s.qcTurn = false;
    s.interrupted = false;
    const notes = s.pendingConcerns.splice(0);
    if (!notes.length) return;
    const msg = [
      '[质检反馈] 本轮工作中质检顾问记下的问题（请处理，或简要说明为什么不需要处理）：',
      ...notes.map(formatNoteForAgent),
    ].join('\n');
    const session = await prisma.session.findUnique({ where: { id: sessionId } }).catch(() => null);
    if (session?.status === 'active' && !interrupted && !wasQcTurn && s.intervalMs > 0) {
      s.qcTurn = true; // this follow-up schedules no reviews of its own
      await getOrchestrator()
        .injectAdvice(sessionId, msg)
        .catch(async (e) => {
          s.qcTurn = false;
          log.warn('turn-end advice inject failed', e);
          await agentInbox.deliver(sessionId, msg, 'next');
        });
    } else {
      await agentInbox.deliver(sessionId, msg, 'next');
    }
  }

  /** Pause or resume the timer to follow whether the main agent is working. */
  private async sync(sessionId: string): Promise<void> {
    const s = this.states.get(sessionId);
    if (!s || s.intervalMs <= 0 || s.reviewing) return;
    const working = this.working(sessionId);
    if (working && s.paused) {
      s.paused = false;
      const left = s.remainingMs ?? s.intervalMs;
      s.remainingMs = null;
      await this.arm(sessionId, Date.now() + Math.max(15_000, left));
    } else if (!working && !s.paused) {
      await this.pause(sessionId, s.nextAt ? Math.max(0, s.nextAt - Date.now()) : s.intervalMs);
    } else if (!working && s.pausedFor !== this.pauseReason(sessionId)) {
      await this.pause(sessionId, s.remainingMs ?? s.intervalMs); // same pause, new reason on the card
    }
  }

  private async pause(sessionId: string, remainingMs: number): Promise<void> {
    const s = this.state(sessionId);
    s.gen += 1;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.nextAt = null;
    s.paused = true;
    s.remainingMs = remainingMs;
    s.pausedFor = this.pauseReason(sessionId);
    await this.updateRow(sessionId, {
      status: 'idle',
      scheduledFor: null,
      title: `质检已暂停（${s.pausedFor}）· 恢复工作后约 ${Math.max(1, Math.round(remainingMs / 60_000))} 分钟内质检`,
      currentTool: null,
      currentActivity: null,
    }).catch((e) => log.warn('quality row update failed', e));
  }

  private state(sessionId: string): AdvisorState {
    let s = this.states.get(sessionId);
    if (!s) {
      s = {
        intervalMs: 0,
        timer: null,
        gen: 0,
        nextAt: null,
        reviewing: false,
        cursor: null,
        lastReviewAt: null,
        reviewCount: 0,
        delivered: [],
        paused: false,
        remainingMs: null,
        pausedFor: null,
        pendingConcerns: [],
        qcTurn: false,
        interrupted: false,
        gateBlocks: 0,
        tools: [],
        stuckSeen: new Set(),
      };
      this.states.set(sessionId, s);
    }
    return s;
  }

  isOn(sessionId: string): boolean {
    return (this.states.get(sessionId)?.intervalMs ?? 0) > 0;
  }

  intervalMinutes(sessionId: string): number {
    return Math.round((this.states.get(sessionId)?.intervalMs ?? 0) / 60_000);
  }

  /** The single "质检" monitor row of a session (created on demand). */
  private async row(sessionId: string): Promise<AgentRun> {
    const existing = await prisma.agentRun.findFirst({
      where: { sessionId, name: '质检' },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;
    return prisma.agentRun.create({
      data: { sessionId, name: '质检', title: '质检顾问', status: 'idle', startedAt: new Date() },
    });
  }

  private async updateRow(sessionId: string, data: Parameters<typeof prisma.agentRun.update>[0]['data']) {
    const r = await this.row(sessionId);
    const updated = await prisma.agentRun.update({ where: { id: r.id }, data });
    bus.emit({ type: 'agent.status', sessionId, agent: toAgentRunDTO(updated) });
    return updated;
  }

  /**
   * Apply a cadence (minutes; 0 = off) immediately. The next review is due one
   * new interval after the previous review (or now, if that's already past), so
   * shortening the interval takes effect right away instead of after the old one.
   */
  async configure(sessionId: string, minutes: number): Promise<void> {
    const s = this.state(sessionId);
    s.gen += 1;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (minutes <= 0) {
      s.intervalMs = 0;
      s.nextAt = null;
      s.paused = false;
      s.remainingMs = null;
      if (!s.reviewing) {
        await this.updateRow(sessionId, {
          status: 'idle',
          scheduledFor: null,
          title: '定时质检已关闭',
          currentTool: null,
          currentActivity: null,
        }).catch(() => undefined);
      }
      log.info(`quality advisor off for session ${sessionId}`);
      return;
    }
    s.intervalMs = minutes * 60_000;
    if (s.lastReviewAt === null) {
      // After a restart: continue from the last finished review, if any.
      const r = await prisma.agentRun
        .findFirst({ where: { sessionId, name: '质检', endedAt: { not: null } }, orderBy: { endedAt: 'desc' } })
        .catch(() => null);
      if (r?.endedAt) {
        s.lastReviewAt = r.endedAt.getTime();
        s.cursor ??= r.endedAt;
      }
    }
    const base = s.lastReviewAt ?? Date.now();
    const due = Math.max(Date.now() + 15_000, base + s.intervalMs);
    if (!s.reviewing) {
      if (this.working(sessionId)) {
        s.paused = false;
        s.remainingMs = null;
        await this.arm(sessionId, due);
      } else {
        await this.pause(sessionId, Math.min(s.intervalMs, due - Date.now()));
      }
    }
    log.info(`quality advisor every ${minutes}min for session ${sessionId} (next ${new Date(due).toISOString()})`);
  }

  /** Make sure a session with a configured cadence has a live timer (e.g. after a restart). */
  async ensure(sessionId: string, minutes: number): Promise<void> {
    if (minutes > 0 && this.intervalMinutes(sessionId) !== minutes) await this.configure(sessionId, minutes);
  }

  private async arm(sessionId: string, at: number): Promise<void> {
    const s = this.state(sessionId);
    if (s.timer) clearTimeout(s.timer);
    const gen = s.gen;
    s.nextAt = at;
    s.timer = setTimeout(() => {
      if (this.state(sessionId).gen !== gen) return;
      void this.review(sessionId);
    }, Math.max(0, at - Date.now()));
    await this.updateRow(sessionId, {
      status: 'scheduled',
      scheduledFor: new Date(at),
      title: `主代理工作时每 ${Math.round(s.intervalMs / 60_000)} 分钟质检一次`,
      currentTool: null,
      currentActivity: null,
    }).catch((e) => log.warn('quality row update failed', e));
  }

  /** After a review or gate finished: re-arm or pause to match the agent's state. */
  private async settle(sessionId: string, s: AdvisorState, data: Parameters<typeof prisma.agentRun.update>[0]['data']) {
    const session = await prisma.session.findUnique({ where: { id: sessionId } }).catch(() => null);
    if (!session || session.status !== 'active') {
      s.intervalMs = 0;
      await this.updateRow(sessionId, { ...data, status: 'done', scheduledFor: null }).catch(() => undefined);
    } else if (s.intervalMs > 0) {
      await this.updateRow(sessionId, data).catch(() => undefined);
      if (this.working(sessionId)) {
        s.paused = false;
        await this.arm(sessionId, Date.now() + s.intervalMs);
      } else {
        await this.pause(sessionId, s.intervalMs);
      }
    } else {
      await this.updateRow(sessionId, { ...data, status: 'idle', scheduledFor: null, title: '定时质检已关闭' }).catch(
        () => undefined,
      );
    }
  }

  /** Run one review right now (manual trigger, or when the timer fires). */
  async review(sessionId: string, manual = false): Promise<void> {
    const s = this.state(sessionId);
    if (s.reviewing) return;
    s.reviewing = true;
    s.timer = null;
    const started = Date.now();
    let outcome = '';
    try {
      outcome = await this.reviewOnce(sessionId, s, manual);
    } catch (err) {
      log.warn('quality review failed', err);
      outcome = '本轮质检出错，稍后重试';
    } finally {
      s.reviewing = false;
      s.lastReviewAt = Date.now();
      await this.settle(sessionId, s, {
        summary: outcome || null,
        endedAt: new Date(),
        elapsedMs: Date.now() - started,
        currentTool: null,
        currentActivity: null,
      });
    }
  }

  /** Gather what the advisor reads; null (with a reason) when there's nothing to look at. */
  private async collect(
    sessionId: string,
    s: AdvisorState,
    opts: { since: Date; manual: boolean; gate?: { summary: string; artifacts: string[] } },
  ): Promise<ReviewData | string> {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'active') return '会话已结束';
    const [plan, artifacts, userMsgs, newMsgs, newTools] = await Promise.all([
      prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } }),
      prisma.artifact.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } }),
      prisma.message.findMany({
        where: { sessionId, role: 'user', type: 'user' },
        orderBy: { createdAt: 'asc' },
        select: { text: true, createdAt: true },
      }),
      prisma.message.findMany({
        where: { sessionId, createdAt: { gte: opts.since }, type: { not: 'quality' } },
        orderBy: { createdAt: 'asc' },
        take: 120,
      }),
      prisma.toolCall.findMany({
        where: { sessionId, createdAt: { gte: opts.since } },
        orderBy: { createdAt: 'asc' },
        take: 300,
      }),
    ]);
    if (!opts.gate && plan.length === 0 && artifacts.length === 0 && newMsgs.length === 0) return '尚无可评估的产出，跳过';
    if (!opts.gate && !opts.manual && s.reviewCount > 0 && newMsgs.length === 0 && newTools.length === 0) {
      return '上次质检后没有新进展，跳过本轮';
    }

    const goal = userMsgs[0]?.text?.trim() || session.title;
    const laterAsks = userMsgs.slice(1).map((m) => m.text);
    const [guide, prefs] = await Promise.all([
      readGuide(),
      recallBlock([goal, ...laterAsks.slice(-3)].join('\n').slice(0, 1500), {
        heading: '## 用户的偏好与相关经验',
        kinds: ['preference', 'skill'],
        k: 10,
      }).catch(() => null),
    ]);

    const digest = buildDigest({
      goal,
      laterAsks,
      plan,
      artifacts: artifacts.map((a) => `- ${a.kind}「${a.title}」${a.pathOrUrl}`),
      messages: newMsgs.map((m) => ({ role: m.role, type: m.type, text: m.text })),
      tools: newTools.map((t) => ({
        name: t.toolName,
        input: t.inputPreview,
        status: t.status,
        output: t.outputPreview,
      })),
      delivered: s.delivered.slice(-12),
      sandbox: sessionPaths(sessionId).sandbox,
      firstReview: s.reviewCount === 0,
      guide,
      prefs: prefs ?? undefined,
      inProgress: !opts.gate && this.working(sessionId),
      gate: opts.gate,
    });
    // per-session override → Settings → sub-agent model
    const model = session.qualityModel || (await settings.getModels()).quality;
    return { session, plan, digest, model, reviewStart: new Date(), newMsgs: newMsgs.length, newTools: newTools.length };
  }

  /** Post the yellow 质检 bubble (stays in the transcript). */
  private async postBubble(sessionId: string, heading: string, lines: string[], verdictLine: string, summary: string) {
    const qualityText = [verdictLine, summary, lines.length ? lines.join('\n') : '未发现需要处理的问题。']
      .filter(Boolean)
      .join('\n\n');
    const r = await this.row(sessionId);
    const qualityMessage = await prisma.message.create({
      data: {
        sessionId,
        role: 'assistant',
        type: 'quality',
        content: [{ type: 'text', text: heading ? `${heading}\n\n${qualityText}` : qualityText }] as unknown as object,
        text: heading ? `${heading}\n\n${qualityText}` : qualityText,
        agentRunId: r.id,
      },
    });
    bus.emit({ type: 'assistant.message', sessionId, message: toMessageDTO(qualityMessage) });
  }

  private remember(s: AdvisorState, notes: AdvisorNote[]) {
    for (const n of notes) s.delivered.push({ title: n.title, key: noteKey(n.title), severity: n.severity, review: s.reviewCount });
  }

  private async reviewOnce(sessionId: string, s: AdvisorState, manual: boolean): Promise<string> {
    const data = await this.collect(sessionId, s, { since: s.cursor ?? new Date(0), manual });
    if (typeof data === 'string') return data;

    await this.updateRow(sessionId, {
      status: 'running',
      scheduledFor: null,
      startedAt: data.reviewStart,
      endedAt: null,
      currentTool: '质检',
      currentActivity: `评估 ${data.newMsgs} 条消息、${data.newTools} 次工具调用`,
    });

    const accountMode = (data.session.accountMode as 'auto' | 'primary' | 'fallback') ?? 'auto';
    const verdict = await this.ask(sessionId, data.digest, data.model, accountMode);
    s.cursor = data.reviewStart;
    if (!verdict) return '本轮质检未能给出有效结论，稍后重试';
    s.reviewCount += 1;

    const { kept, dropped } = dropRepeats(verdict.notes, s.delivered);
    // Not working any more (turn over, waiting on the user, or a follow-up turn):
    // never interrupt or start a turn — everything waits for the next one.
    const live = this.working(sessionId);
    const routed = kept.map((n) => ({ n, ch: routeNote(n.severity, live) }));
    const steering = routed.some((x) => x.ch === 'steer');
    // When a blocker interrupts anyway, the rest rides along with it.
    const label = (ch: Channel) => (steering && ch !== 'steer' ? '随本次即时反馈一并附上（参考）' : CHANNEL_LABEL[ch]);

    const lines = routed.map(
      ({ n, ch }) =>
        `- **[${SEV_LABEL[n.severity]}] ${n.title}**${n.where ? `（${n.where}）` : ''}：${n.note}${
          n.fix ? `\n  建议：${n.fix}` : ''
        }\n  _${label(ch)}_`,
    );
    if (dropped.length) lines.push(`_另有 ${dropped.length} 条与此前意见重复，已略去。_`);
    await this.postBubble(sessionId, '', lines, `质检评分：${verdict.score}/100 · 模型 ${data.model}`, verdict.summary);

    await markPlanProblems(sessionId, data.plan, kept);
    this.remember(s, kept);

    const serious = kept.filter((n) => n.severity !== 'nit');
    bus.emit({
      type: 'notification',
      sessionId,
      level: serious.length ? 'error' : 'success',
      title: '质检结果',
      body: `评分 ${verdict.score}/100。${verdict.summary}${serious.length ? ` 发现 ${serious.length} 项需处理。` : ' 未见明显问题。'}`,
    });
    if (serious.length) void emitAttention(sessionId, 'notify', `质检 ${verdict.score}/100：${verdict.summary}`);

    const steer = routed.filter((x) => x.ch === 'steer').map((x) => x.n);
    const rest = routed.filter((x) => x.ch !== 'steer');
    if (steer.length) {
      const msg = [
        `[质检反馈] 质检顾问评分 ${verdict.score}/100，以下阻断性问题需要你现在处理：`,
        ...steer.map(formatNoteForAgent),
        ...(rest.length ? ['', '另有几条供参考的意见：', ...rest.map((x) => formatNoteForAgent(x.n))] : []),
      ].join('\n');
      await getOrchestrator()
        .injectAdvice(sessionId, msg)
        .catch((e) => log.warn('advice inject failed', e));
    } else {
      s.pendingConcerns.push(...rest.filter((x) => x.ch === 'turnEnd').map((x) => x.n));
      const held = rest.filter((x) => x.ch === 'aside' || x.ch === 'preserve').map((x) => x.n);
      if (held.length) {
        await agentInbox.deliver(
          sessionId,
          ['[质检反馈] 质检顾问留下的意见（参考处理，不必中断当前要求）：', ...held.map(formatNoteForAgent)].join('\n'),
          'next',
        );
      }
    }

    return `评分 ${verdict.score}/100 · ${verdict.summary}${
      kept.length ? `（${kept.length} 条：${kept.map((n) => SEV_LABEL[n.severity]).join('、')}）` : ''
    }`;
  }

  /**
   * Pre-delivery gate, called by request_approval before the user sees anything.
   * Blocks (returns the reason to the agent) on a blocker or a score under
   * GATE_MIN_SCORE, at most MAX_GATE_BLOCKS times; otherwise lets it through,
   * attaching serious notes for the user. Off when the session's 质检 is off;
   * times out open.
   */
  async gate(
    sessionId: string,
    summary: string,
    artifacts: string[],
  ): Promise<{ block: boolean; agentText?: string; userNote?: string }> {
    const session = await prisma.session.findUnique({ where: { id: sessionId } }).catch(() => null);
    if (!session || session.status !== 'active' || (session.qualityReviewMinutes ?? 0) <= 0) return { block: false };
    const s = this.state(sessionId);
    // Let an in-flight timed review finish first (it shares the cursor).
    for (let i = 0; s.reviewing && i < 120; i++) await new Promise((r) => setTimeout(r, 500));
    s.reviewing = true;
    const started = Date.now();
    let outcome = '';
    try {
      // Look at the whole turn that produced the deliverable, not just since the last review.
      const lastUser = await prisma.message
        .findFirst({ where: { sessionId, role: 'user', type: 'user' }, orderBy: { createdAt: 'desc' } })
        .catch(() => null);
      const since = new Date(Math.min(s.cursor?.getTime() ?? 0, lastUser?.createdAt.getTime() ?? 0));
      const data = await this.collect(sessionId, s, { since, manual: true, gate: { summary, artifacts } });
      if (typeof data === 'string') return { block: false };
      await this.updateRow(sessionId, {
        status: 'running',
        scheduledFor: null,
        startedAt: data.reviewStart,
        endedAt: null,
        currentTool: '质检',
        currentActivity: '交付前质检：核对即将提交给你的成果',
      });
      const accountMode = (data.session.accountMode as 'auto' | 'primary' | 'fallback') ?? 'auto';
      const verdict = await Promise.race([
        this.ask(sessionId, data.digest, data.model, accountMode),
        new Promise<null>((r) => setTimeout(() => r(null), GATE_TIMEOUT_MS)),
      ]);
      s.cursor = data.reviewStart;
      if (!verdict) {
        outcome = '交付前质检超时或无结论，已放行';
        return { block: false };
      }
      s.reviewCount += 1;
      // Repeats of notes the agent already got still count for the gate (the problem persists).
      const serious = verdict.notes.filter((n) => n.severity !== 'nit');
      const failing = verdict.notes.some((n) => n.severity === 'blocker') || verdict.score < GATE_MIN_SCORE;
      const block = failing && s.gateBlocks < MAX_GATE_BLOCKS;
      const lines = verdict.notes.map(
        (n) =>
          `- **[${SEV_LABEL[n.severity]}] ${n.title}**${n.where ? `（${n.where}）` : ''}：${n.note}${n.fix ? `\n  建议：${n.fix}` : ''}`,
      );
      const head = block
        ? `交付前质检：未通过，已退回主代理修改（第 ${s.gateBlocks + 1}/${MAX_GATE_BLOCKS} 次）`
        : failing
          ? `交付前质检：仍有问题，但已退回 ${MAX_GATE_BLOCKS} 次，放行并把意见附在审批里`
          : '交付前质检：通过';
      await this.postBubble(sessionId, `**${head}**`, lines, `质检评分：${verdict.score}/100 · 模型 ${data.model}`, verdict.summary);
      await markPlanProblems(sessionId, data.plan, verdict.notes);
      this.remember(s, verdict.notes);

      if (block) {
        s.gateBlocks += 1;
        outcome = `交付前质检未通过（${verdict.score}/100），退回第 ${s.gateBlocks} 次`;
        return {
          block: true,
          agentText: [
            `[交付前质检未通过 · 第 ${s.gateBlocks}/${MAX_GATE_BLOCKS} 次] 评分 ${verdict.score}/100：${verdict.summary}`,
            '提交已被拦下，用户还没有看到。请先处理以下问题，再重新调用 request_approval（某条确实无法做到时，处理其余的，并在 summary 里写明原因）：',
            ...verdict.notes.map(formatNoteForAgent),
          ].join('\n'),
        };
      }
      s.gateBlocks = 0;
      outcome = `交付前质检${failing ? '放行（已达退回上限）' : '通过'}（${verdict.score}/100）`;
      return {
        block: false,
        userNote: serious.length
          ? [`—— 交付前质检（${verdict.score}/100）——`, ...serious.map((n) => `- [${SEV_LABEL[n.severity]}] ${n.title}：${n.note}`)].join('\n')
          : undefined,
      };
    } catch (err) {
      log.warn('pre-delivery gate failed', err);
      outcome = '交付前质检出错，已放行';
      return { block: false };
    } finally {
      s.reviewing = false;
      s.lastReviewAt = Date.now();
      await this.settle(sessionId, s, {
        summary: outcome || null,
        endedAt: new Date(),
        elapsedMs: Date.now() - started,
        currentTool: null,
        currentActivity: null,
      });
    }
  }

  // ── stuck detection ──
  private onTool(sessionId: string, ev: ToolEvent): void {
    const s = this.states.get(sessionId);
    if (!s || s.intervalMs <= 0) return;
    s.tools.push(ev);
    if (s.tools.length > 30) s.tools.splice(0, s.tools.length - 30);
    this.checkStuck(sessionId, s);
  }

  private onToolDone(sessionId: string, id: string, status: string, output?: string): void {
    const s = this.states.get(sessionId);
    const ev = s?.tools.find((t) => t.id === id);
    if (!s || !ev) return;
    ev.status = status;
    if (status === 'error') ev.error = output ?? '';
    this.checkStuck(sessionId, s);
  }

  private checkStuck(sessionId: string, s: AdvisorState): void {
    const hit = detectStuck(s.tools);
    if (!hit || s.stuckSeen.has(hit.signature)) return;
    s.stuckSeen.add(hit.signature);
    s.tools = []; // start counting afresh after a report
    void this.flagStuck(sessionId, s, hit.reason);
  }

  private async flagStuck(sessionId: string, s: AdvisorState, reason: string): Promise<void> {
    const note: AdvisorNote = {
      id: randomUUID().slice(0, 8),
      severity: 'blocker',
      title: '疑似卡住',
      note: reason,
      fix: '停下来分析原因，换一种方法或工具；确实需要用户协助时用 ask_user 说明卡在哪里。',
    };
    try {
      await this.postBubble(
        sessionId,
        '**规则检测（未调用模型）**',
        [`- **[${SEV_LABEL.blocker}] ${note.title}**：${note.note}\n  建议：${note.fix}`],
        '',
        '',
      );
      s.delivered.push({ title: note.title, key: noteKey(`${note.title}${reason}`), severity: 'blocker', review: s.reviewCount });
      bus.emit({ type: 'notification', sessionId, level: 'error', title: '质检：疑似卡住', body: reason });
      const msg = ['[质检反馈] 规则检测发现主代理疑似卡住，请现在处理：', formatNoteForAgent(note)].join('\n');
      if (this.runStates.get(sessionId) === 'running') {
        await getOrchestrator().injectAdvice(sessionId, msg);
      } else {
        await agentInbox.deliver(sessionId, msg, 'next');
      }
    } catch (err) {
      log.warn('stuck report failed', err);
    }
  }

  private async ask(
    sessionId: string,
    prompt: string,
    model: string,
    accountMode: 'auto' | 'primary' | 'fallback',
  ): Promise<Verdict | null> {
    const acct = await chooseActiveAccount(accountMode);
    const sandbox = sessionPaths(sessionId).sandbox;
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    if (acct.token) env.CLAUDE_CODE_OAUTH_TOKEN = acct.token;

    const q = query({
      prompt,
      options: {
        model,
        effort: 'high',
        cwd: sandbox,
        additionalDirectories: [sandbox],
        systemPrompt: SYSTEM,
        settingSources: [],
        mcpServers: {},
        allowedTools: ['Read', 'Grep', 'Glob', 'LS'],
        disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'WebFetch', 'WebSearch'],
        permissionMode: 'default',
        includePartialMessages: false,
        maxTurns: 16,
        env,
      },
    });

    let text = '';
    let usage: { input_tokens?: number; output_tokens?: number } = {};
    let costUsd = 0;
    for await (const m of q) {
      if (m.type === 'assistant') {
        const am = m as { error?: string; message?: { content?: unknown } };
        if (am.error) throw new Error(`reviewer ${am.error}`);
        const c = am.message?.content;
        if (Array.isArray(c))
          for (const b of c as Array<{ type?: string; text?: string; name?: string; input?: { file_path?: string; pattern?: string } }>) {
            if (b.type === 'text') text += b.text ?? '';
            else if (b.type === 'tool_use')
              void this.updateRow(sessionId, {
                currentTool: '质检',
                currentActivity: `核实：${b.name} ${b.input?.file_path ?? b.input?.pattern ?? ''}`.slice(0, 180),
              }).catch(() => undefined);
          }
      } else if (m.type === 'result') {
        const rm = m as { usage?: typeof usage; total_cost_usd?: number };
        usage = rm.usage ?? {};
        costUsd = rm.total_cost_usd ?? 0;
      }
    }

    if (acct.name !== 'machine') {
      await prisma.usageEvent
        .create({
          data: {
            sessionId,
            account: acct.name,
            trigger: 'quality_review',
            model,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            costUsd,
          },
        })
        .catch((err) => log.warn('usage event create failed', err));
    }
    return parseVerdict(text);
  }

  /** Re-arm every active session that has a cadence configured (timers are in-memory). */
  async reloadAll(): Promise<void> {
    const sessions = await prisma.session
      .findMany({ where: { status: 'active', qualityReviewMinutes: { gt: 0 } } })
      .catch(() => []);
    for (const s of sessions) await this.configure(s.id, s.qualityReviewMinutes).catch(() => undefined);
    if (sessions.length) log.info(`re-armed quality advisor for ${sessions.length} session(s)`);
  }

  stop(sessionId: string): void {
    const s = this.states.get(sessionId);
    if (!s) return;
    s.gen += 1;
    if (s.timer) clearTimeout(s.timer);
    this.states.delete(sessionId);
  }
}

export interface DigestInput {
  goal: string;
  laterAsks: string[];
  plan: PlanTask[];
  artifacts: string[];
  messages: Array<{ role: string; type: string; text: string }>;
  tools: Array<{ name: string; input: string; status: string; output: string | null }>;
  delivered: Array<{ title: string; severity: Severity }>;
  sandbox: string;
  firstReview: boolean;
  /** The user-maintained advisor guide (workspaces/skills/quality-advisor/GUIDE.md). */
  guide?: string;
  /** Knowledge-graph preferences/experience relevant to the task. */
  prefs?: string;
  /** The main agent is still mid-turn: judge the direction, not the unfinished work. */
  inProgress?: boolean;
  /** Pre-delivery gate: what is about to be handed to the user. */
  gate?: { summary: string; artifacts: string[] };
}

/**
 * Compact skim of the main session for the advisor (omp style): user/agent text
 * verbatim-ish, one card per tool call (name + main argument), failed results
 * reduced to their first error line; successful results only as status.
 */
export function buildDigest(d: DigestInput): string {
  const parts: string[] = [];
  if (d.gate) {
    parts.push(
      [
        '## 交付前把关（本次检查的重点）',
        '主代理正要把下面的成果提交给用户审批。请对照用户原话逐项核对：交付物是否真实存在且完整、每项要求是否满足、关键数字是否核实、是否违反用户的偏好规则。',
        '只有当用户会拿到错误、不完整或违背要求的成果时才给 blocker；格式小瑕疵给 nit。',
        `### 提交摘要\n${clip(d.gate.summary, 3000)}`,
        `### 随附交付物\n${d.gate.artifacts.join('\n') || '(无)'}`,
      ].join('\n'),
    );
  }
  if (d.inProgress)
    parts.push(
      '## 注意：主代理仍在工作中（进行中，后面还有步骤）\n不要批评尚未完成的半成品；只有方向错误、正在造成不可逆后果、或已确定会导致返工的问题才用 blocker，其余问题会在本轮结束时再交给主代理。',
    );
  parts.push(`## 用户的任务目标（原话）\n${clip(d.goal, 3000)}`);
  if (d.laterAsks.length)
    parts.push(`## 用户后续补充/修改要求\n${d.laterAsks.slice(-8).map((t) => `- ${clip(t, 600)}`).join('\n')}`);
  if (d.guide?.trim()) parts.push(`## 质检指南（用户维护，务必对照）\n${clip(d.guide, 4000)}`);
  if (d.prefs?.trim()) parts.push(clip(d.prefs, 4000));
  parts.push(`## 当前任务流\n${d.plan.map((t) => `- [${t.status}] ${t.text}`).join('\n') || '(无任务流)'}`);
  parts.push(`## 已登记交付物\n${d.artifacts.join('\n') || '(暂无)'}`);

  const activity: string[] = [];
  for (const m of d.messages) {
    if (!m.text.trim()) continue;
    const who = m.role === 'user' ? (m.text.startsWith('[质检反馈]') ? '质检→主代理' : '用户') : '主代理';
    activity.push(`【${who}】${clip(m.text, MSG_MAX_CHARS)}`);
  }
  const toolCards = d.tools.map((t) => {
    const arg = t.input.replace(/\s+/g, ' ').slice(0, 120);
    if (t.status === 'error') {
      const first = (t.output ?? '').split('\n').find((l) => l.trim()) ?? '';
      return `· ${t.name}(${arg}) ✗ ${first.slice(0, 200)}`;
    }
    return `· ${t.name}(${arg}) ${t.status === 'running' ? '…进行中' : '✓'}${t.output ? ` [${t.output.length} 字]` : ''}`;
  });
  const span = d.gate ? '本轮' : d.firstReview ? '到目前为止' : '自上次质检以来';
  let act = `## ${span}的对话\n${activity.join('\n\n') || '(无新消息)'}`;
  let tools = `## ${span}的工具调用（${d.tools.length} 次）\n${toolCards.join('\n') || '(无)'}`;
  // Keep within budget: drop the oldest activity first, keep the newest.
  const fixed = parts.join('\n\n').length + 1500;
  while (act.length + tools.length + fixed > DIGEST_MAX_CHARS && (activity.length > 4 || toolCards.length > 20)) {
    if (activity.length > 4) activity.splice(0, Math.ceil(activity.length / 4));
    if (toolCards.length > 20) toolCards.splice(0, Math.ceil(toolCards.length / 4));
    act = `## 最近的对话（更早的已省略）\n${activity.join('\n\n')}`;
    tools = `## 最近的工具调用（更早的已省略）\n${toolCards.join('\n')}`;
  }
  parts.push(act, tools);
  if (d.delivered.length)
    parts.push(
      `## 你此前已提出的建议（不要重复）\n${d.delivered.map((n) => `- [${n.severity}] ${n.title}`).join('\n')}`,
    );
  parts.push(`会话沙盘目录（可用 LS/Read/Grep/Glob 核实实际文件）：${d.sandbox}`);
  parts.push('请评估后**只输出 JSON**。');
  return parts.join('\n\n');
}

async function markPlanProblems(sessionId: string, plan: PlanTask[], notes: AdvisorNote[]): Promise<void> {
  for (const n of notes) {
    if (n.severity === 'nit' || !n.planStep) continue;
    const text = n.planStep;
    const match = plan.find((t) => t.text === text) || plan.find((t) => text.includes(t.text) || t.text.includes(text));
    if (match && match.status !== 'done' && match.status !== 'problem') {
      // Through the task flow so the reason is kept (and the learning agent sees it).
      await updatePlanStep(sessionId, { step: match.text, status: 'problem', reason: `质检：${n.title}——${n.note}`.slice(0, 500) }).catch(
        () => undefined,
      );
    }
  }
}

export const qualityAdvisor = new QualityAdvisor();

/**
 * Persist + apply a session's quality cadence and broadcast it, so the run bar
 * dropdown, the monitor countdown and the timer always agree.
 */
export async function setQualityCadence(sessionId: string, minutes: number): Promise<void> {
  const updated = await prisma.session.update({ where: { id: sessionId }, data: { qualityReviewMinutes: minutes } });
  bus.emit({ type: 'session.updated', session: toSessionDTO(updated) });
  await qualityAdvisor.configure(sessionId, minutes);
}

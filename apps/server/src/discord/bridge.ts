/**
 * Discord remote: drive chapi sessions from Discord.
 *
 * - Each connected session gets its own thread in one configured channel; anything
 *   the owner types in that thread goes to that session as a normal user message
 *   (no "current session" juggling). A plain message in the channel itself starts
 *   a new task (new session + thread).
 * - While a session runs, its thread shows "chapi is typing…" instead of progress.
 * - Turn results are rewritten short by the translator (light Markdown) with a
 *   「📄 详细」 button; questions come with one button per option; approvals with
 *   批准 / 修改 (opens a feedback form) / 驳回 buttons. Typed replies still work.
 * - Produced files/images are attached to the thread.
 *
 * Talks to Discord only through `DiscordPort` (see gateway.ts), so the logic is
 * testable without a live bot.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  topAllowedModel,
  type DiscordSessionStateDTO,
  type EffortLevel,
  type ScheduleSpec,
  type ServerEvent,
  type SessionDTO,
  type WorkflowGraph,
  type WorkflowRunDTO,
} from '@chapi/shared';
import { config, sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toMessageDTO, toPlanTaskDTO, toProjectDTO, toSessionDTO } from '../mappers.js';
import { settings } from '../secrets.js';
import { getOrchestrator } from '../orchestrator/types.js';
import { agentInbox } from '../engine/inbox.js';
import { hitl } from '../engine/hitl.js';
import { isSystemInjected } from '../learning/learner.js';
import { createSession, currentRunState, searchSessions } from '../services/sessions.js';
import { shortId } from '../util/ids.js';
import { IMAGE_EXT, collectTurn, turnFiles } from '../remote/files.js';
import { PREVIEW_PAGES, canPreview, findSandboxFiles, makePreview } from '../remote/preview.js';
import { captureBrowser } from '../remote/browserShot.js';
import { STYLE_FEEDBACK_RE, chunkText, parseApprovalReply, parseCommand, parseOptionPick, toPlainText } from '../remote/format.js';
import { Translator, type PushKind } from '../remote/translator.js';
import { workflowEngine } from '../workflow/engine.js';
import { loadActiveRun, listSessionRuns, toRunDTO } from '../workflow/store.js';
import { confirmLatestDraft, draftChanges, findWorkflowRef } from '../workflow/drafts.js';
import { getBoardToday } from '../board/today.js';
import { automationDTOs, findAutomation, runNow, updateAutomation } from '../board/service.js';
import { lastDue } from '../board/schedule.js';
import { renderAutomation, renderAutomations, renderProjectPicker, renderProjectSessions, renderProjects, renderReminder, renderToday } from './boardView.js';
import { ACTIVE_RUN, nodeRunOf, renderPlan, renderRunCard, renderStageDetail, runSteps, shortTitle, stageEvents } from './workflowView.js';

const log = createLogger('discord');

const TURN_SETTLE_MS = 3000;
const TYPING_REFRESH_MS = 8000; // Discord's typing indicator lasts ~10s
const MAX_MSG = 1900; // Discord hard limit is 2000
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // default bot upload limit

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger';
export interface Btn {
  id: string;
  label: string;
  style: ButtonStyle;
  disabled?: boolean;
}
export interface SelectMenu {
  id: string;
  placeholder: string;
  options: Array<{ value: string; label: string; description?: string; default?: boolean }>;
}
export interface OutPayload {
  content: string;
  /** Dropdowns, each on its own row (rendered above the buttons; selects + button rows ≤ 5). */
  selects?: SelectMenu[];
  buttons?: Btn[][];
  files?: string[];
}

/** Everything the bridge needs from Discord. */
export interface DiscordPort {
  send(channelId: string, payload: OutPayload): Promise<string>;
  edit(channelId: string, messageId: string, payload: OutPayload): Promise<void>;
  typing(channelId: string): Promise<void>;
  createThread(parentChannelId: string, name: string, firstMessage: string): Promise<string>;
  setArchived(threadId: string, archived: boolean): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  threadUrl(threadId: string): string | null;
}

export interface InboundMessage {
  channelId: string;
  /** Parent channel when channelId is a thread. */
  parentId: string | null;
  isDM: boolean;
  authorId: string;
  messageId: string;
  content: string;
  attachments: Array<{ url: string; name: string; size: number; contentType?: string | null }>;
}

export const DISCORD_HELP = [
  '**chapi · Discord**',
  '- 在频道里直接发消息 = 新建一个任务（自动开一个子话题）',
  '- 接着做浏览器里以前的对话：频道里发 `!列表`（最近的对话）或 `!找 关键词`，从下拉菜单里选一个',
  '- 看文档：做完的 Word/Excel/PPT/PDF 会自动发前几页的预览图；在子话题里 `!预览 文件名` 可以随时看沙盘里的文件',
  '- 在任务的子话题里发消息 = 发给这个任务；有提问/审批时，点按钮或直接打字回答',
  '- 想用文字回答提问：点卡片上的「✍️ 文字回答」，或直接在子话题里打字（原话会完整交给 chapi）',
  '- `!设置` 改这个任务的模型 / 子代理 / 思考强度 / 质检 / 账号 / 语言 / 用我的 Chrome',
  '- 工作流（SOP）：`!流程` 选一个已确认的 SOP 开跑（频道里发会新开任务），也能确认 AI 起草的 SOP；进度卡会实时更新，阶段完成/受阻会提醒，下拉看阶段详情，按钮停止',
  '- `!进度` 工作流 / 任务流进度 · `!质检` 立即质检 · `!浏览器` 看浏览器当前画面 · `!归档` 标记出色完成并归档',
  '- 看板：`!今天` 等你 / 运行中 / 今天完成，下拉直接打开 · `!项目` 按项目找对话（在子话题里发 = 把这个任务移到别的项目）',
  '- 自动化：`!自动化` 看全部定时任务，打开后可 ▶ 立即运行 / 改手动或自动 / 停用 / 打开最近一次；手动任务到点会在频道提醒，自动任务开跑会自动开子话题（设置里可关）；改时间或新建直接跟 chapi 说',
  '- `!状态` 当前在做什么 · `!停` 中断 · `!详细` 上一条推送的完整版 · `!断开` 不再同步这个任务 · `!列表` 已连接的任务',
].join('\n');

/** Notifications that already arrive as their own card (question / approval buttons). */
const NOTIFY_SKIP = new Set(['AI 需要你的输入', '成果待审批']);
const NOTIFY_ICON: Record<string, string> = { info: 'ℹ️', success: '✅', error: '⚠️', question: '❓' };
const WF_EDIT_MS = 4000;
const BOARD_DEBOUNCE_MS = 1500;
const REMIND_TICK_MS = 60_000;
/** A manual automation's slot older than this when first seen is not pinged (e.g. bot was offline). */
const REMIND_WINDOW_MS = 15 * 60_000;
/** Automation runs started within this window get a thread when auto-connect is on. */
const AUTO_CONNECT_WINDOW_MS = 6 * 3600_000;

interface WfCard {
  messageId: string | null;
  prev?: WorkflowRunDTO;
  latest: WorkflowRunDTO;
  lastEditAt: number;
  timer?: NodeJS.Timeout;
  chain: Promise<unknown>;
}

const EFFORT_LABEL: Record<EffortLevel, string> = { low: '低', medium: '中', high: '高', xhigh: '较高', max: '最高' };
const QUALITY_OPTIONS: Array<{ v: number; label: string }> = [
  { v: 0, label: '关闭' },
  { v: 5, label: '每 5 分钟' },
  { v: 10, label: '每 10 分钟' },
  { v: 15, label: '每 15 分钟' },
  { v: 30, label: '每 30 分钟' },
  { v: 60, label: '每 60 分钟' },
];
const modelLabel = (id: string) => MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;

interface Turn {
  startedAt: Date;
  timer?: NodeJS.Timeout;
  suppress?: boolean;
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function safeFilename(name: string): string {
  return path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '') || 'file';
}

/** Under Discord's default per-file upload limit. */
function fits(file: string): boolean {
  try {
    const size = fs.statSync(file).size;
    return size > 0 && size <= MAX_UPLOAD_BYTES;
  } catch {
    return false;
  }
}

function ago(d: Date): string {
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  if (m < 60) return `${Math.max(1, m)} 分钟前`;
  if (m < 60 * 24) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 60 / 24)} 天前`;
}


export class DiscordBridge {
  private port: DiscordPort | null = null;
  private owners = new Set<string>();
  private homeChannelId: string | null = null;
  private unsubscribe: (() => void) | null = null;

  private bindings = new Map<string, string>(); // sessionId → threadId
  private bySession = (threadId: string) => [...this.bindings].find(([, t]) => t === threadId)?.[0] ?? null;
  private turns = new Map<string, Turn>();
  private running = new Set<string>();
  private awaiting = new Map<string, string>(); // questionId/approvalId → sessionId (pushed, unanswered)
  private answeredHere = new Set<string>();
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private lastPush = new Map<string, { kind: PushKind; fullText: string }>(); // per session
  private errorThrottle = new Map<string, number>();
  private fileTokens = new Map<string, string>(); // short select-menu value → file path
  private echoes = new Set<string>(); // messages we forwarded from Discord (don't mirror them back)
  private wfCards = new Map<string, WfCard>(); // runId → its live progress card in the thread
  private notifyThrottle = new Map<string, number>(); // sessionId+title → last pushed
  private titles = new Map<string, string>(); // sessionId → title the thread was last named after
  private archivedNoted = new Set<string>();
  private connecting = new Set<string>(); // sessions whose thread is being opened (automation auto-connect)
  private boardTimer: NodeJS.Timeout | null = null; // debounce for board.changed
  private remindTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly translator: Translator = new Translator(undefined, 'discord'),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  // ── lifecycle (driven by the gateway) ────────────────────────────────────

  async attach(port: DiscordPort, owners: string[], homeChannelId: string | null): Promise<void> {
    this.port = port;
    this.owners = new Set(owners);
    this.homeChannelId = homeChannelId;
    await this.reloadBindings();
    if (!this.unsubscribe) this.unsubscribe = bus.on((e) => this.onEvent(e));
    // Manual automations' due pings + catching automation runs a missed event left without a thread.
    if (!this.remindTimer) {
      this.remindTimer = setInterval(() => void this.boardTick().catch((err) => log.warn('discord board tick failed', err)), REMIND_TICK_MS);
      this.remindTimer.unref?.();
    }
  }

  detach(): void {
    this.port = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.remindTimer) clearInterval(this.remindTimer);
    this.remindTimer = null;
    if (this.boardTimer) clearTimeout(this.boardTimer);
    this.boardTimer = null;
    for (const t of this.typingTimers.values()) clearInterval(t);
    this.typingTimers.clear();
  }

  setHomeChannel(id: string | null): void {
    this.homeChannelId = id;
  }

  get ready(): boolean {
    return Boolean(this.port && this.homeChannelId);
  }

  async reloadBindings(): Promise<void> {
    const rows = await prisma.discordBinding.findMany();
    this.bindings = new Map(rows.map((r) => [r.sessionId, r.threadId]));
  }

  bindingList(): Array<{ sessionId: string; threadId: string; threadUrl: string | null }> {
    return [...this.bindings].map(([sessionId, threadId]) => ({ sessionId, threadId, threadUrl: this.port?.threadUrl(threadId) ?? null }));
  }

  sessionState(sessionId: string): DiscordSessionStateDTO {
    const t = this.bindings.get(sessionId);
    return { ready: this.ready, connected: Boolean(t), threadUrl: t ? (this.port?.threadUrl(t) ?? null) : null };
  }

  // ── connect / disconnect ─────────────────────────────────────────────────

  async connect(sessionId: string): Promise<DiscordSessionStateDTO> {
    if (!this.port || !this.homeChannelId) throw new Error('Discord 还没配置好（设置里填 Bot Token 并选择频道）');
    const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } });
    if (!s) throw new Error('session not found');
    const existing = this.bindings.get(sessionId);
    if (existing) {
      await this.port.setArchived(existing, false).catch(() => undefined);
      return this.sessionState(sessionId);
    }
    const mention = [...this.owners].map((o) => `<@${o}>`).join(' ');
    const threadName = clip(`chapi · ${s.title}`, 95);
    this.titles.set(sessionId, threadName);
    const threadId = await this.port.createThread(
      this.homeChannelId,
      threadName,
      `${mention} 已连接任务「${clip(s.title, 60)}」。结果、提问和审批会发在这里；在这里打字就是发给它。发 \`!设置\` 改模型/思考强度。`.trim(),
    );
    await prisma.discordBinding.create({ data: { sessionId, threadId } });
    this.bindings.set(sessionId, threadId);
    // Already mid-run (e.g. started in the browser) → show typing and report when it finishes.
    if (agentInbox.busy(sessionId)) this.onRunning(sessionId);
    void this.recap(sessionId).catch((err) => log.warn('recap failed', err));
    return this.sessionState(sessionId);
  }

  /** An earlier conversation joins Discord: where it left off + anything waiting on the user. */
  private async recap(sessionId: string): Promise<void> {
    const [s, last, question, approval] = await Promise.all([
      prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } }),
      prisma.message.findMany({ where: { sessionId, role: 'assistant', type: 'assistant' }, orderBy: { createdAt: 'desc' }, take: 3 }),
      prisma.pendingQuestion.findFirst({ where: { sessionId, status: 'open', source: 'agent' }, orderBy: { createdAt: 'desc' } }),
      prisma.approval.findFirst({ where: { sessionId, status: 'open' }, orderBy: { createdAt: 'desc' } }),
    ]);
    const text = last.reverse().map((m) => m.text.trim()).filter(Boolean).join('\n\n');
    if (text) {
      const short = await this.translator.composeCompletion({ sessionId, title: s?.title ?? '', text });
      if (short) {
        await this.post(
          sessionId,
          { content: `📌 **接着上次**：${short}`, buttons: [[{ id: 'detail', label: '📄 详细', style: 'secondary' }]] },
          { kind: 'completion', fullText: text },
        );
      }
    }
    // A workflow still running gets its live card.
    const active = await loadActiveRun(sessionId);
    if (active) await this.onWorkflowUpdate(sessionId, toRunDTO(active));
    // Questions/approvals raised before the thread existed get their buttons now
    // (an approval only while a live run is still blocked on it, like the web dock).
    if (question) await this.pushQuestion(sessionId, question.id, question.question, (question.options as string[] | null) ?? null);
    if (approval && hitl.hasApproval(approval.id)) {
      const arts = (Array.isArray(approval.artifacts) ? approval.artifacts : []) as Array<{ title: string; pathOrUrl: string }>;
      await this.pushApproval(sessionId, approval.id, approval.summary, arts);
    }
  }

  async disconnect(sessionId: string): Promise<DiscordSessionStateDTO> {
    const threadId = this.bindings.get(sessionId);
    await prisma.discordBinding.deleteMany({ where: { sessionId } });
    this.bindings.delete(sessionId);
    this.stopTyping(sessionId);
    this.running.delete(sessionId);
    const turn = this.turns.get(sessionId);
    if (turn?.timer) clearTimeout(turn.timer);
    this.turns.delete(sessionId);
    if (threadId && this.port) {
      await this.port.send(threadId, { content: '已断开：这个任务不再同步到这里。' }).catch(() => undefined);
      await this.port.setArchived(threadId, true).catch(() => undefined);
    }
    return this.sessionState(sessionId);
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  /** Post to a session's thread (chunked; buttons/files ride on the last chunk). */
  private async post(
    sessionId: string,
    payload: OutPayload,
    meta: { kind: PushKind | 'info' | 'workflow'; refId?: string; fullText?: string },
  ): Promise<string | null> {
    const threadId = this.bindings.get(sessionId);
    if (!this.port || !threadId) return null;
    const chunks = chunkText(payload.content, MAX_MSG);
    let lastId: string | null = null;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        lastId = await this.port.send(threadId, { content: chunks[i]!, ...(last ? { selects: payload.selects, buttons: payload.buttons, files: payload.files } : {}) });
        await prisma.discordOutbound
          .create({ data: { messageId: lastId, sessionId, threadId, kind: meta.kind, refId: meta.refId ?? null, fullText: meta.fullText ?? payload.content } })
          .catch(() => undefined);
      }
    } catch (err) {
      // An archived thread rejects posts: unarchive once and retry.
      log.warn(`discord post failed (${meta.kind}), retrying after unarchive`, err);
      await this.port.setArchived(threadId, false).catch(() => undefined);
      lastId = await this.port
        .send(threadId, { content: chunks.at(-1)!, selects: payload.selects, buttons: payload.buttons, files: payload.files })
        .catch(() => null);
    }
    if (meta.kind !== 'info' && meta.kind !== 'detail' && meta.kind !== 'workflow') this.lastPush.set(sessionId, { kind: meta.kind, fullText: meta.fullText ?? payload.content });
    return lastId;
  }

  private async postFiles(sessionId: string, files: string[]): Promise<void> {
    const images: string[] = [];
    for (const f of files) {
      if (IMAGE_EXT.has(path.extname(f).toLowerCase())) images.push(f);
      else await this.postPreview(sessionId, f, 1);
    }
    const ok = images.filter((f) => fits(f));
    for (let i = 0; i < ok.length; i += 10) {
      await this.post(sessionId, { content: i === 0 ? '🖼 产出图片' : '🖼', files: ok.slice(i, i + 10) }, { kind: 'info' });
    }
    const big = images.filter((f) => !fits(f));
    if (big.length) await this.post(sessionId, { content: `图片太大没法上传（上限 10 MB），在电脑上看：\n${big.map((f) => `- ${path.basename(f)}`).join('\n')}` }, { kind: 'info' });
  }

  /**
   * One document → its page images inline (so it reads on a phone) + the original
   * (+ a PDF for Office files) as attachments, with a 「▶ 后 N 页」 button when longer.
   */
  async postPreview(sessionId: string, file: string, firstPage: number): Promise<void> {
    const name = path.basename(file);
    const threadId = this.bindings.get(sessionId);
    if (threadId) void this.port?.typing(threadId).catch(() => undefined);
    const attachOriginal = firstPage === 1 && fits(file) ? [file] : [];
    if (!canPreview(file)) {
      await this.post(sessionId, { content: `📎 **${name}**`, files: attachOriginal }, { kind: 'info' });
      return;
    }
    try {
      const pv = await makePreview(file, firstPage, PREVIEW_PAGES);
      if (pv.snippet !== undefined) {
        const lang = path.extname(file).slice(1).toLowerCase();
        await this.post(sessionId, { content: `📄 **${name}**\n\`\`\`${lang === 'md' ? 'md' : lang}\n${pv.snippet.replace(/```/g, 'ˋˋˋ').slice(0, 1500)}\n\`\`\``, files: attachOriginal }, { kind: 'info' });
        return;
      }
      const last = pv.first + pv.images.length - 1;
      const range = pv.totalPages <= 1 ? '' : ` · 第 ${pv.first}${last > pv.first ? `–${last}` : ''} 页 / 共 ${pv.totalPages} 页`;
      const extra = firstPage === 1 && pv.pdf && fits(pv.pdf) ? [pv.pdf] : [];
      const more = last < pv.totalPages;
      const id = await this.post(
        sessionId,
        {
          content: `📄 **${name}**${range}${firstPage === 1 && attachOriginal.length ? '\n_原文件和 PDF 在附件里，点开可看全文_' : ''}`,
          files: [...pv.images.filter((f) => fits(f)), ...attachOriginal, ...extra],
          buttons: more ? [[{ id: 'pvnext', label: `▶ 后 ${Math.min(PREVIEW_PAGES, pv.totalPages - last)} 页`, style: 'secondary' }]] : undefined,
        },
        { kind: 'info', fullText: file },
      );
      if (id && more) await prisma.discordOutbound.update({ where: { messageId: id }, data: { kind: 'preview', refId: String(last + 1) } }).catch(() => undefined);
    } catch (err) {
      await this.post(
        sessionId,
        { content: `📎 **${name}**（预览没生成：${err instanceof Error ? err.message : String(err)}）`, files: attachOriginal },
        { kind: 'info' },
      );
    }
  }

  // ── bus events ───────────────────────────────────────────────────────────

  private onEvent(e: ServerEvent): void {
    if (!this.port) return;
    const run = (p: Promise<unknown>) => void p.catch((err) => log.warn(`discord ${e.type} handling failed`, err));
    // Board-wide events (no session): automations started / finished, global alerts.
    if (e.type === 'board.changed') {
      if (this.boardTimer) clearTimeout(this.boardTimer);
      this.boardTimer = setTimeout(() => {
        this.boardTimer = null;
        run(this.connectAutomationRuns());
      }, BOARD_DEBOUNCE_MS);
      this.boardTimer.unref?.();
      return;
    }
    if (e.type === 'notification' && !e.sessionId) {
      run(this.pushHomeNotification(e.level, e.title, e.body));
      return;
    }
    const sid = e.type === 'session.updated' ? e.session.id : (e as { sessionId?: string | null }).sessionId;
    if (!sid || !this.bindings.has(sid)) return;
    switch (e.type) {
      case 'run.state':
        if (e.state === 'running') this.onRunning(sid);
        else if (e.state === 'idle' || e.state === 'done' || e.state === 'error') this.onIdle(sid);
        break;
      case 'user.message':
        run(this.mirrorUserMessage(sid, e.message.text));
        break;
      case 'question.open':
        if (e.question.source === 'agent') run(this.pushQuestion(sid, e.question.id, e.question.question, e.question.options));
        break;
      case 'question.closed':
        run(this.onQuestionClosed(sid, e.questionId));
        break;
      case 'approval.request':
        run(this.pushApproval(sid, e.approval.id, e.approval.summary, e.approval.artifacts.map((a) => ({ title: a.title, pathOrUrl: a.pathOrUrl }))));
        break;
      case 'approval.closed':
        run(this.onApprovalClosed(sid, e.approvalId));
        break;
      case 'error': {
        const last = this.errorThrottle.get(sid) ?? 0;
        if (Date.now() - last < 60_000) break;
        this.errorThrottle.set(sid, Date.now());
        run(this.post(sid, { content: `⚠️ 出错：${clip(e.message, 300)}` }, { kind: 'error' }));
        break;
      }
      case 'workflow.run.updated':
        run(this.onWorkflowUpdate(sid, e.run));
        break;
      case 'notification':
        run(this.pushNotification(sid, e.level, e.title, e.body));
        break;
      case 'session.updated':
        run(this.onSessionUpdated(e.session));
        break;
    }
  }

  /** The AI's notify_user, 质检 results, account limits, login trouble… (question/approval cards excluded). */
  private async pushNotification(sessionId: string, level: string, title: string, body: string): Promise<void> {
    if (NOTIFY_SKIP.has(title)) return;
    const key = `${sessionId}\u0000${title}\u0000${body}`;
    const last = this.notifyThrottle.get(key) ?? 0;
    if (Date.now() - last < 60_000) return;
    this.notifyThrottle.set(key, Date.now());
    const text = body.trim() ? `**${title}**：${clip(toPlainText(body), 400)}` : `**${title}**`;
    await this.post(sessionId, { content: `${NOTIFY_ICON[level] ?? '🔔'} ${text}` }, { kind: 'info' });
  }

  /** The AI (re)titled the conversation → rename the thread; archived on the computer → say so. */
  private async onSessionUpdated(s: SessionDTO): Promise<void> {
    const threadId = this.bindings.get(s.id);
    if (!threadId || !this.port) return;
    const name = clip(`chapi · ${s.title}`, 95);
    if (this.titles.get(s.id) !== name) {
      this.titles.set(s.id, name);
      await this.port.renameThread(threadId, name).catch((err) => log.debug(`rename thread failed: ${err}`));
    }
    if (s.status === 'completed' && !this.archivedNoted.has(s.id)) {
      this.archivedNoted.add(s.id);
      await this.post(s.id, { content: '📦 这个任务已标记完成并归档（只读）。新任务请在频道里直接发。' }, { kind: 'info' });
    }
  }

  // ── workflows (SOP runs) ─────────────────────────────────────────────────

  /** Stage-detail dropdown + stop button under a run card. */
  private runCardPayload(run: WorkflowRunDTO): OutPayload {
    const steps = runSteps(run);
    const selects = steps.length
      ? [
          {
            id: `wfnode:${run.id}`,
            placeholder: '🔍 看某个阶段的详情…',
            options: steps.slice(0, 25).map((n, i) => {
              const nr = nodeRunOf(run, n.id);
              return { value: n.id, label: clip(`${i + 1}. ${shortTitle(n.title)}`, 95), description: `${nr?.progress ?? 0}%` };
            }),
          },
        ]
      : undefined;
    const live = ACTIVE_RUN.has(run.status);
    return {
      content: clip(renderRunCard(run), MAX_MSG),
      selects,
      buttons: live ? [[{ id: `wfstop:${run.id}`, label: '⏹ 停止工作流', style: 'danger' }]] : undefined,
    };
  }

  /**
   * One live card per run: posted on first sight, then edited in place (throttled —
   * edits don't ping the phone). Stage done / stuck / sent back and the run's end
   * are separate short messages, so those do notify.
   */
  async onWorkflowUpdate(sessionId: string, run: WorkflowRunDTO): Promise<void> {
    let card = this.wfCards.get(run.id);
    if (!card) {
      // After a restart: keep editing the card we already posted.
      const row = await prisma.discordOutbound.findFirst({ where: { refId: run.id, kind: 'workflow' }, orderBy: { createdAt: 'desc' } });
      card = { messageId: row?.messageId ?? null, latest: run, lastEditAt: 0, chain: Promise.resolve() };
      this.wfCards.set(run.id, card);
    }
    const events = card.prev ? stageEvents(card.prev, run) : [];
    card.prev = run;
    card.latest = run;
    const c = card;
    const terminal = !ACTIVE_RUN.has(run.status);
    const step = async () => {
      if (!c.messageId) {
        c.messageId = await this.post(sessionId, this.runCardPayload(c.latest), { kind: 'workflow', refId: run.id });
        c.lastEditAt = Date.now();
      } else {
        const wait = WF_EDIT_MS - (Date.now() - c.lastEditAt);
        if (wait > 0 && !terminal) {
          if (!c.timer) c.timer = setTimeout(() => {
            c.timer = undefined;
            c.chain = c.chain.then(() => this.editCard(sessionId, c)).catch(() => undefined);
          }, wait);
        } else {
          await this.editCard(sessionId, c);
        }
      }
      if (events.length) await this.post(sessionId, { content: events.join('\n') }, { kind: 'info' });
      if (terminal && c.timer) {
        clearTimeout(c.timer);
        c.timer = undefined;
      }
    };
    c.chain = c.chain.then(step).catch((err) => log.warn('workflow card update failed', err));
    await c.chain;
  }

  private async editCard(sessionId: string, c: WfCard): Promise<void> {
    const threadId = this.bindings.get(sessionId);
    if (!this.port || !threadId || !c.messageId) return;
    c.lastEditAt = Date.now();
    await this.port.edit(threadId, c.messageId, this.runCardPayload(c.latest)).catch((err) => log.debug(`edit workflow card failed: ${err}`));
  }

  /** "!进度": the workflow card again (at the bottom), else the task flow. */
  private async progressCommand(sessionId: string): Promise<void> {
    const runs = await listSessionRuns(sessionId);
    const live = runs.filter((r) => ACTIVE_RUN.has(r.status));
    const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } });
    const plan = (await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } })).map(toPlanTaskDTO);
    const hasPlan = plan.some((t) => !t.locked && t.status !== 'replaced' && t.status !== 'error');
    const show = live.length ? live : !hasPlan && runs.length ? [runs.at(-1)!] : [];
    for (const r of show) {
      // Re-post at the bottom and keep editing the new copy.
      const id = await this.post(sessionId, this.runCardPayload(r), { kind: 'workflow', refId: r.id });
      const card = this.wfCards.get(r.id);
      if (card) {
        card.messageId = id;
        card.lastEditAt = Date.now();
      } else {
        this.wfCards.set(r.id, { messageId: id, prev: r, latest: r, lastEditAt: Date.now(), chain: Promise.resolve() });
      }
    }
    if (hasPlan && !live.length) await this.post(sessionId, { content: clip(renderPlan(s?.title ?? '', plan), MAX_MSG) }, { kind: 'info' });
    if (!show.length && !hasPlan) await this.post(sessionId, { content: '这个任务还没有工作流或任务流。发 `!流程` 可以选一个 SOP 开跑。' }, { kind: 'info' });
  }

  /** A system turn for the main AI (same wording as the web's workflow buttons). */
  private notifyMain(sessionId: string, text: string): void {
    void getOrchestrator()
      .handleUserMessage(sessionId, text)
      .catch((err) => log.warn('notify main AI failed', err));
  }

  /** Start a confirmed SOP in this session (user action, same as the web route). */
  private async startWorkflow(sessionId: string, ref: string): Promise<string | null> {
    const r = await workflowEngine.start(sessionId, { workflow: ref, trigger: 'manual' });
    if (!r.ok) return r.error;
    this.notifyMain(sessionId, `[工作流] 用户已启动「${r.run.workflowName}」。${r.message}`);
    return null;
  }

  /**
   * "!流程": confirmed SOPs to start (here, or in a new task from the channel) and
   * AI-drafted SOPs waiting for the user's confirmation.
   */
  async workflowCard(sessionId: string | null): Promise<OutPayload> {
    if (sessionId) {
      const active = await loadActiveRun(sessionId);
      if (active) {
        const dto = toRunDTO(active);
        return { content: `这个任务已有进行中的工作流「${dto.workflowName}」，一个任务同一时间只能跑一个（可以先停止它）。发 \`!进度\` 看进度。` };
      }
    }
    const all = await prisma.workflow.findMany({
      where: { status: { not: 'archived' } },
      orderBy: { name: 'asc' },
      include: { versions: { select: { version: true, state: true } } },
    });
    const confirmed = all.filter((w) => w.status === 'confirmed' && w.confirmedVersion);
    const drafts = all.filter((w) => w.versions.some((v) => v.state === 'draft'));
    if (!confirmed.length && !drafts.length) return { content: '还没有 SOP。在任务里把 SOP 文档发给 chapi，让它起草成工作流，确认后就能在这里一键运行。' };
    const selects: SelectMenu[] = [];
    if (confirmed.length) {
      selects.push({
        id: sessionId ? `wfstart:${sessionId}` : 'wfnew',
        placeholder: sessionId ? '▶ 在这个任务里运行 SOP…' : '▶ 新开一个任务运行 SOP…',
        // value = slug: the engine resolves SOPs by slug / name / alias.
        options: confirmed.slice(0, 25).map((w) => ({ value: w.slug, label: clip(w.name, 95), description: clip(`v${w.confirmedVersion}${w.whenToUse ? ` · ${w.whenToUse}` : ''}`, 95) })),
      });
    }
    if (drafts.length) {
      selects.push({
        id: 'wfdraft',
        placeholder: '📝 查看 / 确认 AI 起草的 SOP…',
        options: drafts.slice(0, 25).map((w) => {
          const v = Math.max(...w.versions.filter((x) => x.state === 'draft').map((x) => x.version));
          return { value: w.id, label: clip(w.name, 95), description: w.confirmedVersion ? `草稿 v${v}（在用 v${w.confirmedVersion}）` : `草稿 v${v}（未确认，不能运行）` };
        }),
      });
    }
    const lines = ['📚 **工作流（SOP）**'];
    if (confirmed.length) lines.push(`已确认 ${confirmed.length} 个，选一个就开跑；进度会实时显示在任务的子话题里。`);
    if (drafts.length) lines.push(`有 ${drafts.length} 个草稿等你确认（AI 只能起草，确认必须由你来）。`);
    return { content: lines.join('\n'), selects };
  }

  /** A draft's stages and what changed, with a confirm button for exactly this version. */
  private async draftCard(workflowId: string): Promise<OutPayload> {
    const w = await findWorkflowRef(workflowId);
    if (!w) return { content: '这个 SOP 不存在了。' };
    const draft = [...w.versions].sort((a, b) => b.version - a.version).find((v) => v.state === 'draft');
    if (!draft) return { content: `「${w.name}」没有待确认的草稿。` };
    const graph = draft.graph as unknown as WorkflowGraph;
    const steps = runSteps({ graph } as WorkflowRunDTO);
    const changes = draftChanges(w) ?? [];
    const lines = [`📝 **${clip(w.name, 80)}** · 草稿 v${draft.version}${w.confirmedVersion ? `（当前在用 v${w.confirmedVersion}）` : ''}`];
    if (draft.note) lines.push(`_${clip(draft.note, 200)}_`);
    if (changes.length) lines.push('', '**改动**', ...changes.slice(0, 12).map((c) => `- ${clip(c, 150)}`));
    lines.push('', `**阶段（${steps.length}）**`);
    steps.forEach((n, i) => {
      const subs = n.substeps?.length ? `（${n.substeps.length} 个子步骤）` : '';
      lines.push(`${i + 1}. ${clip(shortTitle(n.title), 70)}${subs}`);
    });
    lines.push('', '_确认后这个版本就成为正式 SOP，之后的运行都按它来。想细看流程图请在电脑上打开「工作流」页面。_');
    return {
      content: clip(lines.join('\n'), MAX_MSG),
      buttons: [[{ id: `wfok:${w.id}:${draft.version}`, label: `✅ 确认 v${draft.version}`, style: 'success' }]],
    };
  }

  private onRunning(sessionId: string): void {
    this.running.add(sessionId);
    const turn = this.turns.get(sessionId);
    if (turn?.timer) {
      clearTimeout(turn.timer);
      turn.timer = undefined;
    } else if (!turn) {
      this.turns.set(sessionId, { startedAt: new Date(Date.now() - 1000) });
    }
    this.refreshTyping(sessionId);
  }

  private onIdle(sessionId: string): void {
    this.running.delete(sessionId);
    this.refreshTyping(sessionId);
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = setTimeout(() => void this.finalizeTurn(sessionId).catch((err) => log.warn('finalize turn failed', err)), TURN_SETTLE_MS);
  }

  /** Typing shows while the session runs and isn't waiting on the user. */
  private refreshTyping(sessionId: string): void {
    const waiting = [...this.awaiting.values()].includes(sessionId);
    const want = this.running.has(sessionId) && !waiting && Boolean(this.port);
    const has = this.typingTimers.has(sessionId);
    if (want && !has) {
      const threadId = this.bindings.get(sessionId);
      if (!threadId) return;
      const pulse = () => void this.port?.typing(threadId).catch(() => undefined);
      pulse();
      this.typingTimers.set(sessionId, setInterval(pulse, TYPING_REFRESH_MS));
    } else if (!want && has) {
      this.stopTyping(sessionId);
    }
  }

  private stopTyping(sessionId: string): void {
    const t = this.typingTimers.get(sessionId);
    if (t) clearInterval(t);
    this.typingTimers.delete(sessionId);
  }

  isTyping(sessionId: string): boolean {
    return this.typingTimers.has(sessionId);
  }

  async finalizeTurn(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    const turn = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    if (!turn || turn.suppress) return;
    const out = await collectTurn(sessionId, turn.startedAt);
    if (!out) return;
    const short = out.text ? await this.translator.composeCompletion({ sessionId, title: out.title, text: out.text }) : null;
    const links = out.artifacts.filter((a) => /^https?:/i.test(a.pathOrUrl) && !(short ?? '').includes(a.pathOrUrl));
    const linkLines = links.map((a) => `📎 [${a.title}](${a.pathOrUrl})`).join('\n');
    if (short || linkLines) {
      await this.post(
        sessionId,
        {
          content: `✅ ${[short, linkLines].filter(Boolean).join('\n')}`,
          buttons: out.text ? [[{ id: 'detail', label: '📄 详细', style: 'secondary' }]] : undefined,
        },
        { kind: 'completion', fullText: out.text || linkLines },
      );
    }
    const files = turnFiles(sessionId, out.artifacts.map((a) => a.pathOrUrl), out.text);
    if (files.length) await this.postFiles(sessionId, files);
  }

  private async pushQuestion(sessionId: string, questionId: string, question: string, options: string[] | null): Promise<void> {
    this.awaiting.set(questionId, sessionId);
    this.refreshTyping(sessionId);
    const short = await this.translator.composeQuestion({ sessionId, question, options });
    const opts = short.options ?? [];
    const asButtons = opts.length > 0 && opts.length <= 20;
    const buttons: Btn[][] = [];
    if (asButtons) {
      for (let i = 0; i < opts.length; i += 5) {
        buttons.push(opts.slice(i, i + 5).map((o, j) => ({ id: `q:${questionId}:${i + j}`, label: clip(`${i + j + 1}. ${o}`, 78), style: 'primary' as const })));
      }
    }
    // Options never cover everything — always offer a free-text answer (sent verbatim).
    buttons.push([{ id: `qt:${questionId}`, label: '✍️ 文字回答', style: 'secondary' }]);
    const lines = [`❓ **${short.question}**`];
    if (opts.length && !asButtons) opts.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
    lines.push(opts.length ? '_点按钮选择；想说得更准就点「✍️ 文字回答」或直接打字_' : '_点「✍️ 文字回答」或直接在这里回复_');
    const optionText = options?.length ? `\n选项：\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : '';
    await this.post(sessionId, { content: lines.join('\n'), buttons }, { kind: 'question', refId: questionId, fullText: `${question}${optionText}` });
  }

  private async pushApproval(sessionId: string, approvalId: string, summary: string, artifacts: Array<{ title: string; pathOrUrl: string }>): Promise<void> {
    this.awaiting.set(approvalId, sessionId);
    this.refreshTyping(sessionId);
    const short = await this.translator.composeApproval({ sessionId, summary });
    const links = artifacts.filter((a) => /^https?:/i.test(a.pathOrUrl)).map((a) => `📎 [${a.title}](${a.pathOrUrl})`);
    await this.post(
      sessionId,
      {
        content: [`📋 **待审批**：${short}`, ...links].join('\n'),
        buttons: [[
          { id: `a:${approvalId}:approve`, label: '✅ 批准', style: 'success' },
          { id: `a:${approvalId}:revise`, label: '✏️ 修改', style: 'primary' },
          { id: `a:${approvalId}:reject`, label: '❌ 驳回', style: 'danger' },
        ]],
      },
      { kind: 'approval', refId: approvalId, fullText: summary },
    );
    const files = turnFiles(sessionId, artifacts.map((a) => a.pathOrUrl), '');
    if (files.length) await this.postFiles(sessionId, files);
  }

  /** Grey out the buttons of a question/approval card and say how it was resolved. */
  private async closeCard(refId: string, note: string): Promise<void> {
    if (!this.port) return;
    const row = await prisma.discordOutbound.findFirst({ where: { refId }, orderBy: { createdAt: 'desc' } });
    if (!row) return;
    const kind = row.kind;
    const original = kind === 'question' ? '❓ 提问' : '📋 审批';
    // Rebuild a minimal disabled card (we don't keep the rendered buttons).
    await this.port
      .edit(row.threadId, row.messageId, { content: `${original}（已处理）\n${note}`, buttons: [] })
      .catch((err) => log.debug(`close card failed: ${err instanceof Error ? err.message : err}`));
  }

  private async onQuestionClosed(sessionId: string, questionId: string): Promise<void> {
    const pushed = this.awaiting.delete(questionId);
    this.refreshTyping(sessionId);
    if (!pushed) return;
    const q = await prisma.pendingQuestion.findUnique({ where: { id: questionId }, select: { question: true, answer: true } });
    const here = this.answeredHere.delete(questionId);
    await this.closeCard(questionId, `**${clip(toPlainText(q?.question ?? ''), 120)}**\n${here ? '✓ 已回答' : '✓ 已在电脑上回答'}：${clip(q?.answer ?? '', 200)}`);
  }

  private async onApprovalClosed(sessionId: string, approvalId: string): Promise<void> {
    const pushed = this.awaiting.delete(approvalId);
    this.refreshTyping(sessionId);
    if (!pushed) return;
    const a = await prisma.approval.findUnique({ where: { id: approvalId }, select: { summary: true, status: true, feedback: true } });
    const here = this.answeredHere.delete(approvalId);
    const verdict = a?.status === 'approved' ? '✅ 已批准' : a?.status === 'rejected' || a?.status === 'reject' ? '❌ 已驳回' : `✏️ 已发回修改：${clip(a?.feedback ?? '', 200)}`;
    await this.closeCard(approvalId, `${clip(toPlainText(a?.summary ?? ''), 160)}\n${verdict}${here ? '' : '（在电脑上处理）'}`);
  }

  // ── board: today / projects / automations ────────────────────────────────

  private connectedSet(): Set<string> {
    return new Set(this.bindings.keys());
  }

  /** Board-wide alerts with no session (an automation that failed before it had one, …) go to the channel. */
  private async pushHomeNotification(level: string, title: string, body: string): Promise<void> {
    if (!this.port || !this.homeChannelId || NOTIFY_SKIP.has(title)) return;
    const key = `home\u0000${title}\u0000${body}`;
    if (Date.now() - (this.notifyThrottle.get(key) ?? 0) < 60_000) return;
    this.notifyThrottle.set(key, Date.now());
    await this.port.send(this.homeChannelId, { content: `${NOTIFY_ICON[level] ?? '🔔'} **${title}**${body.trim() ? `：${clip(toPlainText(body), 400)}` : ''}` });
  }

  /**
   * Automation runs (cron, catch-up, or "run" clicked on the computer) get their own
   * thread, so a task that started while you were away reports to the phone.
   */
  async connectAutomationRuns(): Promise<void> {
    if (!this.port || !this.homeChannelId) return;
    if (!(await settings.getDiscordPrefs()).autoAutomations) return;
    const runs = await prisma.automationRun.findMany({
      where: { status: { in: ['running', 'waiting_user'] }, sessionId: { not: null }, startedAt: { gte: new Date(Date.now() - AUTO_CONNECT_WINDOW_MS) } },
      include: { automation: { select: { name: true } } },
      orderBy: { startedAt: 'asc' },
    });
    for (const r of runs) {
      const sid = r.sessionId!;
      if (this.bindings.has(sid) || this.connecting.has(sid)) continue;
      // Disconnected by hand before → respect it (a 'autoconn' marker remembers we did it once).
      const done = await prisma.discordOutbound.findFirst({ where: { kind: 'autoconn', refId: r.id } });
      if (done) continue;
      this.connecting.add(sid);
      try {
        await this.connect(sid);
        const t = this.bindings.get(sid);
        const id = await this.port.send(this.homeChannelId, { content: `⏰ 自动化「${clip(r.automation.name, 60)}」开跑了 → <#${t}>` });
        await prisma.discordOutbound.create({ data: { messageId: id, sessionId: sid, threadId: this.homeChannelId, kind: 'autoconn', refId: r.id } }).catch(() => undefined);
      } catch (err) {
        log.warn(`auto-connect automation run ${r.id} failed`, err);
      } finally {
        this.connecting.delete(sid);
      }
    }
  }

  /** Every minute: manual automations whose slot just came get a ping with ▶; missed auto-connects are retried. */
  async boardTick(now: Date = new Date()): Promise<void> {
    if (!this.port || !this.homeChannelId) return;
    await this.connectAutomationRuns();
    if (!(await settings.getDiscordPrefs()).remindManual) return;
    const rows = await prisma.automation.findMany({ where: { enabled: true, mode: 'manual' } });
    for (const a of rows) {
      let slot: Date | null = null;
      try {
        slot = lastDue(a.schedule as unknown as ScheduleSpec, now);
      } catch {
        continue; // unparseable schedule: the board page shows the problem
      }
      if (!slot || now.getTime() - slot.getTime() > REMIND_WINDOW_MS || slot.getTime() < a.createdAt.getTime()) continue;
      const ran = await prisma.automationRun.findFirst({ where: { automationId: a.id, OR: [{ startedAt: { gte: slot } }, { dueAt: slot }] } });
      if (ran) continue;
      const refId = `remind:${a.id}@${slot.toISOString()}`;
      if (await prisma.discordOutbound.findFirst({ where: { kind: 'remind', refId } })) continue;
      const [dto] = await automationDTOs({ id: a.id });
      if (!dto) continue;
      const id = await this.port.send(this.homeChannelId, renderReminder(dto, slot));
      await prisma.discordOutbound.create({ data: { messageId: id, sessionId: null, threadId: this.homeChannelId, kind: 'remind', refId } }).catch(() => undefined);
    }
  }

  async todayCard(): Promise<OutPayload> {
    return renderToday(await getBoardToday(), this.connectedSet());
  }

  async projectsCard(): Promise<OutPayload> {
    const [projects, stats, unassigned] = await Promise.all([
      prisma.project.findMany({ where: { archived: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      prisma.session.groupBy({ by: ['projectId'], where: { status: { not: 'deleted' }, projectId: { not: null } }, _count: { _all: true }, _max: { updatedAt: true } }),
      prisma.session.count({ where: { status: { not: 'deleted' }, projectId: null } }),
    ]);
    const byId = new Map(stats.map((s) => [s.projectId, s]));
    const dtos = projects.map((p) => {
      const s = byId.get(p.id);
      return toProjectDTO(p, { sessionCount: s?._count._all ?? 0, lastActivityAt: s?._max.updatedAt ?? null });
    });
    return renderProjects(dtos, unassigned);
  }

  private async projectPicker(sessionId: string): Promise<OutPayload> {
    const [s, projects] = await Promise.all([
      prisma.session.findUnique({ where: { id: sessionId }, include: { project: { select: { name: true } } } }),
      prisma.project.findMany({ where: { archived: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    ]);
    return renderProjectPicker(sessionId, s?.project?.name ?? null, projects.map((p) => toProjectDTO(p, { sessionCount: 0, lastActivityAt: null })));
  }

  async automationsCard(query?: string): Promise<OutPayload> {
    if (query) {
      const a = await findAutomation(query);
      if (a) {
        const [dto] = await automationDTOs({ id: a.id });
        if (dto) return renderAutomation(dto);
      }
    }
    const list = await automationDTOs();
    const out = renderAutomations(list);
    if (query) out.content = `没找到叫「${clip(query, 30)}」的自动化。\n\n${out.content}`;
    return out;
  }

  /** Re-render an automation card in place, with a note on what just happened. */
  private async refreshAutomation(channelId: string, messageId: string, automationId: string, note: string): Promise<void> {
    const [dto] = await automationDTOs({ id: automationId });
    if (!dto || !this.port) return;
    await this.port.edit(channelId, messageId, renderAutomation(dto, note)).catch((err) => log.debug(`refresh automation card failed: ${err}`));
  }

  /** ▶ / mode / enable / open / dismiss on an automation card (or a due-reminder). */
  private async onAutomationButton(customId: string, channelId: string, messageId: string): Promise<string | null | undefined> {
    const m = /^(autorun|automode|autoen|autoopen|autodis):(.+)$/.exec(customId);
    if (!m) return undefined;
    const [, action, id] = m as unknown as [string, string, string];
    switch (action) {
      case 'autorun': {
        const r = await runNow(id);
        if (!r.ok) {
          await this.refreshAutomation(channelId, messageId, id, `没能运行：${clip(r.error, 120)}`);
          return null;
        }
        let note = r.run.status === 'queued' ? '⏳ 已排队，轮到时会自动开跑' : '▶ 已开跑';
        if (r.run.sessionId) {
          if (!this.bindings.has(r.run.sessionId)) {
            this.connecting.add(r.run.sessionId);
            try {
              await this.connect(r.run.sessionId);
              await prisma.discordOutbound
                .create({ data: { messageId: `autoconn-${r.run.id}`, sessionId: r.run.sessionId, threadId: channelId, kind: 'autoconn', refId: r.run.id } })
                .catch(() => undefined);
            } finally {
              this.connecting.delete(r.run.sessionId);
            }
          }
          note += ` → <#${this.bindings.get(r.run.sessionId)}>`;
        }
        await this.refreshAutomation(channelId, messageId, id, note);
        return null;
      }
      case 'automode':
      case 'autoen': {
        const [cur] = await automationDTOs({ id });
        if (!cur) return '这个自动化不存在了。';
        const patch = action === 'automode' ? { mode: cur.mode === 'auto' ? 'manual' : 'auto' } : { enabled: !cur.enabled };
        const r = await updateAutomation(id, patch);
        const note = !r.ok
          ? `没改成：${clip(r.error, 120)}`
          : action === 'automode'
            ? `✓ 改成${r.value.mode === 'auto' ? '自动（到点自己跑）' : '手动（到点提醒你）'}`
            : `✓ ${r.value.enabled ? '已启用' : '已停用'}`;
        await this.refreshAutomation(channelId, messageId, id, note);
        return null;
      }
      case 'autoopen': {
        const s = await prisma.session.findUnique({ where: { id }, select: { title: true } });
        if (!s) return '那次运行的对话已经删了。';
        await this.connect(id);
        return `🧵 <#${this.bindings.get(id)}>`;
      }
      case 'autodis': {
        // Same as the board's "关闭" on a run left waiting.
        const r = await prisma.automationRun.updateMany({
          where: { id, status: { in: ['waiting_user', 'stale'] } },
          data: { status: 'failed', note: '用户关闭', endedAt: new Date() },
        });
        const run = await prisma.automationRun.findUnique({ where: { id } });
        if (!run) return '找不到这次运行。';
        if (r.count) {
          const newest = await prisma.automationRun.findFirst({ where: { automationId: run.automationId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], select: { id: true } });
          if (newest?.id === run.id) await prisma.automation.update({ where: { id: run.automationId }, data: { lastStatus: 'failed' } }).catch(() => undefined);
          bus.emit({ type: 'board.changed' });
        }
        await this.refreshAutomation(channelId, messageId, run.automationId, r.count ? '✓ 已关闭那次运行' : '那次运行已经结束了');
        return null;
      }
    }
    return undefined;
  }

  // ── inbound: buttons & form ──────────────────────────────────────────────

  isOwner(userId: string): boolean {
    return this.owners.has(userId);
  }

  /** Buttons that open a form must do so immediately (no deferral) — the gateway asks first. */
  modalFor(customId: string): { id: string; title: string; label: string } | null {
    const a = /^a:([^:]+):revise$/.exec(customId);
    if (a) return { id: `am:${a[1]}`, title: '修改意见', label: '要怎么改？' };
    const q = /^qt:(.+)$/.exec(customId);
    if (q) return { id: `qm:${q[1]}`, title: '文字回答', label: '你的回答（原样发给 chapi）' };
    return null;
  }

  /** A button click (already acknowledged by the gateway). Returns an optional private note. */
  async onButton(customId: string, userId: string, channelId: string, messageId: string): Promise<string | null> {
    if (!this.isOwner(userId)) return '只有 chapi 的主人能操作。';
    if (customId === 'pvnext') {
      const row = await prisma.discordOutbound.findUnique({ where: { messageId } });
      if (!row?.fullText || !row.sessionId || !row.refId) return '找不到这个文件了。';
      await this.postPreview(row.sessionId, row.fullText, parseInt(row.refId, 10));
      return null;
    }
    if (customId === 'detail') {
      const row = await prisma.discordOutbound.findUnique({ where: { messageId } });
      if (!row?.fullText || !row.sessionId) return '找不到原文。';
      await this.sendDetail(row.sessionId, row.kind as PushKind, row.fullText);
      return null;
    }
    const q = /^q:([^:]+):(\d+)$/.exec(customId);
    if (q) {
      const question = await prisma.pendingQuestion.findUnique({ where: { id: q[1]! } });
      if (!question || question.status !== 'open') return '这个提问已经回答过了。';
      const opts = (question.options as string[] | null) ?? [];
      const answer = opts[parseInt(q[2]!, 10)];
      if (!answer) return '选项不存在。';
      this.answeredHere.add(question.id);
      await getOrchestrator().answerQuestion(question.sessionId, question.id, answer);
      return null;
    }
    const a = /^a:([^:]+):(approve|reject)$/.exec(customId);
    if (a) {
      const approval = await prisma.approval.findUnique({ where: { id: a[1]! } });
      if (!approval || approval.status !== 'open') return '这个审批已经处理过了。';
      this.answeredHere.add(approval.id);
      await getOrchestrator().decideApproval(approval.sessionId, approval.id, a[2] as 'approve' | 'reject');
      return null;
    }
    const cb = /^cfgb:([^:]+):(acct|lang|chrome)$/.exec(customId);
    if (cb) return this.applyConfig(cb[1]!, cb[2]!, null, channelId, messageId);
    return this.onActionButton(customId, channelId, messageId);
  }

  /** Workflow stop / SOP confirm / archive / browser buttons (two-step where it can't be undone). */
  private async onActionButton(customId: string, channelId: string, messageId: string): Promise<string | null> {
    const edit = (payload: OutPayload) => this.port?.edit(channelId, messageId, payload).catch((err) => log.debug(`edit failed: ${err}`));
    const auto = await this.onAutomationButton(customId, channelId, messageId);
    if (auto !== undefined) return auto;
    const ws = /^wfstop:(.+)$/.exec(customId);
    if (ws) {
      const run = await prisma.workflowRun.findUnique({ where: { id: ws[1]! }, include: { workflow: { select: { name: true } } } });
      if (!run || !ACTIVE_RUN.has(run.status as WorkflowRunDTO['status'])) return '这个工作流已经结束了。';
      await this.post(
        run.sessionId,
        {
          content: `停止「${run.workflow.name}」？已完成的阶段会保留，未完成的不再执行。`,
          buttons: [[
            { id: `wfstopy:${run.id}`, label: '⏹ 确认停止', style: 'danger' },
            { id: 'cancel', label: '取消', style: 'secondary' },
          ]],
        },
        { kind: 'info' },
      );
      return null;
    }
    const wy = /^wfstopy:(.+)$/.exec(customId);
    if (wy) {
      const run = await prisma.workflowRun.findUnique({ where: { id: wy[1]! }, select: { sessionId: true } });
      if (!run) return '找不到这个工作流。';
      const r = await workflowEngine.cancel(run.sessionId, wy[1]!, '用户在 Discord 上停止了工作流');
      if (!r.ok) {
        await edit({ content: `没能停止：${r.error}`, buttons: [] });
        return null;
      }
      this.notifyMain(run.sessionId, `[工作流] ${r.message}。工作流已结束，不要再领取或派发它的阶段；按用户接下来的要求继续。`);
      await edit({ content: '⏹ 已停止工作流。', buttons: [] });
      return null;
    }
    if (customId === 'cancel') {
      await edit({ content: '已取消。', buttons: [] });
      return null;
    }
    const ok = /^wfok:([^:]+):(\d+)$/.exec(customId);
    if (ok) {
      const w = await findWorkflowRef(ok[1]!);
      if (!w) return '这个 SOP 不存在了。';
      const draft = [...w.versions].sort((a, b) => b.version - a.version).find((v) => v.state === 'draft');
      // Confirm exactly the version that was shown — never a newer draft the user hasn't seen.
      if (!draft || draft.version !== parseInt(ok[2]!, 10)) {
        await edit({ content: `「${w.name}」的草稿已经变了（或已确认），重新发 \`!流程\` 看最新的。`, buttons: [] });
        return null;
      }
      const r = await confirmLatestDraft(w.id);
      await edit({ content: r.ok ? `✅ 已确认「${w.name}」v${draft.version}，现在可以运行了（发 \`!流程\`）。` : `没能确认：${r.errors.join('；')}`, buttons: [] });
      return null;
    }
    const ar = /^arch:(.+)$/.exec(customId);
    if (ar) {
      const s = await prisma.session.findUnique({ where: { id: ar[1]! }, select: { status: true } });
      if (!s || s.status !== 'active') {
        await edit({ content: '这个任务已经归档了。', buttons: [] });
        return null;
      }
      this.archivedNoted.add(ar[1]!);
      await getOrchestrator().markCompleted(ar[1]!);
      await edit({ content: '📦 已标记出色完成并归档：平台会学习这次的成果和方案，这个任务之后只读。', buttons: [] });
      return null;
    }
    const sh = /^shot:(.+)$/.exec(customId);
    if (sh) {
      await this.browserCommand(sh[1]!);
      return null;
    }
    return null;
  }

  /** "!浏览器": what cloakbrowser shows right now (the live panel on the computer). */
  private async browserCommand(sessionId: string): Promise<void> {
    const threadId = this.bindings.get(sessionId);
    if (threadId) void this.port?.typing(threadId).catch(() => undefined);
    let shots: Awaited<ReturnType<typeof captureBrowser>> = [];
    try {
      shots = await captureBrowser(2);
      if (!shots.length) {
        await this.post(sessionId, { content: '🌐 浏览器开着，但现在没有打开的网页。' }, { kind: 'info' });
        return;
      }
      const lines = shots.map((x, i) => `${shots.length > 1 ? `${i + 1}. ` : ''}${clip(x.title || '(无标题)', 60)} — <${clip(x.url, 150)}>`);
      await this.post(
        sessionId,
        {
          content: `🌐 **浏览器当前画面**（所有任务共用一个浏览器）\n${lines.join('\n')}`,
          files: shots.map((x) => x.file),
          buttons: [[{ id: `shot:${sessionId}`, label: '🔄 再截一张', style: 'secondary' }]],
        },
        { kind: 'info' },
      );
    } catch (err) {
      await this.post(sessionId, { content: `🌐 截不到图：${err instanceof Error ? err.message : String(err)}` }, { kind: 'info' });
    } finally {
      // Screenshots are throwaway once uploaded.
      for (const x of shots) void fs.promises.unlink(x.file).catch(() => undefined);
    }
  }

  /** A dropdown: settings card, "continue an earlier conversation", or "which file to preview". */
  async onSelect(customId: string, userId: string, value: string, channelId: string, messageId: string): Promise<string | null> {
    if (!this.isOwner(userId)) return '只有 chapi 的主人能操作。';
    if (customId === 'resume') {
      const s = await prisma.session.findUnique({ where: { id: value }, select: { title: true, status: true } });
      if (!s) return '这个对话不存在了。';
      await this.connect(value);
      const t = this.bindings.get(value);
      await this.port?.send(channelId, { content: `🧵 已接上「${clip(s.title, 60)}」→ <#${t}>${s.status !== 'active' ? '（已完成，只读）' : ''}` });
      return null;
    }
    const pv = /^pvsel:(.+)$/.exec(customId);
    if (pv) {
      const file = this.fileTokens.get(value);
      if (!file) return '列表过期了，再发一次 !预览。';
      await this.postPreview(pv[1]!, file, 1);
      return null;
    }
    const wn = /^wfnode:(.+)$/.exec(customId);
    if (wn) {
      const row = await prisma.workflowRun.findUnique({ where: { id: wn[1]! }, select: { sessionId: true } });
      const run = row ? (await listSessionRuns(row.sessionId)).find((r) => r.id === wn[1]) : undefined;
      if (!row || !run) return '找不到这个工作流。';
      await this.post(row.sessionId, { content: clip(renderStageDetail(run, value), MAX_MSG) }, { kind: 'info' });
      return null;
    }
    const wst = /^wfstart:(.+)$/.exec(customId);
    if (wst) {
      const err = await this.startWorkflow(wst[1]!, value);
      return err ? `没能启动：${clip(err, 300)}` : null;
    }
    if (customId === 'wfnew') {
      const w = await prisma.workflow.findUnique({ where: { slug: value }, select: { name: true } });
      if (!w) return '这个 SOP 不存在了。';
      const s = await createSession({ firstMessage: `运行 SOP「${w.name}」` });
      await this.connect(s.id);
      const err = await this.startWorkflow(s.id, value);
      const t = this.bindings.get(s.id);
      await this.port?.send(channelId, { content: err ? `没能启动「${w.name}」：${clip(err, 300)}` : `🧭 已开始「${clip(w.name, 60)}」→ <#${t}>` });
      return null;
    }
    if (customId === 'proj') {
      const p = value === 'unassigned' ? null : await prisma.project.findUnique({ where: { id: value } });
      if (value !== 'unassigned' && !p) return '这个项目不存在了。';
      const rows = await prisma.session.findMany({ where: { status: { not: 'deleted' }, projectId: p ? p.id : null }, orderBy: { updatedAt: 'desc' }, take: 25 });
      await this.port?.send(channelId, renderProjectSessions(p?.name ?? '未归类', p?.summary ?? null, rows.map(toSessionDTO), this.connectedSet()));
      return null;
    }
    if (customId === 'auto') {
      const [dto] = await automationDTOs({ id: value });
      if (!dto) return '这个自动化不存在了。';
      await this.port?.send(channelId, renderAutomation(dto));
      return null;
    }
    const ps = /^projset:(.+)$/.exec(customId);
    if (ps) {
      const pid = value === 'none' ? null : value;
      const p = pid ? await prisma.project.findFirst({ where: { id: pid, archived: false }, select: { name: true } }) : null;
      if (pid && !p) return '这个项目不存在了。';
      // Same as the board: a hand-set project, without bumping updatedAt (it would flood "today").
      await prisma.$executeRaw`UPDATE \`Session\` SET projectId = ${pid}, projectSource = 'user' WHERE id = ${ps[1]!}`;
      bus.emit({ type: 'board.changed' });
      await this.port?.edit(channelId, messageId, { content: `🗂 已移到：**${p?.name ?? '未归类'}**`, selects: [] }).catch(() => undefined);
      return null;
    }
    if (customId === 'wfdraft') {
      await this.port?.send(channelId, await this.draftCard(value));
      return null;
    }
    const m = /^cfg:([^:]+):(model|sub|effort|quality)$/.exec(customId);
    if (!m) return null;
    return this.applyConfig(m[1]!, m[2]!, value, channelId, messageId);
  }

  // ── settings card (same knobs as the web run-config bar) ─────────────────

  private async accountInfo() {
    const [accts, models] = await Promise.all([settings.getClaudeAccounts(), settings.getClaudeModels()]);
    return {
      tokens: Boolean(accts.primaryToken || accts.fallbackToken),
      hasPrimary: Boolean(accts.primaryToken),
      hasFallback: Boolean(accts.fallbackToken),
      label: (m: string) =>
        m === 'auto' ? '自动(主→备)' : m === 'primary' ? `主号${accts.primaryEmail ? ` · ${accts.primaryEmail}` : ''}` : `备号${accts.fallbackEmail ? ` · ${accts.fallbackEmail}` : ''}`,
      allowed: (mode: string): string[] => (mode === 'fallback' ? models.fallback : models.primary),
    };
  }

  async configCard(sessionId: string, note?: string): Promise<OutPayload> {
    const row = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!row) return { content: '对话不存在。' };
    const s = toSessionDTO(row);
    const acct = await this.accountInfo();
    const sub = s.subagentModel || s.model;
    const allowed = acct.tokens ? acct.allowed(s.accountMode) : [];
    let models = MODEL_OPTIONS as ReadonlyArray<{ id: string; label: string }>;
    if (allowed.length) models = models.filter((m) => allowed.includes(m.id));
    if (!models.length) models = MODEL_OPTIONS;
    const withCurrent = (cur: string) => (models.some((m) => m.id === cur) ? models : [{ id: cur, label: cur }, ...models]).slice(0, 25);
    const quality = QUALITY_OPTIONS.find((q) => q.v === s.qualityReviewMinutes)?.label ?? `每 ${s.qualityReviewMinutes} 分钟`;
    const chromeOn = Boolean(s.userChrome);
    const summary = [
      `⚙️ **本任务设置**${note ? `　${note}` : ''}`,
      `${acct.tokens ? `账号：${acct.label(s.accountMode)} · ` : ''}主代理：${modelLabel(s.model)} · 子代理：${modelLabel(sub)}`,
      `思考强度：${EFFORT_LABEL[s.effort as EffortLevel] ?? s.effort} · 语言：${s.language === 'en' ? 'English' : '中文'} · 质检：${quality} · 用我的 Chrome：${chromeOn ? '开' : '关'}`,
      s.status !== 'active' ? '_这个任务已完成（只读），改了也不会再运行_' : '',
    ].filter(Boolean);
    const buttons: Btn[] = [];
    if (acct.tokens) buttons.push({ id: `cfgb:${sessionId}:acct`, label: `账号：${clip(acct.label(s.accountMode), 40)}`, style: 'secondary' });
    buttons.push({ id: `cfgb:${sessionId}:lang`, label: `语言：${s.language === 'en' ? 'English' : '中文'}`, style: 'secondary' });
    buttons.push({ id: `cfgb:${sessionId}:chrome`, label: `用我的 Chrome：${chromeOn ? '开' : '关'}`, style: chromeOn ? 'success' : 'secondary' });
    return {
      content: summary.join('\n'),
      selects: [
        { id: `cfg:${sessionId}:model`, placeholder: '主代理', options: withCurrent(s.model).map((m) => ({ value: m.id, label: `主代理：${m.label}`, default: m.id === s.model })) },
        { id: `cfg:${sessionId}:sub`, placeholder: '子代理', options: withCurrent(sub).map((m) => ({ value: m.id, label: `子代理：${m.label}`, default: m.id === sub })) },
        { id: `cfg:${sessionId}:effort`, placeholder: '思考强度', options: EFFORT_LEVELS.map((e) => ({ value: e, label: `思考强度：${EFFORT_LABEL[e]}`, default: e === s.effort })) },
        {
          id: `cfg:${sessionId}:quality`,
          placeholder: '质检',
          options: QUALITY_OPTIONS.map((q) => ({ value: String(q.v), label: `质检：${q.label}`, default: q.v === s.qualityReviewMinutes })),
        },
      ],
      buttons: [buttons],
    };
  }

  /** Apply one settings change (same rules as the web bar), then refresh the card in place. */
  private async applyConfig(sessionId: string, field: string, value: string | null, channelId: string, messageId: string): Promise<string | null> {
    const row = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!row) return '对话不存在。';
    const s = toSessionDTO(row);
    const o = getOrchestrator();
    let note = '';
    switch (field) {
      case 'model':
        await o.setConfig(sessionId, value!);
        note = `✓ 主代理 → ${modelLabel(value!)}`;
        break;
      case 'sub':
        await o.setConfig(sessionId, undefined, undefined, value!);
        note = `✓ 子代理 → ${modelLabel(value!)}`;
        break;
      case 'effort':
        await o.setConfig(sessionId, undefined, value!);
        note = `✓ 思考强度 → ${EFFORT_LABEL[value as EffortLevel] ?? value}（下一轮生效）`;
        break;
      case 'quality':
        await o.setConfig(sessionId, undefined, undefined, undefined, undefined, undefined, parseInt(value!, 10));
        note = `✓ 质检 → ${QUALITY_OPTIONS.find((q) => String(q.v) === value)?.label ?? value}`;
        break;
      case 'lang': {
        const next = s.language === 'en' ? 'zh' : 'en';
        await o.setConfig(sessionId, undefined, undefined, undefined, next);
        note = `✓ 语言 → ${next === 'en' ? 'English' : '中文'}`;
        break;
      }
      case 'chrome': {
        const next = !s.userChrome;
        await o.setConfig(sessionId, undefined, undefined, undefined, undefined, undefined, undefined, undefined, next);
        note = `✓ 用我的 Chrome → ${next ? '开' : '关'}`;
        break;
      }
      case 'acct': {
        const acct = await this.accountInfo();
        const cycle = ['auto', ...(acct.hasPrimary ? ['primary'] : []), ...(acct.hasFallback ? ['fallback'] : [])];
        const next = cycle[(cycle.indexOf(s.accountMode) + 1) % cycle.length]!;
        // Same as the web bar: snap models the new seat can't use down to its best one.
        const allowed = acct.tokens ? acct.allowed(next) : [];
        const model = allowed.length && !allowed.includes(s.model) ? topAllowedModel(allowed) : undefined;
        const sub = s.subagentModel || s.model;
        const subModel = allowed.length && !allowed.includes(sub) ? topAllowedModel(allowed) : undefined;
        const quality = allowed.length && s.qualityModel && !allowed.includes(s.qualityModel) ? '' : undefined;
        await o.setConfig(sessionId, model, undefined, subModel, undefined, next, undefined, quality);
        note = `✓ 账号 → ${acct.label(next)}${model ? `（主代理改为 ${modelLabel(model)}）` : ''}`;
        break;
      }
      default:
        return null;
    }
    if (this.port) await this.port.edit(channelId, messageId, await this.configCard(sessionId, note)).catch((err) => log.warn('refresh settings card failed', err));
    return null;
  }

  async onModal(customId: string, userId: string, value: string): Promise<string | null> {
    if (!this.isOwner(userId)) return '只有 chapi 的主人能操作。';
    const qm = /^qm:(.+)$/.exec(customId);
    if (qm) {
      const question = await prisma.pendingQuestion.findUnique({ where: { id: qm[1]! } });
      if (!question || question.status !== 'open') return '这个提问已经回答过了。';
      if (!value.trim()) return '回答是空的。';
      this.answeredHere.add(question.id);
      await getOrchestrator().answerQuestion(question.sessionId, question.id, value.trim());
      return null;
    }
    const m = /^am:(.+)$/.exec(customId);
    if (!m) return null;
    const approval = await prisma.approval.findUnique({ where: { id: m[1]! } });
    if (!approval || approval.status !== 'open') return '这个审批已经处理过了。';
    this.answeredHere.add(approval.id);
    await getOrchestrator().decideApproval(approval.sessionId, approval.id, 'revise', value.trim() || '（未填写意见）');
    return null;
  }

  private async sendDetail(sessionId: string, kind: PushKind, fullText: string): Promise<void> {
    const text = await this.translator.composeDetail({ sessionId, fullText });
    await this.post(sessionId, { content: `📄 ${text}` }, { kind: 'detail', fullText });
    if (['completion', 'question', 'approval', 'error'].includes(kind)) void this.translator.nudgeDetail(kind, sessionId);
  }

  // ── inbound: messages ────────────────────────────────────────────────────

  async onMessage(m: InboundMessage): Promise<void> {
    if (!this.port || !this.isOwner(m.authorId)) return;
    const sessionId = this.bySession(m.channelId);
    if (sessionId) return this.onThreadMessage(sessionId, m);
    if (m.isDM || (this.homeChannelId && m.channelId === this.homeChannelId)) return this.onHomeMessage(m);
  }

  /** Channel (or DM) message: a command, or a brand-new task. */
  private async onHomeMessage(m: InboundMessage): Promise<void> {
    const text = m.content.trim();
    const reply = (content: string) => this.port!.send(m.channelId, { content });
    const cmd = text ? parseCommand(text) : null;
    if (cmd?.name === 'help' || cmd?.name === 'unknown') {
      await reply(DISCORD_HELP);
      return;
    }
    if (cmd?.name === 'list') {
      await this.port!.send(m.channelId, await this.resumeCard());
      return;
    }
    if (cmd?.name === 'search') {
      await this.port!.send(m.channelId, await this.resumeCard(cmd.text));
      return;
    }
    if (cmd?.name === 'workflow') {
      if (cmd.text) {
        const w = await findWorkflowRef(cmd.text);
        if (w && w.status === 'confirmed') {
          await this.onSelect('wfnew', m.authorId, w.slug, m.channelId, m.messageId);
          return;
        }
      }
      await this.port!.send(m.channelId, await this.workflowCard(null));
      return;
    }
    if (cmd?.name === 'today') {
      await this.port!.send(m.channelId, await this.todayCard());
      return;
    }
    if (cmd?.name === 'projects') {
      await this.port!.send(m.channelId, await this.projectsCard());
      return;
    }
    if (cmd?.name === 'automations') {
      await this.port!.send(m.channelId, await this.automationsCard(cmd.text || undefined));
      return;
    }
    if (cmd && ['settings', 'preview', 'progress', 'quality', 'archive', 'browser'].includes(cmd.name)) {
      await reply('这个指令要在任务的子话题里用。');
      return;
    }
    const task = cmd?.name === 'new' ? cmd.text : cmd ? null : text;
    if (!task && !m.attachments.length) {
      await reply(DISCORD_HELP);
      return;
    }
    if (!this.homeChannelId) {
      await reply('先在 chapi 设置里选择用来开子话题的频道。');
      return;
    }
    const s = await createSession({ firstMessage: task || '（见附件）' });
    await this.connect(s.id);
    const body = await this.withAttachments(s.id, task || '（见附件）', m.attachments);
    await this.forward(s.id, body);
    await this.port!.react(m.channelId, m.messageId, '🧵').catch(() => undefined);
    const url = this.port!.threadUrl(this.bindings.get(s.id)!);
    if (m.isDM && url) await reply(`已开始：${url}`);
  }

  private async onThreadMessage(sessionId: string, m: InboundMessage): Promise<void> {
    const text = m.content.trim();
    const reply = (content: string) => this.post(sessionId, { content }, { kind: 'info' });
    const cmd = text ? parseCommand(text) : null;
    if (cmd) {
      switch (cmd.name) {
        case 'stop': {
          const turn = this.turns.get(sessionId);
          if (turn) turn.suppress = true;
          await getOrchestrator().interrupt(sessionId);
          await reply('已停止。');
          return;
        }
        case 'status':
          await reply(await this.statusText(sessionId));
          return;
        case 'detail': {
          const last = this.lastPush.get(sessionId);
          if (!last) await reply('没有可展开的推送。');
          else await this.sendDetail(sessionId, last.kind, last.fullText);
          return;
        }
        case 'disconnect':
          await this.disconnect(sessionId);
          return;
        case 'list':
          await reply(await this.listText());
          return;
        case 'settings':
          await this.post(sessionId, await this.configCard(sessionId), { kind: 'info' });
          return;
        case 'preview':
          await this.previewCommand(sessionId, cmd.text);
          return;
        case 'search':
          await this.post(sessionId, await this.resumeCard(cmd.text), { kind: 'info' });
          return;
        case 'new':
          await reply('新任务请在频道里（不是子话题里）直接发。');
          return;
        case 'workflow': {
          if (cmd.text) {
            const err = await this.startWorkflow(sessionId, cmd.text);
            if (!err) return;
            await reply(`没能启动：${clip(err, 600)}`);
          }
          await this.post(sessionId, await this.workflowCard(sessionId), { kind: 'info' });
          return;
        }
        case 'progress':
          await this.progressCommand(sessionId);
          return;
        case 'quality': {
          const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } });
          if (s?.status !== 'active') {
            await reply('这个任务已归档，不再质检。');
            return;
          }
          void getOrchestrator().runQualityReview(sessionId);
          await reply('🔎 已开始质检，结果出来会发在这里。');
          return;
        }
        case 'archive':
          await this.post(
            sessionId,
            {
              content: '标记为出色完成？平台会学习并归档这次的成果和方案，**这个任务随后变为只读**，不能再继续对话。',
              buttons: [[
                { id: `arch:${sessionId}`, label: '📦 完成并归档', style: 'success' },
                { id: 'cancel', label: '取消', style: 'secondary' },
              ]],
            },
            { kind: 'info' },
          );
          return;
        case 'browser':
          await this.browserCommand(sessionId);
          return;
        case 'today':
          await this.post(sessionId, await this.todayCard(), { kind: 'info' });
          return;
        case 'projects':
          await this.post(sessionId, await this.projectPicker(sessionId), { kind: 'info' });
          return;
        case 'automations':
          await this.post(sessionId, await this.automationsCard(cmd.text || undefined), { kind: 'info' });
          return;
        default:
          await reply(DISCORD_HELP);
          return;
      }
    }

    const question = await prisma.pendingQuestion.findFirst({ where: { sessionId, status: 'open', source: 'agent' }, orderBy: { createdAt: 'desc' } });
    if (question && text) {
      const options = (question.options as string[] | null) ?? null;
      let answer: string | null = text;
      if (options?.length) {
        const picks = parseOptionPick(text, options.length);
        answer = picks ? picks.map((i) => options[i]).join('、') : await this.translator.interpretAnswer({ sessionId, question: question.question, options, reply: text });
        if (!answer) {
          await reply(`没看懂选哪个，点上面的按钮或回 1-${options.length}。`);
          return;
        }
      }
      this.answeredHere.add(question.id);
      await getOrchestrator().answerQuestion(sessionId, question.id, await this.withAttachments(sessionId, answer, m.attachments));
      return;
    }
    const approval = await prisma.approval.findFirst({ where: { sessionId, status: 'open' }, orderBy: { createdAt: 'desc' } });
    if (approval && text) {
      const r = parseApprovalReply(text);
      this.answeredHere.add(approval.id);
      const feedback = r.decision === 'revise' ? await this.withAttachments(sessionId, r.feedback, m.attachments) : undefined;
      await getOrchestrator().decideApproval(sessionId, approval.id, r.decision, feedback);
      return;
    }
    if (text && STYLE_FEEDBACK_RE.test(text) && text.length <= 60) {
      const fb = await this.translator.classifyFeedback({ reply: text, lastPush: this.lastPush.get(sessionId)?.fullText });
      if (fb) {
        await this.translator.recordPreference(fb.preference, sessionId);
        await reply(fb.ack);
        return;
      }
    }
    const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } });
    if (!s || s.status !== 'active') {
      await reply('这个任务已完成或已删除（只读）。新任务请在频道里直接发。');
      return;
    }
    await this.forward(sessionId, await this.withAttachments(sessionId, text, m.attachments));
    await this.port!.react(m.channelId, m.messageId, '👀').catch(() => undefined);
  }

  /** What you typed on the computer shows up in the thread, so the phone has the whole conversation. */
  private async mirrorUserMessage(sessionId: string, text: string): Promise<void> {
    const key = `${sessionId}\u0000${text}`;
    if (this.echoes.delete(key)) return; // it came from Discord in the first place
    if (isSystemInjected(text)) return;
    const [words, files] = text.split(/\n\n\[本次上传的文件（位于会话沙盘，可直接读取\/编辑）\]\n/);
    const n = files ? files.split('\n').filter((l) => l.startsWith('- ')).length : 0;
    const body = clip(words ?? '', 1500).replace(/\n/g, '\n> ');
    await this.post(sessionId, { content: `💻 **你在电脑上说**\n> ${body || '（无文字）'}${n ? `\n📎 ${n} 个附件` : ''}` }, { kind: 'info' });
  }

  /** Same path as the web composer; the web UI shows the message live. */
  private async forward(sessionId: string, text: string): Promise<void> {
    this.echoes.add(`${sessionId}\u0000${text}`);
    await getOrchestrator().handleUserMessage(sessionId, text);
    const row = await prisma.message.findFirst({ where: { sessionId, role: 'user' }, orderBy: { createdAt: 'desc' } });
    if (row) bus.emit({ type: 'assistant.message', sessionId, message: toMessageDTO(row) });
  }

  /** Download Discord attachments into the session (same layout as web uploads) and note them. */
  private async withAttachments(sessionId: string, text: string, items: InboundMessage['attachments']): Promise<string> {
    if (!items.length) return text;
    const rawDir = path.join(config.paths.rawMaterials, 'uploads', sessionId);
    const sandboxUploads = path.join(sessionPaths(sessionId).sandbox, 'uploads');
    await fs.promises.mkdir(rawDir, { recursive: true });
    await fs.promises.mkdir(sandboxUploads, { recursive: true });
    const saved: string[] = [];
    for (const a of items) {
      try {
        const res = await this.fetchImpl(a.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const fname = `${Date.now()}-${shortId(4)}-${safeFilename(a.name)}`;
        const dest = path.join(rawDir, fname);
        await fs.promises.writeFile(dest, buf);
        await fs.promises.copyFile(dest, path.join(sandboxUploads, fname)).catch(() => undefined);
        await prisma.attachment.create({ data: { sessionId, filename: a.name, path: dest, mime: a.contentType || 'application/octet-stream', size: buf.length } });
        saved.push(`- ${a.name} → ${path.posix.join('uploads', fname)}`);
      } catch (err) {
        log.warn(`attachment download failed: ${a.name}`, err);
      }
    }
    if (!saved.length) return text;
    const note = `[本次上传的文件（位于会话沙盘，可直接读取/编辑）]\n${saved.join('\n')}`;
    return text ? `${text}\n\n${note}` : note;
  }

  /**
   * Connected tasks + a dropdown of earlier conversations (newest first, or those
   * matching `query` by title or content) to continue here — picking one opens its thread.
   */
  async resumeCard(query?: string): Promise<OutPayload> {
    const connected = [...this.bindings.keys()];
    let rows: Array<{ id: string; title: string; updatedAt: Date; status: string }>;
    if (query) {
      const byContent = await searchSessions(query).catch(() => ({ results: [] }));
      const ids = byContent.results.map((r) => r.sessionId);
      rows = await prisma.session.findMany({
        where: { status: { not: 'deleted' }, OR: [{ title: { contains: query } }, { id: { in: ids } }] },
        orderBy: { updatedAt: 'desc' },
        take: 25,
        select: { id: true, title: true, updatedAt: true, status: true },
      });
    } else {
      rows = await prisma.session.findMany({
        where: { status: 'active', id: { notIn: connected } },
        orderBy: { updatedAt: 'desc' },
        take: 25,
        select: { id: true, title: true, updatedAt: true, status: true },
      });
    }
    const head = query ? `🔎 「${clip(query, 30)}」找到 ${rows.length} 个对话` : `**已连接的任务**\n${await this.listText()}`;
    if (!rows.length) return { content: `${head}\n${query ? '换个关键词试试。' : '没有其他进行中的对话。'}` };
    return {
      content: `${head}\n\n选一个之前的对话，就会在这里开子话题接着做 ↓`,
      selects: [
        {
          id: 'resume',
          placeholder: query ? '选择要接着做的对话' : '接着做之前的对话…',
          options: rows.map((r) => ({
            value: r.id,
            label: clip(r.title || '(无标题)', 95),
            description: `${connected.includes(r.id) ? '已连接 · ' : ''}${r.status === 'completed' ? '已完成（只读）· ' : ''}${ago(r.updatedAt)}`,
          })),
        },
      ],
    };
  }

  /** "!预览 [文件名]": preview one file from the session sandbox, or pick from recent ones. */
  private async previewCommand(sessionId: string, query: string): Promise<void> {
    const files = await findSandboxFiles(sessionPaths(sessionId).sandbox, query, 25);
    const docs = files.filter((f) => !IMAGE_EXT.has(path.extname(f).toLowerCase()) || query);
    if (!docs.length) {
      await this.post(sessionId, { content: query ? `沙盘里没找到名字含「${query}」的文件。` : '沙盘里还没有可预览的文件。' }, { kind: 'info' });
      return;
    }
    if (docs.length === 1 || (query && path.basename(docs[0]!).toLowerCase() === query.toLowerCase())) {
      await this.postPreview(sessionId, docs[0]!, 1);
      return;
    }
    const sandbox = sessionPaths(sessionId).sandbox;
    await this.post(
      sessionId,
      {
        content: `找到 ${docs.length} 个文件，选一个预览 ↓`,
        selects: [
          {
            id: `pvsel:${sessionId}`,
            placeholder: '选择文件',
            options: docs.map((f) => {
              const token = shortId(8);
              this.fileTokens.set(token, f);
              return { value: token, label: clip(path.basename(f), 95), description: clip(path.relative(sandbox, path.dirname(f)) || '(根目录)', 95) };
            }),
          },
        ],
      },
      { kind: 'info' },
    );
  }

  private async listText(): Promise<string> {
    const ids = [...this.bindings.keys()];
    if (!ids.length) return '还没有连接的任务。在频道里直接发消息就能开一个。';
    const rows = await prisma.session.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, status: true } });
    return rows
      .map((s) => `- <#${this.bindings.get(s.id)}> ${clip(s.title, 40)} · ${s.status !== 'active' ? '已完成' : this.running.has(s.id) ? '运行中' : '空闲'}`)
      .join('\n');
  }

  private async statusText(sessionId: string): Promise<string> {
    const [s, step, q, approvals, agents, active] = await Promise.all([
      prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } }),
      prisma.planTask.findFirst({ where: { sessionId, status: 'in_progress', locked: false }, orderBy: { ordinal: 'asc' } }),
      prisma.pendingQuestion.count({ where: { sessionId, status: 'open', source: 'agent' } }),
      prisma.approval.findMany({ where: { sessionId, status: 'open' }, select: { id: true } }),
      prisma.agentRun.findMany({ where: { sessionId, status: 'running', name: { not: 'main' } }, orderBy: { startedAt: 'asc' }, take: 6 }),
      loadActiveRun(sessionId),
    ]);
    const state = currentRunState(sessionId);
    const running = state === 'running' || state === 'paused';
    const a = approvals.some((x) => hitl.hasApproval(x.id));
    const turn = this.turns.get(sessionId);
    const head = s?.status === 'completed' ? '已归档（只读）' : q ? '等你回答提问' : a ? '等你审批' : running ? '运行中' : state === 'error' ? '出错停下了' : '空闲';
    const parts = [head];
    if (turn && running) parts.push(`已跑 ${Math.max(1, Math.round((Date.now() - turn.startedAt.getTime()) / 60_000))} 分钟`);
    const lines = [`**状态**：${parts.join(' · ')}`];
    if (active) {
      const run = toRunDTO(active);
      const steps = runSteps(run);
      const i = steps.findIndex((n) => n.id === run.cursor?.nodeId);
      lines.push(`🧭 工作流「${clip(run.workflowName, 40)}」${i >= 0 ? `· 阶段 ${i + 1}/${steps.length}「${clip(shortTitle(steps[i]!.title), 30)}」` : ''}（\`!进度\` 看详情）`);
    } else if (step) {
      lines.push(`正在：${clip(toPlainText(step.text), 80)}`);
    }
    for (const ag of agents) {
      const what = ag.currentActivity || ag.title || '';
      lines.push(`🤖 ${clip(ag.name, 24)}${what ? `：${clip(toPlainText(what), 70)}` : ''}`);
    }
    return lines.join('\n');
  }
}

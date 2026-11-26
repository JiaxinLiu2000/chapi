/**
 * WeChat remote bridge: lets the user drive chapi sessions from WeChat.
 *
 *  phone ──getupdates long-poll──► bridge ──► orchestrator (same path as the web UI)
 *  phone ◄──sendmessage── translator ◄── bus events (turn done / question / approval / error)
 *
 * - Plain text / voice (WeChat's own speech-to-text) is sent to the focused session
 *   as a normal user message; a quoted reply goes to the session of the quoted push.
 * - While a connected session runs, the phone shows "对方正在输入" instead of
 *   progress messages.
 * - Turn results, questions and approvals are rewritten short by the translator;
 *   numbered replies map back onto options/decisions.
 * - Produced files/images (artifacts) are uploaded to WeChat.
 */
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import type { WechatAccount } from '@prisma/client';
import type { ServerEvent, WechatLoginDTO, WechatStatusDTO, WechatSessionStateDTO } from '@chapi/shared';
import { config, sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toMessageDTO } from '../mappers.js';
import { getOrchestrator } from '../orchestrator/types.js';
import { openSecret, sealSecret } from '../secrets.js';
import { createSession } from '../services/sessions.js';
import { shortId } from '../util/ids.js';
import {
  HELP_TEXT,
  STYLE_FEEDBACK_RE,
  chunkText,
  parseApprovalReply,
  parseCommand,
  parseOptionPick,
  pushHeader,
  tagForIndex,
  toPlainText,
  type Command,
} from '../remote/format.js';
import {
  ILINK_BASE_URL,
  IlinkClient,
  ItemType,
  MessageType,
  STALE_TOKEN_ERRCODE,
  TypingStatus,
  UploadMediaType,
  type MessageItem,
  type WeixinMessage,
} from './protocol.js';
import { Translator, type PushKind } from '../remote/translator.js';
import { IMAGE_EXT, collectTurn, turnFiles } from '../remote/files.js';

const log = createLogger('wechat');

const TURN_SETTLE_MS = 3000; // idle this long after running → the turn is done
const TYPING_REFRESH_MS = 10_000;
const TICKET_TTL_MS = 20 * 60_000;
const LOGIN_TTL_MS = 5 * 60_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_QUEUED = 30;

type LoginState = WechatLoginDTO & { qrcode?: string; baseUrl: string; startedAt: number; refreshes: number; verifyCode?: string };

interface Turn {
  startedAt: Date;
  timer?: NodeJS.Timeout;
  suppress?: boolean;
}

interface OutMeta {
  sessionId?: string | null;
  kind: PushKind | 'info' | 'file';
  refId?: string | null;
  fullText?: string | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function safeFilename(name: string): string {
  return path.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+/, '') || 'file';
}

export class WechatBridge {
  private account: WechatAccount | null = null;
  private client: IlinkClient | null = null;
  private pollAbort: AbortController | null = null;
  private polling = false;
  private lastError: string | null = null;
  private login: LoginState | null = null;
  private unsubscribe: (() => void) | null = null;

  private bindings = new Map<string, string>(); // sessionId → tag
  private turns = new Map<string, Turn>();
  private running = new Set<string>();
  private awaiting = new Set<string>(); // pushed questions/approvals not answered yet (ids)
  private answeredHere = new Set<string>();
  private pendingMedia = new Map<string, Array<{ filename: string; sandboxPath: string }>>();
  private queue: Array<{ text: string; meta: OutMeta }> = [];
  private lastList: string[] = [];
  private lastPush: { messageId?: string; sessionId?: string | null; kind: PushKind | 'info' | 'file'; fullText: string } | null = null;
  private errorThrottle = new Map<string, number>();
  private typing: { on: boolean; ticket?: string; ticketAt: number; timer?: NodeJS.Timeout } = { on: false, ticketAt: 0 };

  constructor(
    readonly translator: Translator = new Translator(),
    private readonly makeClient: (baseUrl: string, token: string) => IlinkClient = (b, t) => new IlinkClient(b, t),
  ) {}

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.unsubscribe) this.unsubscribe = bus.on((e) => this.onEvent(e));
    await this.reloadBindings();
    this.account = await prisma.wechatAccount.findFirst({ where: { status: { in: ['active', 'stale'] } }, orderBy: { updatedAt: 'desc' } });
    if (this.account) this.startPolling();
  }

  stop(): void {
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.typing.timer) clearInterval(this.typing.timer);
  }

  private async reloadBindings(): Promise<void> {
    const rows = await prisma.wechatBinding.findMany();
    this.bindings = new Map(rows.map((r) => [r.sessionId, r.tag]));
  }

  private startPolling(): void {
    if (!this.account) return;
    this.pollAbort?.abort();
    this.client = this.makeClient(this.account.baseUrl, openSecret(this.account.token));
    const ctl = new AbortController();
    this.pollAbort = ctl;
    void this.pollLoop(ctl.signal);
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let timeoutMs = 35_000;
    let failures = 0;
    this.polling = true;
    log.info(`polling WeChat as bot ${this.account?.id}`);
    while (!signal.aborted && this.account && this.client) {
      try {
        const resp = await this.client.getUpdates(this.account.updatesBuf ?? '', timeoutMs, signal);
        if (signal.aborted) break;
        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;
        const apiErr = (resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0);
        if (apiErr) {
          if (resp.ret === STALE_TOKEN_ERRCODE || resp.errcode === STALE_TOKEN_ERRCODE) {
            this.lastError = '微信登录已失效，请在设置里重新扫码';
            await this.setAccount({ status: 'stale' });
            bus.emit({ type: 'notification', sessionId: null, level: 'error', title: '微信已断开', body: this.lastError });
            await sleep(60 * 60_000, signal); // the server asks clients to back off for an hour
            continue;
          }
          failures++;
          this.lastError = `getupdates ret=${resp.ret ?? resp.errcode} ${resp.errmsg ?? ''}`.trim();
          await sleep(failures >= 3 ? 30_000 : 2000, signal);
          if (failures >= 3) failures = 0;
          continue;
        }
        failures = 0;
        if (this.account.status !== 'active') await this.setAccount({ status: 'active' });
        if (this.lastError?.startsWith('getupdates') || this.lastError?.includes('网络')) this.lastError = null;
        if (resp.get_updates_buf && resp.get_updates_buf !== this.account.updatesBuf) {
          await this.setAccount({ updatesBuf: resp.get_updates_buf });
        }
        for (const msg of resp.msgs ?? []) {
          await this.handleInbound(msg).catch((err) => log.error('inbound handling failed', err));
        }
      } catch (err) {
        if (signal.aborted) break;
        failures++;
        this.lastError = `网络错误：${err instanceof Error ? err.message : String(err)}`;
        await sleep(failures >= 3 ? 30_000 : 2000, signal);
        if (failures >= 3) failures = 0;
      }
    }
    this.polling = false;
  }

  private async setAccount(data: Partial<Omit<WechatAccount, 'id' | 'createdAt' | 'updatedAt'>>): Promise<void> {
    if (!this.account) return;
    this.account = await prisma.wechatAccount.update({ where: { id: this.account.id }, data });
  }

  // ── login (QR shown in Settings) ─────────────────────────────────────────

  async startLogin(): Promise<WechatLoginDTO> {
    const client = this.makeClient(ILINK_BASE_URL, '');
    const qr = await client.fetchQrCode();
    this.login = {
      status: 'wait',
      qrSvg: await QRCode.toString(qr.qrcodeContent, { type: 'svg', margin: 1, width: 220 }),
      qrcode: qr.qrcode,
      baseUrl: ILINK_BASE_URL,
      startedAt: Date.now(),
      refreshes: 0,
      message: '用微信扫码，并在手机上确认',
    };
    void this.loginLoop(this.login);
    return this.loginSnapshot();
  }

  loginSnapshot(): WechatLoginDTO {
    const l = this.login;
    if (!l) return { status: 'idle' };
    if (l.status !== 'confirmed' && Date.now() - l.startedAt > LOGIN_TTL_MS) return { status: 'expired', message: '二维码已过期，请重新获取' };
    return { status: l.status, qrSvg: l.status === 'confirmed' ? undefined : l.qrSvg, message: l.message };
  }

  submitVerifyCode(code: string): void {
    if (this.login?.status === 'need_verifycode') {
      this.login.verifyCode = code.trim();
      this.login.message = '已提交，等待确认…';
    }
  }

  private async loginLoop(state: LoginState): Promise<void> {
    while (this.login === state && Date.now() - state.startedAt < LOGIN_TTL_MS) {
      if (state.status === 'need_verifycode' && !state.verifyCode) {
        await sleep(1000);
        continue;
      }
      const client = this.makeClient(state.baseUrl, '');
      const r = await client.pollQrStatus(state.qrcode!, state.verifyCode);
      if (this.login !== state) return;
      switch (r.status) {
        case 'wait':
          break;
        case 'scaned':
          state.status = 'scaned';
          state.message = '已扫码，请在手机上确认';
          break;
        case 'scaned_but_redirect':
          if (r.redirect_host) state.baseUrl = `https://${r.redirect_host}`;
          break;
        case 'need_verifycode':
          state.message = state.verifyCode ? '数字不对，请重新输入手机上显示的数字' : '请输入手机微信上显示的数字';
          state.status = 'need_verifycode';
          state.verifyCode = undefined;
          break;
        case 'verify_code_blocked':
          state.status = 'error';
          state.message = '多次输入错误，请稍后再试';
          return;
        case 'expired': {
          if (++state.refreshes > 3) {
            state.status = 'expired';
            state.message = '二维码多次过期，请重新获取';
            return;
          }
          const qr = await this.makeClient(ILINK_BASE_URL, '').fetchQrCode();
          state.qrcode = qr.qrcode;
          state.qrSvg = await QRCode.toString(qr.qrcodeContent, { type: 'svg', margin: 1, width: 220 });
          state.status = 'wait';
          state.message = '二维码已刷新，请重新扫码';
          break;
        }
        case 'binded_redirect':
          state.status = this.account ? 'confirmed' : 'error';
          state.message = this.account ? '这个微信已经连接过了' : '这个微信已绑定过其他实例，请先在手机上解绑';
          return;
        case 'confirmed': {
          if (!r.ilink_bot_id || !r.bot_token) {
            state.status = 'error';
            state.message = '登录失败：服务器没有返回凭证';
            return;
          }
          await this.saveLogin(r.ilink_bot_id, r.bot_token, r.baseurl || state.baseUrl, r.ilink_user_id ?? '');
          state.status = 'confirmed';
          state.message = '已连接。先在微信里给它发一句话，激活推送。';
          return;
        }
      }
    }
  }

  private async saveLogin(botId: string, token: string, baseUrl: string, ownerUserId: string): Promise<void> {
    await prisma.wechatAccount.updateMany({ where: { id: { not: botId } }, data: { status: 'logged_out' } });
    const prev = await prisma.wechatAccount.findUnique({ where: { id: botId } });
    this.account = await prisma.wechatAccount.upsert({
      where: { id: botId },
      update: { token: sealSecret(token), baseUrl, ownerUserId: ownerUserId || prev?.ownerUserId || '', status: 'active' },
      create: { id: botId, token: sealSecret(token), baseUrl, ownerUserId, status: 'active' },
    });
    this.lastError = null;
    this.typing.ticket = undefined;
    log.info(`WeChat bot ${botId} logged in`);
    this.startPolling();
  }

  async logout(): Promise<void> {
    this.pollAbort?.abort();
    this.pollAbort = null;
    if (this.account) {
      await prisma.wechatAccount.update({ where: { id: this.account.id }, data: { status: 'logged_out', token: '' } });
    }
    this.account = null;
    this.client = null;
    this.login = null;
    this.queue = [];
  }

  // ── status for the web UI ────────────────────────────────────────────────

  async status(): Promise<WechatStatusDTO> {
    const ids = [...this.bindings.keys()];
    const sessions = ids.length
      ? await prisma.session.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, slug: true } })
      : [];
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return {
      loggedIn: Boolean(this.account && this.account.status !== 'logged_out'),
      accountStatus: (this.account?.status as WechatStatusDTO['accountStatus']) ?? 'none',
      botId: this.account?.id ?? null,
      polling: this.polling,
      pushReady: Boolean(this.account?.contextToken),
      lastInboundAt: this.account?.lastInboundAt?.toISOString() ?? null,
      lastError: this.lastError,
      queued: this.queue.length,
      focusSessionId: this.account?.focusSessionId ?? null,
      bindings: ids
        .filter((id) => byId.has(id))
        .map((id) => ({ sessionId: id, tag: this.bindings.get(id)!, title: byId.get(id)!.title, slug: byId.get(id)!.slug, focused: this.account?.focusSessionId === id })),
    };
  }

  sessionState(sessionId: string): WechatSessionStateDTO {
    return {
      loggedIn: Boolean(this.account && this.account.status !== 'logged_out'),
      connected: this.bindings.has(sessionId),
      tag: this.bindings.get(sessionId) ?? null,
      focused: this.account?.focusSessionId === sessionId,
    };
  }

  // ── session connect / disconnect ─────────────────────────────────────────

  async connect(sessionId: string, opts: { announce?: boolean } = {}): Promise<WechatSessionStateDTO> {
    const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } });
    if (!s) throw new Error('session not found');
    if (!this.bindings.has(sessionId)) {
      const used = new Set(this.bindings.values());
      let i = 0;
      while (used.has(tagForIndex(i))) i++;
      const tag = tagForIndex(i);
      await prisma.wechatBinding.create({ data: { sessionId, tag } });
      this.bindings.set(sessionId, tag);
    }
    await this.setFocus(sessionId);
    if (opts.announce !== false) {
      await this.send(`已连接对话 [${this.bindings.get(sessionId)}] ${clip(s.title, 30)}。之后的结果、提问和审批会推到这里；直接回复就是发给它。`, { sessionId, kind: 'info' });
    }
    return this.sessionState(sessionId);
  }

  async disconnect(sessionId: string): Promise<WechatSessionStateDTO> {
    await prisma.wechatBinding.deleteMany({ where: { sessionId } });
    this.bindings.delete(sessionId);
    this.running.delete(sessionId);
    const turn = this.turns.get(sessionId);
    if (turn?.timer) clearTimeout(turn.timer);
    this.turns.delete(sessionId);
    if (this.account?.focusSessionId === sessionId) {
      const next = [...this.bindings.keys()].at(-1) ?? null;
      await this.setAccount({ focusSessionId: next });
    }
    void this.updateTyping();
    return this.sessionState(sessionId);
  }

  private async setFocus(sessionId: string | null): Promise<void> {
    if (this.account && this.account.focusSessionId !== sessionId) await this.setAccount({ focusSessionId: sessionId });
  }

  // ── outbound ─────────────────────────────────────────────────────────────

  /** Send text (chunked); failures are queued and re-sent when the user next messages. */
  async send(text: string, meta: OutMeta): Promise<void> {
    const body = text.trim();
    if (!body) return;
    if (!this.account || !this.client || this.account.status === 'logged_out') return;
    if (!this.account.ownerUserId || !this.account.contextToken) {
      this.enqueue(body, meta, '还没激活推送：先在微信里给机器人发一句话');
      return;
    }
    try {
      let firstId: string | undefined;
      for (const chunk of chunkText(body)) {
        const id = await this.client.sendText(this.account.ownerUserId, chunk, this.account.contextToken);
        firstId ??= id;
        if (id) await this.recordOutbound(id, meta, body);
      }
      // Bridge chatter ("✓ 已回答") must not replace the push "/详细" expands.
      if (meta.kind !== 'info' && meta.kind !== 'file') {
        this.lastPush = { messageId: firstId, sessionId: meta.sessionId, kind: meta.kind, fullText: meta.fullText ?? body };
      }
    } catch (err) {
      this.enqueue(body, meta, `推送失败（等你下次发消息时补发）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private enqueue(text: string, meta: OutMeta, reason: string): void {
    this.queue.push({ text, meta });
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
    this.lastError = reason;
    log.warn(`queued WeChat push: ${reason}`);
  }

  private async flushQueue(): Promise<void> {
    if (!this.queue.length) return;
    const items = this.queue.splice(0);
    await this.sendRaw(`（补发 ${items.length} 条之前没送达的消息）`);
    for (const it of items) await this.send(it.text, it.meta);
    if (!this.queue.length && this.lastError?.includes('推送')) this.lastError = null;
  }

  private async sendRaw(text: string): Promise<void> {
    if (!this.client || !this.account?.contextToken) return;
    await this.client.sendText(this.account.ownerUserId, text, this.account.contextToken).catch(() => undefined);
  }

  private async recordOutbound(messageId: string, meta: OutMeta, body: string): Promise<void> {
    await prisma.wechatOutbound
      .create({ data: { messageId, sessionId: meta.sessionId ?? null, kind: meta.kind, refId: meta.refId ?? null, fullText: meta.fullText ?? body } })
      .catch(() => undefined);
  }

  private async sendLocalFile(filePath: string, sessionId: string): Promise<boolean> {
    if (!this.client || !this.account?.contextToken || !this.account.ownerUserId) return false;
    try {
      const st = await fs.promises.stat(filePath);
      if (!st.isFile() || st.size === 0) return false;
      if (st.size > MAX_FILE_BYTES) {
        await this.send(`文件太大没法发到微信（${(st.size / 1048576).toFixed(1)} MB）：${path.basename(filePath)}`, { sessionId, kind: 'info' });
        return false;
      }
      const buf = await fs.promises.readFile(filePath);
      const isImage = IMAGE_EXT.has(path.extname(filePath).toLowerCase());
      const up = await this.client.uploadMedia(buf, this.account.ownerUserId, isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE);
      const id = isImage
        ? await this.client.sendImage(this.account.ownerUserId, up, this.account.contextToken)
        : await this.client.sendFile(this.account.ownerUserId, path.basename(filePath), up, this.account.contextToken);
      if (id) await this.recordOutbound(id, { sessionId, kind: 'file', fullText: filePath }, filePath);
      return true;
    } catch (err) {
      log.warn(`send file failed: ${filePath}`, err);
      await this.send(`文件发送失败：${path.basename(filePath)}`, { sessionId, kind: 'info' });
      return false;
    }
  }

  // ── bus events → pushes ──────────────────────────────────────────────────

  private onEvent(e: ServerEvent): void {
    if (!this.account || this.account.status === 'logged_out') return;
    const sid = (e as { sessionId?: string | null }).sessionId;
    if (!sid || !this.bindings.has(sid)) return;
    const run = (p: Promise<unknown>) => void p.catch((err) => log.warn(`wechat ${e.type} handling failed`, err));
    switch (e.type) {
      case 'run.state':
        if (e.state === 'running') this.onRunning(sid);
        else if (e.state === 'idle' || e.state === 'done' || e.state === 'error') this.onIdle(sid);
        break;
      case 'question.open':
        if (e.question.source === 'agent') run(this.pushQuestion(sid, e.question.id, e.question.question, e.question.options));
        break;
      case 'question.closed':
        run(this.onClosed(sid, e.questionId, '这个提问已在电脑上回答。'));
        break;
      case 'approval.request':
        run(this.pushApproval(sid, e.approval.id, e.approval.summary, e.approval.artifacts.map((a) => ({ title: a.title, pathOrUrl: a.pathOrUrl }))));
        break;
      case 'approval.closed':
        run(this.onClosed(sid, e.approvalId, '这个审批已在电脑上处理。'));
        break;
      case 'error': {
        const last = this.errorThrottle.get(sid) ?? 0;
        if (Date.now() - last < 60_000) break;
        this.errorThrottle.set(sid, Date.now());
        run(this.withHeader(sid).then((h) => this.send(`${h}⚠️ 出错：${clip(e.message, 160)}`, { sessionId: sid, kind: 'error' })));
        break;
      }
    }
  }

  private onRunning(sessionId: string): void {
    this.running.add(sessionId);
    const turn = this.turns.get(sessionId);
    if (turn?.timer) {
      clearTimeout(turn.timer); // it resumed — same turn continues
      turn.timer = undefined;
    } else if (!turn) {
      this.turns.set(sessionId, { startedAt: new Date(Date.now() - 1000) });
    }
    void this.updateTyping();
  }

  private onIdle(sessionId: string): void {
    this.running.delete(sessionId);
    void this.updateTyping();
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = setTimeout(() => void this.finalizeTurn(sessionId).catch((err) => log.warn('finalize turn failed', err)), TURN_SETTLE_MS);
  }

  private async withHeader(sessionId: string): Promise<string> {
    const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } });
    return pushHeader(this.bindings.get(sessionId) ?? '?', s?.title ?? '', this.bindings.size > 1);
  }

  /** A connected session finished a turn → push a short result + any produced files. */
  async finalizeTurn(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    const turn = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    if (!turn || turn.suppress) return;
    const out = await collectTurn(sessionId, turn.startedAt);
    if (!out) return;
    const header = await this.withHeader(sessionId);
    const short = out.text ? await this.translator.composeCompletion({ sessionId, title: out.title, text: out.text }) : null;
    const links = out.artifacts.filter((a) => /^https?:/i.test(a.pathOrUrl) && !(short ?? '').includes(a.pathOrUrl));
    const linkLines = links.map((a) => `📎 ${a.title}：${a.pathOrUrl}`).join('\n');
    if (short || linkLines) {
      await this.send(`${header}✅ ${[short, linkLines].filter(Boolean).join('\n')}`, { sessionId, kind: 'completion', fullText: out.text || linkLines });
    }
    await this.sendTurnFiles(sessionId, out.artifacts.map((a) => a.pathOrUrl), out.text);
  }

  private async sendTurnFiles(sessionId: string, artifactPaths: string[], text: string): Promise<void> {
    for (const f of turnFiles(sessionId, artifactPaths, text)) await this.sendLocalFile(f, sessionId);
  }

  private async pushQuestion(sessionId: string, questionId: string, question: string, options: string[] | null): Promise<void> {
    this.awaiting.add(questionId);
    void this.updateTyping();
    const header = await this.withHeader(sessionId);
    const short = await this.translator.composeQuestion({ sessionId, question, options });
    const lines = [`${header}❓ ${short.question}`];
    if (short.options?.length) {
      short.options.forEach((o, i) => lines.push(`${i + 1}. ${o}`));
      lines.push('回数字选择；也可以直接打字/语音回答');
    } else {
      lines.push('直接回复即可');
    }
    const optionText = options?.length ? `\n选项：\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : '';
    await this.send(lines.join('\n'), { sessionId, kind: 'question', refId: questionId, fullText: `${question}${optionText}` });
  }

  private async pushApproval(sessionId: string, approvalId: string, summary: string, artifacts: Array<{ title: string; pathOrUrl: string }>): Promise<void> {
    this.awaiting.add(approvalId);
    void this.updateTyping();
    const header = await this.withHeader(sessionId);
    const short = await this.translator.composeApproval({ sessionId, summary });
    const links = artifacts.filter((a) => /^https?:/i.test(a.pathOrUrl)).map((a) => `📎 ${a.title}：${a.pathOrUrl}`);
    await this.send(
      [`${header}📋 待审批：${short}`, ...links, '回 1 批准 · 2 驳回 · 3+意见 修改（例：3 标题改短点）'].join('\n'),
      { sessionId, kind: 'approval', refId: approvalId, fullText: summary },
    );
    await this.sendTurnFiles(sessionId, artifacts.map((a) => a.pathOrUrl), '');
  }

  private async onClosed(sessionId: string, id: string, note: string): Promise<void> {
    const wasAwaiting = this.awaiting.delete(id);
    void this.updateTyping();
    if (this.answeredHere.delete(id) || !wasAwaiting) return;
    await this.send(`${await this.withHeader(sessionId)}${note}`, { sessionId, kind: 'info' });
  }

  // ── typing indicator instead of progress messages ───────────────────────

  private async updateTyping(): Promise<void> {
    const want = this.running.size > 0 && this.awaiting.size === 0 && Boolean(this.account?.contextToken && this.client);
    if (want && !this.typing.on) {
      this.typing.on = true;
      await this.typingPulse(TypingStatus.TYPING);
      this.typing.timer = setInterval(() => void this.typingPulse(TypingStatus.TYPING), TYPING_REFRESH_MS);
    } else if (!want && this.typing.on) {
      this.typing.on = false;
      if (this.typing.timer) clearInterval(this.typing.timer);
      this.typing.timer = undefined;
      await this.typingPulse(TypingStatus.CANCEL);
    }
  }

  private async typingPulse(status: number): Promise<void> {
    const acct = this.account;
    if (!this.client || !acct?.ownerUserId || !acct.contextToken) return;
    try {
      if (!this.typing.ticket || Date.now() - this.typing.ticketAt > TICKET_TTL_MS) {
        this.typing.ticket = await this.client.getTypingTicket(acct.ownerUserId, acct.contextToken);
        this.typing.ticketAt = Date.now();
      }
      if (this.typing.ticket) await this.client.sendTyping(acct.ownerUserId, this.typing.ticket, status);
    } catch (err) {
      this.typing.ticket = undefined;
      log.debug(`typing ${status} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  async handleInbound(msg: WeixinMessage): Promise<void> {
    if (!this.account) return;
    if (msg.message_type === MessageType.BOT) return;
    const from = msg.from_user_id ?? '';
    if (!from) return;
    if (this.account.ownerUserId && from !== this.account.ownerUserId) {
      log.warn(`ignored WeChat message from non-owner ${from.slice(0, 8)}…`);
      return;
    }
    await this.setAccount({
      ...(this.account.ownerUserId ? {} : { ownerUserId: from }), // first sender locks the bridge if login didn't report one
      ...(msg.context_token ? { contextToken: msg.context_token, contextAt: new Date() } : {}),
      lastInboundAt: new Date(),
    });
    await this.flushQueue();

    const items = msg.item_list ?? [];
    let text = '';
    let quotedId: string | undefined;
    const media: MessageItem[] = [];
    let voiceWithoutText = false;
    for (const it of items) {
      if (it.ref_msg?.svr_id) quotedId = it.ref_msg.svr_id;
      if (it.type === ItemType.TEXT && it.text_item?.text) text += (text ? '\n' : '') + it.text_item.text;
      else if (it.type === ItemType.VOICE) {
        if (it.voice_item?.text) text += (text ? '\n' : '') + it.voice_item.text;
        else voiceWithoutText = true;
      } else if (it.type === ItemType.IMAGE || it.type === ItemType.FILE || it.type === ItemType.VIDEO) media.push(it);
    }
    text = text.trim();

    const quoted = quotedId ? await prisma.wechatOutbound.findUnique({ where: { messageId: quotedId } }) : null;
    const cmd = text ? parseCommand(text) : null;
    if (cmd) return this.handleCommand(cmd, quoted);

    const target = quoted?.sessionId && this.bindings.has(quoted.sessionId) ? quoted.sessionId : this.account.focusSessionId;
    if (!target || !this.bindings.has(target)) {
      if (voiceWithoutText || text || media.length) {
        await this.reply('还没有连接对话。在电脑上点对话顶栏的「微信」按钮，或发 /新 你的任务 新建一个。发 /帮助 看全部指令。');
      }
      return;
    }

    if (media.length) await this.saveInboundMedia(target, media);
    if (voiceWithoutText && !text) {
      await this.reply('这段语音没转出文字，请重说一遍或打字。');
      return;
    }
    if (!text) {
      const n = this.pendingMedia.get(target)?.length ?? 0;
      if (n) await this.reply(`收到 ${n} 个文件/图片。接着发文字说明要做什么，或回 /发 直接交给 AI。`);
      return;
    }

    // A quoted question/approval, else the newest open one in the target session.
    const qId = quoted?.kind === 'question' ? quoted.refId : null;
    const aId = quoted?.kind === 'approval' ? quoted.refId : null;
    const question = qId
      ? await prisma.pendingQuestion.findFirst({ where: { id: qId, status: 'open' } })
      : aId
        ? null
        : await prisma.pendingQuestion.findFirst({ where: { sessionId: target, status: 'open', source: 'agent' }, orderBy: { createdAt: 'desc' } });
    if (question) return this.answer(target, question.id, question.question, (question.options as string[] | null) ?? null, text);
    const approval = aId
      ? await prisma.approval.findFirst({ where: { id: aId, status: 'open' } })
      : await prisma.approval.findFirst({ where: { sessionId: target, status: 'open' }, orderBy: { createdAt: 'desc' } });
    if (approval) return this.decide(target, approval.id, text);

    if (STYLE_FEEDBACK_RE.test(text) && text.length <= 60) {
      const fb = await this.translator.classifyFeedback({ reply: text, lastPush: this.lastPush?.fullText });
      if (fb) {
        await this.translator.recordPreference(fb.preference, target);
        await this.reply(fb.ack);
        return;
      }
    }
    await this.forward(target, text);
  }

  private async reply(text: string): Promise<void> {
    await this.send(text, { kind: 'info' });
  }

  private async answer(sessionId: string, questionId: string, question: string, options: string[] | null, text: string): Promise<void> {
    let answer: string | null = text;
    if (options?.length) {
      const picks = parseOptionPick(text, options.length);
      answer = picks ? picks.map((i) => options[i]).join('、') : await this.translator.interpretAnswer({ sessionId, question, options, reply: text });
      if (!answer) {
        await this.reply(`没看懂选哪个。回 1-${options.length} 的数字，或者说得具体一点。`);
        return;
      }
    }
    answer = this.withPendingMedia(sessionId, answer);
    this.answeredHere.add(questionId);
    await getOrchestrator().answerQuestion(sessionId, questionId, answer);
    await this.reply(`✓ 已回答：${clip(answer, 60)}`);
  }

  private async decide(sessionId: string, approvalId: string, text: string): Promise<void> {
    const r = parseApprovalReply(text);
    this.answeredHere.add(approvalId);
    const feedback = r.decision === 'revise' ? this.withPendingMedia(sessionId, r.feedback) : undefined;
    await getOrchestrator().decideApproval(sessionId, approvalId, r.decision, feedback);
    await this.reply(r.decision === 'approve' ? '✓ 已批准' : r.decision === 'reject' ? '✓ 已驳回' : `✓ 已发回修改：${clip(feedback ?? '', 60)}`);
  }

  /** Same path as typing in the web composer; the web UI shows the message live. */
  private async forward(sessionId: string, text: string): Promise<void> {
    const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { status: true } });
    if (!s || s.status !== 'active') {
      await this.reply('这个对话已完成或已删除（只读）。发 /列表 换一个，或 /新 内容 新建。');
      return;
    }
    const body = this.withPendingMedia(sessionId, text);
    await getOrchestrator().handleUserMessage(sessionId, body);
    const row = await prisma.message.findFirst({ where: { sessionId, role: 'user' }, orderBy: { createdAt: 'desc' } });
    if (row) bus.emit({ type: 'assistant.message', sessionId, message: toMessageDTO(row) });
  }

  private withPendingMedia(sessionId: string, text: string): string {
    const items = this.pendingMedia.get(sessionId);
    if (!items?.length) return text;
    this.pendingMedia.delete(sessionId);
    const note = `[本次上传的文件（位于会话沙盘，可直接读取/编辑）]\n${items.map((a) => `- ${a.filename} → ${a.sandboxPath}`).join('\n')}`;
    return text ? `${text}\n\n${note}` : note;
  }

  /** Download images/files from WeChat into the session (same layout as web uploads). */
  private async saveInboundMedia(sessionId: string, items: MessageItem[]): Promise<void> {
    if (!this.client) return;
    const rawDir = path.join(config.paths.rawMaterials, 'uploads', sessionId);
    const sandboxUploads = path.join(sessionPaths(sessionId).sandbox, 'uploads');
    await fs.promises.mkdir(rawDir, { recursive: true });
    await fs.promises.mkdir(sandboxUploads, { recursive: true });
    for (const it of items) {
      try {
        let buf: Buffer;
        let name: string;
        let mime: string;
        if (it.type === ItemType.IMAGE && it.image_item?.media) {
          const key = it.image_item.aeskey ? Buffer.from(it.image_item.aeskey, 'hex').toString('base64') : undefined;
          buf = await this.client.downloadMedia(it.image_item.media, key);
          name = `wechat-image-${shortId(4)}.jpg`;
          mime = 'image/jpeg';
        } else if (it.type === ItemType.FILE && it.file_item?.media) {
          buf = await this.client.downloadMedia(it.file_item.media);
          name = it.file_item.file_name || `wechat-file-${shortId(4)}`;
          mime = 'application/octet-stream';
        } else if (it.type === ItemType.VIDEO && it.video_item?.media) {
          buf = await this.client.downloadMedia(it.video_item.media);
          name = `wechat-video-${shortId(4)}.mp4`;
          mime = 'video/mp4';
        } else continue;
        const fname = `${Date.now()}-${shortId(4)}-${safeFilename(name)}`;
        const dest = path.join(rawDir, fname);
        await fs.promises.writeFile(dest, buf);
        await fs.promises.copyFile(dest, path.join(sandboxUploads, fname)).catch(() => undefined);
        await prisma.attachment.create({ data: { sessionId, filename: name, path: dest, mime, size: buf.length } });
        const list = this.pendingMedia.get(sessionId) ?? [];
        list.push({ filename: name, sandboxPath: path.posix.join('uploads', fname) });
        this.pendingMedia.set(sessionId, list);
      } catch (err) {
        log.warn('inbound media download failed', err);
        await this.reply('有一个文件/图片没下载下来，请重发。');
      }
    }
  }

  // ── commands ─────────────────────────────────────────────────────────────

  private async handleCommand(cmd: Command, quoted: { sessionId: string | null; kind: string; fullText: string | null } | null): Promise<void> {
    const focus = this.account?.focusSessionId ?? null;
    switch (cmd.name) {
      case 'help':
        return this.reply(HELP_TEXT);
      case 'list':
        return this.reply(await this.listText());
      case 'switch': {
        const id = this.lastList[cmd.index - 1];
        if (!id) return this.reply('先发 /列表 看编号。');
        await this.connect(id, { announce: false });
        const s = await prisma.session.findUnique({ where: { id }, select: { title: true } });
        return this.reply(`已切到 [${this.bindings.get(id)}] ${clip(s?.title ?? '', 30)}（${this.running.has(id) ? '运行中' : '空闲'}）`);
      }
      case 'stop': {
        if (!focus) return this.reply('当前没有对话。');
        const turn = this.turns.get(focus);
        if (turn) turn.suppress = true;
        await getOrchestrator().interrupt(focus);
        return this.reply('已停止。');
      }
      case 'detail': {
        const src = quoted?.fullText ? { sessionId: quoted.sessionId, kind: quoted.kind, fullText: quoted.fullText } : this.lastPush;
        if (!src?.fullText) return this.reply('没有可展开的推送。');
        const text = await this.translator.composeDetail({ sessionId: src.sessionId ?? undefined, fullText: src.fullText });
        await this.send(text, { sessionId: src.sessionId, kind: 'detail', fullText: src.fullText });
        if (['completion', 'question', 'approval', 'error'].includes(src.kind)) {
          void this.translator.nudgeDetail(src.kind as PushKind, src.sessionId ?? undefined);
        }
        return;
      }
      case 'status':
        return this.reply(focus ? await this.statusText(focus) : '当前没有对话。发 /列表 选一个。');
      case 'disconnect': {
        if (!focus) return this.reply('当前没有对话。');
        await this.disconnect(focus);
        return this.reply('已断开，这个对话不再推送。');
      }
      case 'new': {
        const s = await createSession({ firstMessage: cmd.text });
        await this.connect(s.id, { announce: false });
        await getOrchestrator().handleUserMessage(s.id, cmd.text);
        const row = await prisma.message.findFirst({ where: { sessionId: s.id, role: 'user' }, orderBy: { createdAt: 'desc' } });
        if (row) bus.emit({ type: 'assistant.message', sessionId: s.id, message: toMessageDTO(row) });
        return this.reply(`已新建对话 [${this.bindings.get(s.id)}] ${clip(s.title, 30)}，开始干活了。`);
      }
      case 'send': {
        if (!focus || !this.pendingMedia.get(focus)?.length) return this.reply('没有待发送的文件。');
        return this.forward(focus, '（见附件）');
      }
      case 'settings':
      case 'preview':
      case 'search':
      case 'workflow':
      case 'progress':
      case 'quality':
      case 'archive':
      case 'browser':
      case 'today':
      case 'projects':
      case 'automations':
        return this.reply('微信里暂不支持这个指令（Discord 里可以用 !设置 / !预览 / !找 / !流程 / !进度 / !质检 / !归档 / !浏览器 / !今天 / !项目 / !自动化）。');
      case 'unknown':
        return this.reply(`不认识这个指令。\n${HELP_TEXT}`);
    }
  }

  private async listText(): Promise<string> {
    const boundIds = [...this.bindings.keys()];
    const bound = boundIds.length
      ? await prisma.session.findMany({ where: { id: { in: boundIds }, status: 'active' }, select: { id: true, title: true } })
      : [];
    const others = await prisma.session.findMany({
      where: { status: 'active', id: { notIn: boundIds } },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { id: true, title: true },
    });
    this.lastList = [...bound.map((s) => s.id), ...others.map((s) => s.id)];
    const focus = this.account?.focusSessionId;
    const lines: string[] = [];
    let n = 0;
    if (bound.length) {
      lines.push('已连接：');
      for (const s of bound) {
        lines.push(`${++n}. [${this.bindings.get(s.id)}] ${clip(s.title, 22)} · ${this.running.has(s.id) ? '运行中' : '空闲'}${s.id === focus ? ' ←当前' : ''}`);
      }
    }
    if (others.length) {
      lines.push('未连接（切过去会自动连接）：');
      for (const s of others) lines.push(`${++n}. ${clip(s.title, 24)}`);
    }
    if (!n) return '还没有进行中的对话。发 /新 你的任务 新建一个。';
    lines.push('回 /切 编号 切换');
    return lines.join('\n');
  }

  private async statusText(sessionId: string): Promise<string> {
    const [s, step, q, a] = await Promise.all([
      prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } }),
      prisma.planTask.findFirst({ where: { sessionId, status: 'in_progress' }, orderBy: { ordinal: 'asc' } }),
      prisma.pendingQuestion.count({ where: { sessionId, status: 'open', source: 'agent' } }),
      prisma.approval.count({ where: { sessionId, status: 'open' } }),
    ]);
    const turn = this.turns.get(sessionId);
    const parts = [`[${this.bindings.get(sessionId) ?? '-'}] ${clip(s?.title ?? '', 30)}`];
    parts.push(q ? '等你回答提问' : a ? '等你审批' : this.running.has(sessionId) ? '运行中' : '空闲');
    if (step) parts.push(`正在：${clip(toPlainText(step.text), 40)}`);
    if (turn && this.running.has(sessionId)) parts.push(`已跑 ${Math.max(1, Math.round((Date.now() - turn.startedAt.getTime()) / 60_000))} 分钟`);
    return parts.join(' · ');
  }
}

export const wechatBridge = new WechatBridge();

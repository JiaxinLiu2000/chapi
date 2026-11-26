/**
 * Minimal WeChat iLink bot protocol client.
 *
 * A trimmed re-implementation of the HTTP protocol used by Tencent's
 * `@tencent-weixin/openclaw-weixin` channel plugin (MIT), without its OpenClaw
 * runtime dependency: QR login, getupdates long-poll, sendmessage, typing, and
 * AES-128-ECB encrypted CDN upload/download for images and files.
 */
import crypto from 'node:crypto';
import { APP_VERSION } from '@chapi/shared';

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** Wire constants the iLink backend expects (mirrors the plugin build we read). */
const ILINK_APP_ID = 'bot';
const PROTOCOL_VERSION = '2.4.10';
const BOT_TYPE = '3';
const BOT_AGENT = `Chapi/${APP_VERSION}`;

export const STALE_TOKEN_ERRCODE = -14;

export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  ref_msg?: { message_item?: MessageItem; title?: string; svr_id?: string };
  text_item?: { text?: string };
  image_item?: { media?: CDNMedia; aeskey?: string; mid_size?: number };
  voice_item?: { media?: CDNMedia; text?: string; playtime?: number };
  file_item?: { media?: CDNMedia; file_name?: string; len?: string };
  video_item?: { media?: CDNMedia; video_size?: number };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface QrCode {
  qrcode: string;
  /** The string to render as a QR code (scanned with WeChat). */
  qrcodeContent: string;
}

export type QrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface QrStatusResp {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface UploadedMedia {
  downloadParam: string;
  /** hex-encoded AES key */
  aeskeyHex: string;
  rawSize: number;
  cipherSize: number;
}

type FetchFn = typeof fetch;

// ── helpers ────────────────────────────────────────────────────────────────

function clientVersion(v: string): number {
  const [a = 0, b = 0, c = 0] = v.split('.').map((p) => parseInt(p, 10) || 0);
  return ((a & 0xff) << 16) | ((b & 0xff) << 8) | (c & 0xff);
}

function randomUin(): string {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
}

function baseInfo() {
  return { channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT };
}

/** uint64 ids must not lose precision in JSON.parse — quote them first. */
export function parseLossless<T>(raw: string): T {
  return JSON.parse(raw.replace(/"(message_id|msg_id|svr_id)"(\s*):(\s*)(-?\d+)/g, '"$1"$2:$3"$4"')) as T;
}

export function encryptAesEcb(plain: Buffer, key: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plain), c.final()]);
}

export function decryptAesEcb(cipher: Buffer, key: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(cipher), d.final()]);
}

export function aesPaddedSize(n: number): number {
  return Math.ceil((n + 1) / 16) * 16;
}

/** aes_key arrives either as base64(16 raw bytes) or base64(32-char hex). */
export function parseAesKey(b64: string): Buffer {
  const d = Buffer.from(b64, 'base64');
  if (d.length === 16) return d;
  const ascii = d.toString('ascii');
  if (d.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex');
  throw new Error(`bad aes_key length ${d.length}`);
}

// ── client ─────────────────────────────────────────────────────────────────

export class IlinkClient {
  constructor(
    public baseUrl: string = ILINK_BASE_URL,
    public token: string = '',
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  private url(endpoint: string): string {
    return new URL(endpoint, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`).toString();
  }

  private commonHeaders(): Record<string, string> {
    return {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(clientVersion(PROTOCOL_VERSION)),
    };
  }

  private async post(endpoint: string, body: object, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const headers: Record<string, string> = {
        ...this.commonHeaders(),
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': randomUin(),
      };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const res = await this.fetchImpl(this.url(endpoint), {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, base_info: baseInfo() }),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return text;
    } finally {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async get(endpoint: string, timeoutMs: number): Promise<string> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.url(endpoint), { headers: this.commonHeaders(), signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return text;
    } finally {
      clearTimeout(t);
    }
  }

  // ── login ──

  async fetchQrCode(): Promise<QrCode> {
    const raw = await this.post(
      `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      { local_token_list: this.token ? [this.token] : [] },
      20_000,
    );
    const j = JSON.parse(raw) as { qrcode?: string; qrcode_img_content?: string };
    if (!j.qrcode || !j.qrcode_img_content) throw new Error('get_bot_qrcode: empty response');
    return { qrcode: j.qrcode, qrcodeContent: j.qrcode_img_content };
  }

  /** Long-poll the QR status; network errors / timeouts read as "wait". */
  async pollQrStatus(qrcode: string, verifyCode?: string): Promise<QrStatusResp> {
    let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) ep += `&verify_code=${encodeURIComponent(verifyCode)}`;
    try {
      return JSON.parse(await this.get(ep, 35_000)) as QrStatusResp;
    } catch {
      return { status: 'wait' };
    }
  }

  // ── messaging ──

  /** Long-poll for new messages. A client-side timeout returns an empty, successful response. */
  async getUpdates(buf: string, timeoutMs = 35_000, signal?: AbortSignal): Promise<GetUpdatesResp> {
    try {
      return parseLossless<GetUpdatesResp>(
        await this.post('ilink/bot/getupdates', { get_updates_buf: buf }, timeoutMs, signal),
      );
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError' && !signal?.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: buf };
      }
      throw err;
    }
  }

  /** Send one item; returns the server message_id (used to map quoted replies back). */
  async sendItem(to: string, item: MessageItem, contextToken?: string): Promise<string | undefined> {
    const raw = await this.post(
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: `chapi-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [item],
          context_token: contextToken || undefined,
        },
      },
      15_000,
    );
    const r = parseLossless<{ ret?: number; errcode?: number; errmsg?: string; message_id?: string }>(raw);
    if ((r.ret && r.ret !== 0) || (r.errcode && r.errcode !== 0)) {
      const e = new Error(`sendmessage ret=${r.ret ?? r.errcode} ${r.errmsg ?? ''}`.trim()) as Error & { code?: number };
      e.code = r.ret || r.errcode;
      throw e;
    }
    return r.message_id;
  }

  sendText(to: string, text: string, contextToken?: string): Promise<string | undefined> {
    return this.sendItem(to, { type: ItemType.TEXT, text_item: { text } }, contextToken);
  }

  async getTypingTicket(userId: string, contextToken?: string): Promise<string | undefined> {
    const raw = await this.post('ilink/bot/getconfig', { ilink_user_id: userId, context_token: contextToken }, 10_000);
    return (JSON.parse(raw) as { typing_ticket?: string }).typing_ticket;
  }

  async sendTyping(userId: string, ticket: string, status: number): Promise<void> {
    await this.post('ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: ticket, status }, 10_000);
  }

  // ── media ──

  /** Encrypt + upload a buffer to the WeChat CDN; returns what an IMAGE/FILE item needs. */
  async uploadMedia(buf: Buffer, toUserId: string, mediaType: number): Promise<UploadedMedia> {
    const rawSize = buf.length;
    const cipherSize = aesPaddedSize(rawSize);
    const filekey = crypto.randomBytes(16).toString('hex');
    const aeskey = crypto.randomBytes(16);
    const raw = await this.post(
      'ilink/bot/getuploadurl',
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: rawSize,
        rawfilemd5: crypto.createHash('md5').update(buf).digest('hex'),
        filesize: cipherSize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
      },
      15_000,
    );
    const r = JSON.parse(raw) as { upload_param?: string; upload_full_url?: string };
    const target = r.upload_full_url?.trim()
      ? r.upload_full_url.trim()
      : r.upload_param
        ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(r.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : null;
    if (!target) throw new Error('getuploadurl: no upload url');
    const cipher = encryptAesEcb(buf, aeskey);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.fetchImpl(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(cipher),
        });
        if (res.status >= 400 && res.status < 500) {
          throw Object.assign(new Error(`CDN upload ${res.status}: ${res.headers.get('x-error-message') ?? ''}`), { fatal: true });
        }
        if (res.status !== 200) throw new Error(`CDN upload ${res.status}`);
        const downloadParam = res.headers.get('x-encrypted-param');
        if (!downloadParam) throw new Error('CDN upload: missing x-encrypted-param');
        return { downloadParam, aeskeyHex: aeskey.toString('hex'), rawSize, cipherSize };
      } catch (err) {
        lastErr = err;
        if ((err as { fatal?: boolean }).fatal) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('CDN upload failed');
  }

  async sendImage(to: string, up: UploadedMedia, contextToken?: string): Promise<string | undefined> {
    return this.sendItem(
      to,
      {
        type: ItemType.IMAGE,
        image_item: {
          // The plugin base64-encodes the hex string itself (not the raw bytes) — keep it identical.
          media: { encrypt_query_param: up.downloadParam, aes_key: Buffer.from(up.aeskeyHex).toString('base64'), encrypt_type: 1 },
          mid_size: up.cipherSize,
        },
      },
      contextToken,
    );
  }

  async sendFile(to: string, fileName: string, up: UploadedMedia, contextToken?: string): Promise<string | undefined> {
    return this.sendItem(
      to,
      {
        type: ItemType.FILE,
        file_item: {
          media: { encrypt_query_param: up.downloadParam, aes_key: Buffer.from(up.aeskeyHex).toString('base64'), encrypt_type: 1 },
          file_name: fileName,
          len: String(up.rawSize),
        },
      },
      contextToken,
    );
  }

  /** Download + decrypt an inbound image/file. */
  async downloadMedia(media: CDNMedia, aesKeyB64?: string): Promise<Buffer> {
    const url =
      media.full_url ||
      (media.encrypt_query_param
        ? `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
        : null);
    if (!url) throw new Error('media has no download url');
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`CDN download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const key = aesKeyB64 ?? media.aes_key;
    return key ? decryptAesEcb(buf, parseAesKey(key)) : buf;
  }
}

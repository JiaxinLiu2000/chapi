import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createLogger } from '../logger.js';
import { isUserChromeEnabled } from './userChrome.js';

const log = createLogger('userChromeRelay');

/**
 * CDP relay for the user's own Chrome (jiaxin.liu@unitpulse.ai profile).
 *
 * Chrome 144+ ("Allow remote debugging for this browser instance") pops an
 * "Allow remote debugging?" dialog for EVERY new DevTools WebSocket. chapi_browser.py
 * used to connect_over_cdp straight to Chrome on each call, so the user had to click
 * "Allow" every single time. Instead the server keeps ONE upstream connection to
 * Chrome for up to an hour (one click), and chapi_browser.py connects here:
 *
 *   ws://127.0.0.1:<serverPort>/cdp/user-chrome?session=<sessionId>
 *
 * One client at a time; a second one waits its turn (chapi_browser.py also serializes
 * with a file lock).
 * Message ids are remapped so a late reply for a previous client is never handed to
 * the next one. When a client goes away we undo what a real disconnect would undo —
 * detach its sessions and switch off auto-attach — otherwise Chrome keeps every new
 * tab the user opens paused "waiting for debugger" (blank) behind the idle relay.
 */
export const USER_CHROME_RELAY_PATH = '/cdp/user-chrome';
// One "Allow" click is good for this long (override only for tests).
const TTL_MS = Number(process.env.CHAPI_USER_CHROME_TTL_MS) || 60 * 60 * 1000;
const UPSTREAM_OPEN_TIMEOUT_MS = 90_000; // time for the user to click "Allow"
const BLOCKED_METHODS = new Set(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess']);

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
  sessionId?: string;
};

interface Client {
  ws: WebSocket;
  /** relay id → the client's own id (+ method, to learn sessions from replies) */
  pending: Map<number, { id: number; method: string }>;
  sessions: Set<string>;
  queue: string[];
}

let upstream: WebSocket | null = null;
let upstreamEndpoint = '';
let upstreamOpening: Promise<WebSocket> | null = null;
let upstreamOpenedAt = 0;
let expiryTimer: NodeJS.Timeout | null = null;
let expired = false;
let client: Client | null = null;
let nextId = 1_000_000;
const ownPending = new Map<number, () => void>();

function chromeUserDataDir(): string {
  return (
    process.env.CHAPI_CHROME_USER_DATA ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
  );
}

/** ws endpoint of the user's Chrome from DevToolsActivePort, or null if remote debugging is off. */
export function chromeEndpoint(): string | null {
  try {
    const [port, wsPath] = fs.readFileSync(path.join(chromeUserDataDir(), 'DevToolsActivePort'), 'utf8').split(/\s+/);
    return port && wsPath ? `ws://127.0.0.1:${port}${wsPath}` : null;
  } catch {
    return null;
  }
}

export function userChromeRelayStatus(): { connected: boolean; expiresAt: string | null } {
  const connected = upstream?.readyState === WebSocket.OPEN;
  return {
    connected,
    expiresAt: connected ? new Date(upstreamOpenedAt + TTL_MS).toISOString() : null,
  };
}

function closeUpstream(reason: string): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  const u = upstream;
  upstream = null;
  upstreamOpening = null;
  expired = false;
  if (u && (u.readyState === WebSocket.OPEN || u.readyState === WebSocket.CONNECTING)) {
    log.info(`closing user-Chrome connection (${reason})`);
    u.close();
  }
}

function sendOwn(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<void> {
  const u = upstream;
  if (!u || u.readyState !== WebSocket.OPEN) return Promise.resolve();
  const id = nextId++;
  return new Promise<void>((resolve) => {
    const done = () => {
      ownPending.delete(id);
      resolve();
    };
    ownPending.set(id, done);
    setTimeout(done, 3000); // never wait on Chrome forever
    u.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

function onUpstreamMessage(raw: RawData): void {
  const text = raw.toString();
  let msg: CdpMessage;
  try {
    msg = JSON.parse(text) as CdpMessage;
  } catch {
    return;
  }
  if (typeof msg.id === 'number') {
    const own = ownPending.get(msg.id);
    if (own) return own();
    const c = client;
    const p = c?.pending.get(msg.id);
    if (!c || !p) return; // reply for a client that already left — drop it
    c.pending.delete(msg.id);
    const sid = msg.result?.sessionId;
    if (p.method === 'Target.attachToTarget' && typeof sid === 'string') c.sessions.add(sid);
    msg.id = p.id;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
    return;
  }
  // Event.
  if (msg.method === 'Target.attachedToTarget') {
    const sid = msg.params?.sessionId;
    if (typeof sid === 'string') {
      if (!client) {
        // Nobody is driving: let the target run and let go of it.
        void sendOwn('Runtime.runIfWaitingForDebugger', {}, sid).then(() =>
          sendOwn('Target.detachFromTarget', { sessionId: sid }),
        );
        return;
      }
      client.sessions.add(sid);
    }
  } else if (msg.method === 'Target.detachedFromTarget') {
    const sid = msg.params?.sessionId;
    if (typeof sid === 'string') client?.sessions.delete(sid);
  }
  if (client && client.ws.readyState === WebSocket.OPEN) client.ws.send(text);
}

function ensureUpstream(): Promise<WebSocket> {
  const endpoint = chromeEndpoint();
  if (!endpoint) return Promise.reject(new Error('user Chrome remote debugging is off (no DevToolsActivePort)'));
  if (upstream?.readyState === WebSocket.OPEN && upstreamEndpoint === endpoint) return Promise.resolve(upstream);
  if (upstreamOpening && upstreamEndpoint === endpoint) return upstreamOpening;
  closeUpstream('Chrome endpoint changed');
  upstreamEndpoint = endpoint;
  log.info('connecting to user Chrome — Chrome may ask the user to "Allow" once');
  const u = new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  upstream = u;
  upstreamOpening = new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for Chrome to accept the remote-debugging connection'));
      if (upstream === u) closeUpstream('open timeout');
      else u.terminate();
    }, UPSTREAM_OPEN_TIMEOUT_MS);
    u.once('open', () => {
      clearTimeout(timer);
      upstreamOpening = null;
      upstreamOpenedAt = Date.now();
      expired = false;
      expiryTimer = setTimeout(() => {
        // Hour is up: drop it now if idle, else right after the current client finishes.
        if (client) expired = true;
        else closeUpstream('1h window ended');
      }, TTL_MS);
      log.info('user Chrome connection approved; reusable for 1h');
      resolve(u);
    });
    u.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  u.on('message', onUpstreamMessage);
  u.on('close', () => {
    if (upstream === u) {
      upstream = null;
      upstreamOpening = null;
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
    }
    for (const done of ownPending.values()) done();
    if (client) client.ws.close(1011, 'user Chrome connection closed');
  });
  return upstreamOpening;
}

function forward(c: Client, text: string): void {
  let msg: CdpMessage;
  try {
    msg = JSON.parse(text) as CdpMessage;
  } catch {
    return;
  }
  if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
  if (BLOCKED_METHODS.has(msg.method)) {
    // Never let a script close/crash the user's real browser. Answer "ok" rather than
    // an error — Playwright's driver crashes on an error reply to Browser.close.
    log.warn(`blocked ${msg.method} on the user's Chrome`);
    // Echo sessionId: a reply routed to the wrong session trips a Playwright assertion.
    c.ws.send(JSON.stringify({ id: msg.id, result: {}, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }));
    return;
  }
  const relayId = nextId++;
  c.pending.set(relayId, { id: msg.id, method: msg.method });
  msg.id = relayId;
  upstream?.send(JSON.stringify(msg));
}

async function releaseClient(c: Client): Promise<void> {
  if (client !== c) return;
  // What a real disconnect would do: drop this client's sessions (their Fetch/Network
  // interception etc. die with them) and stop pausing new targets for a debugger.
  for (const sid of [...c.sessions].reverse()) {
    await sendOwn('Runtime.runIfWaitingForDebugger', {}, sid);
    await sendOwn('Target.detachFromTarget', { sessionId: sid });
  }
  await sendOwn('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  await sendOwn('Target.setDiscoverTargets', { discover: false });
  if (client === c) client = null;
  if (expired) closeUpstream('1h window ended');
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });

// Clients take turns: a new one waits (messages queued) until the previous one has
// been cleaned up — scripts often reconnect right after disconnecting.
let slotTail: Promise<void> = Promise.resolve();
const sessionOf = new WeakMap<object, string>();

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const c: Client = { ws, pending: new Map(), sessions: new Set(), queue: [] };
  const sid = sessionOf.get(req.socket) ?? '';
  let ready = false;
  let releaseSlot!: () => void;
  const mySlot = new Promise<void>((r) => (releaseSlot = r));
  const prev = slotTail;
  slotTail = prev.then(() => mySlot);

  ws.on('message', (raw) => {
    // The user can untick "用我的 Chrome" mid-run: stop at once.
    if (!isUserChromeEnabled(sid)) {
      ws.close(1008, 'user Chrome disabled for this session');
      return;
    }
    const text = raw.toString();
    if (ready) forward(c, text);
    else c.queue.push(text);
  });
  ws.on('close', () => {
    if (client === c) void releaseClient(c).finally(releaseSlot);
    // not active yet → the prev.then() below sees the closed socket and frees the slot
  });

  void prev.then(async () => {
    if (ws.readyState !== WebSocket.OPEN) return releaseSlot();
    client = c;
    try {
      await ensureUpstream();
    } catch (err) {
      log.warn(`user Chrome connection failed: ${err instanceof Error ? err.message : String(err)}`);
      ws.close(1011, 'could not connect to user Chrome');
      return; // close handler releases
    }
    if (ws.readyState !== WebSocket.OPEN) return; // close handler releases
    ready = true;
    for (const text of c.queue.splice(0)) forward(c, text);
  });
});

/**
 * Secret handed only to the agent's scripts (env CHAPI_USER_CHROME_TOKEN, see
 * engine/options.ts). Session ids are not secret, and any web page can open a
 * WebSocket to 127.0.0.1 — without this a malicious page could drive the user's
 * logged-in Chrome through the relay. New per server start.
 */
export const USER_CHROME_RELAY_TOKEN = randomBytes(32).toString('hex');

function tokenOk(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(USER_CHROME_RELAY_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Upgrade handler for USER_CHROME_RELAY_PATH. Only chapi's own scripts, only sessions with "用我的 Chrome" on. */
export function handleUserChromeRelayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const sid = url.searchParams.get('session') ?? '';
  const reject = (code: number, msg: string) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  // Browsers always send Origin on WebSocket upgrades; Playwright's client doesn't.
  if (req.headers.origin) return reject(403, 'Forbidden');
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return reject(403, 'Forbidden');
  if (!tokenOk(url.searchParams.get('token') ?? '')) return reject(403, 'Forbidden');
  if (!sid || !isUserChromeEnabled(sid)) return reject(403, 'Forbidden');
  sessionOf.set(socket, sid);
  if (!chromeEndpoint()) return reject(503, 'Chrome remote debugging off');
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

import CDP from 'chrome-remote-interface';
import { config } from '../config.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';

const log = createLogger('browser-view');
const HOST = '127.0.0.1';

/** Minimal shape of the chrome-remote-interface client we use. */
interface CdpClient {
  Page: {
    enable(): Promise<unknown>;
    startScreencast(opts: Record<string, unknown>): Promise<unknown>;
    stopScreencast(): Promise<unknown>;
    screencastFrameAck(opts: { sessionId: number }): Promise<unknown>;
  };
  on(event: string, cb: (param: unknown) => void): void;
  close(): Promise<void>;
}

/** Is cloakserve's CDP endpoint up? */
export async function cloakserveReachable(): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${config.cloakbrowserCdpPort}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Streams the live cloakbrowser screen to viewing sessions via CDP screencast.
 * One CDP connection is shared; frames fan out to all current viewers as
 * `browser.frame` events. Connects on first viewer, disconnects on last.
 */
class BrowserViewManager {
  private viewers = new Set<string>();
  private client: CdpClient | null = null;
  private connecting = false;
  private currentUrl: string | null = null;

  async addViewer(sessionId: string): Promise<void> {
    this.viewers.add(sessionId);
    bus.emit({ type: 'browser.state', sessionId, status: 'connecting', url: this.currentUrl });
    await this.ensureConnected(sessionId);
    if (this.client) {
      bus.emit({ type: 'browser.state', sessionId, status: 'connected', url: this.currentUrl });
    }
  }

  removeViewer(sessionId: string): void {
    if (!this.viewers.delete(sessionId)) return;
    if (this.viewers.size === 0) void this.disconnect();
  }

  private async ensureConnected(forSession: string): Promise<void> {
    if (this.client || this.connecting) return;
    if (!(await cloakserveReachable())) {
      this.viewers.delete(forSession);
      bus.emit({
        type: 'browser.state',
        sessionId: forSession,
        status: 'unavailable',
        url: null,
        message: 'cloakbrowser 未运行。请在设置启用浏览器并稍候（首次需下载内核）。',
      });
      return;
    }
    this.connecting = true;
    try {
      const client = (await CDP({ host: HOST, port: config.cloakbrowserCdpPort })) as unknown as CdpClient;
      this.client = client;
      const { Page } = client;
      await Page.enable();
      client.on('Page.frameNavigated', (p: unknown) => {
        const frame = (p as { frame?: { parentId?: string; url?: string } }).frame;
        if (frame && !frame.parentId && frame.url) this.currentUrl = frame.url;
      });
      client.on('Page.screencastFrame', (p: unknown) => {
        const f = p as { data: string; sessionId: number };
        for (const sid of this.viewers) {
          bus.emit({ type: 'browser.frame', sessionId: sid, dataBase64: f.data, url: this.currentUrl });
        }
        client.Page.screencastFrameAck({ sessionId: f.sessionId }).catch(() => undefined);
      });
      client.on('disconnect', () => {
        this.client = null;
        for (const sid of this.viewers) {
          bus.emit({ type: 'browser.state', sessionId: sid, status: 'disconnected', url: this.currentUrl });
        }
      });
      await Page.startScreencast({
        format: 'jpeg',
        quality: 55,
        maxWidth: 1280,
        maxHeight: 800,
        everyNthFrame: 2,
      });
      log.info('CDP screencast connected');
    } catch (err) {
      log.warn('CDP connect failed', err);
      this.client = null;
      bus.emit({
        type: 'browser.state',
        sessionId: forSession,
        status: 'unavailable',
        url: null,
        message: '连接 cloakbrowser 失败（CDP 未就绪）。',
      });
    } finally {
      this.connecting = false;
    }
  }

  private async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await c.Page.stopScreencast();
    } catch {
      /* ignore */
    }
    try {
      await c.close();
    } catch {
      /* ignore */
    }
    log.info('CDP screencast disconnected');
  }
}

export const browserView = new BrowserViewManager();

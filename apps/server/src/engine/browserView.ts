import CDP from 'chrome-remote-interface';
import { config } from '../config.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';

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

interface Pane {
  targetId: string;
  client: CdpClient;
  url: string | null;
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
 * Supports up to `maxBrowserPages` (1–2) page targets, each as a separate pane
 * (`browser.frame` with a page index). Connects on first viewer, disconnects on
 * last; periodically re-syncs which page targets are shown (open/close tabs).
 */
class BrowserViewManager {
  private viewers = new Set<string>();
  private panes: Pane[] = [];
  private connecting = false;
  private refresh: NodeJS.Timeout | null = null;

  async addViewer(sessionId: string): Promise<void> {
    this.viewers.add(sessionId);
    bus.emit({
      type: 'browser.state',
      sessionId,
      page: 0,
      pageCount: this.panes.length || 1,
      status: 'connecting',
      url: null,
    });
    await this.ensureConnected(sessionId);
    this.emitStateTo(sessionId, this.panes.length ? 'connected' : 'connecting');
    this.startRefresh();
  }

  removeViewer(sessionId: string): void {
    if (!this.viewers.delete(sessionId)) return;
    if (this.viewers.size === 0) void this.disconnectAll();
  }

  private emitStateTo(sessionId: string, status: 'connecting' | 'connected'): void {
    const count = this.panes.length || 1;
    for (let i = 0; i < count; i++) {
      bus.emit({
        type: 'browser.state',
        sessionId,
        page: i,
        pageCount: count,
        status,
        url: this.panes[i]?.url ?? null,
      });
    }
  }

  private async listPageTargets(): Promise<Array<{ id: string; url: string }>> {
    const res = await fetch(`http://${HOST}:${config.cloakbrowserCdpPort}/json`, {
      signal: AbortSignal.timeout(2000),
    });
    const arr = (await res.json()) as Array<{ id: string; type: string; url: string }>;
    return arr.filter((t) => t.type === 'page').map((t) => ({ id: t.id, url: t.url }));
  }

  /** A blank/new-tab page is "idle" — the agent isn't actively browsing on it. */
  private isIdleUrl(url?: string): boolean {
    const u = (url ?? '').trim().toLowerCase();
    return u === '' || u === 'about:blank' || u === 'about:newtab' || u.startsWith('chrome://new');
  }

  /** Non-idle page targets (what we actually show), capped to maxPages. */
  private async activeTargets(maxPages: number): Promise<Array<{ id: string; url: string }>> {
    const all = await this.listPageTargets().catch(() => []);
    return all.filter((t) => !this.isIdleUrl(t.url)).slice(0, maxPages);
  }

  private hideForAllViewers(): void {
    for (const sid of this.viewers) bus.emit({ type: 'browser.hide', sessionId: sid });
  }

  private async ensureConnected(forSession: string): Promise<void> {
    if (this.panes.length || this.connecting) return;
    if (!(await cloakserveReachable())) {
      this.viewers.delete(forSession);
      bus.emit({
        type: 'browser.state',
        sessionId: forSession,
        page: 0,
        pageCount: 1,
        status: 'unavailable',
        url: null,
        message: 'cloakbrowser 未运行。请在设置启用浏览器并稍候（首次需下载内核）。',
      });
      return;
    }
    this.connecting = true;
    try {
      const maxPages = await settings.getMaxBrowserPages();
      const targets = await this.activeTargets(maxPages);
      if (targets.length === 0) {
        // Nothing active yet — screencast the default target as pane 0 (resync will
        // collapse it shortly if it stays blank).
        await this.connectPane(0, undefined);
      } else {
        for (let i = 0; i < targets.length; i++) await this.connectPane(i, targets[i]?.id);
      }
      log.info(`CDP screencast connected (${this.panes.length} pane(s))`);
    } catch (err) {
      await this.disconnectPanes(); // drop any half-connected pane
      log.warn(`CDP connect failed: ${err instanceof Error ? err.message : String(err)}`);
      bus.emit({
        type: 'browser.state',
        sessionId: forSession,
        page: 0,
        pageCount: 1,
        status: 'unavailable',
        url: null,
        message: '连接 cloakbrowser 失败（CDP 未就绪）。',
      });
    } finally {
      this.connecting = false;
    }
  }

  private async connectPane(index: number, targetId: string | undefined): Promise<void> {
    const client = (await CDP({
      host: HOST,
      port: config.cloakbrowserCdpPort,
      ...(targetId ? { target: targetId } : {}),
    })) as unknown as CdpClient;
    const pane: Pane = { targetId: targetId ?? `pane-${index}`, client, url: null };
    this.panes[index] = pane;
    const { Page } = client;
    await Page.enable();
    client.on('Page.frameNavigated', (p: unknown) => {
      const frame = (p as { frame?: { parentId?: string; url?: string } }).frame;
      if (frame && !frame.parentId && frame.url) pane.url = frame.url;
    });
    client.on('Page.screencastFrame', (p: unknown) => {
      const f = p as { data: string; sessionId: number };
      for (const sid of this.viewers) {
        bus.emit({ type: 'browser.frame', sessionId: sid, page: index, dataBase64: f.data, url: pane.url });
      }
      client.Page.screencastFrameAck({ sessionId: f.sessionId }).catch(() => undefined);
    });
    client.on('disconnect', () => {
      for (const sid of this.viewers) {
        bus.emit({
          type: 'browser.state',
          sessionId: sid,
          page: index,
          pageCount: this.panes.length || 1,
          status: 'disconnected',
          url: pane.url,
        });
      }
    });
    // Keep the stream light: a heavy screencast competes for CPU with the page
    // itself (and anti-bot challenge JS is already CPU-hungry), which can make
    // cloakbrowser sluggish. Lower fps/quality is plenty for live monitoring.
    await Page.startScreencast({
      format: 'jpeg',
      quality: 45,
      maxWidth: 1100,
      maxHeight: 720,
      everyNthFrame: 4,
    });
  }

  /** Periodically re-sync which page targets are shown (e.g. agent opened a 2nd tab). */
  private startRefresh(): void {
    if (this.refresh) return;
    // Re-sync gently — frequent teardown/rebuild churns the browser, especially
    // while a page is busy. 6s is responsive enough for new/closed tabs.
    this.refresh = setInterval(() => void this.resync(), 6000);
  }

  private async resync(): Promise<void> {
    if (this.viewers.size === 0 || this.connecting) return;
    if (!(await cloakserveReachable())) return;
    const maxPages = await settings.getMaxBrowserPages();
    const targets = await this.activeTargets(maxPages);
    // All pages idle/blank → the agent stopped browsing. Stop streaming and ask
    // the clients to auto-collapse the live browser panel.
    if (targets.length === 0) {
      if (this.panes.length) await this.disconnectPanes();
      this.hideForAllViewers();
      return;
    }
    const wantIds = targets.map((t) => t.id);
    const haveIds = this.panes.map((p) => p.targetId);
    // Rebuild only if the set of shown (active) targets changed — this is also how
    // 2 panes drop to 1 when one tab goes blank.
    const changed =
      wantIds.length !== haveIds.length || wantIds.some((id, i) => id !== haveIds[i]);
    if (!changed) return;
    await this.disconnectPanes();
    await this.ensureConnectedFresh(targets);
    const sid = [...this.viewers][0];
    if (sid) this.emitStateTo(sid, this.panes.length ? 'connected' : 'connecting');
  }

  private async ensureConnectedFresh(targets: Array<{ id: string; url: string }>): Promise<void> {
    // like ensureConnected but assumes reachable + not guarded by existing panes
    this.connecting = true;
    try {
      for (let i = 0; i < targets.length; i++) await this.connectPane(i, targets[i]?.id);
    } catch (err) {
      await this.disconnectPanes(); // drop half-connected panes so the next resync starts clean
      log.warn(`CDP resync connect failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.connecting = false;
    }
  }

  private async disconnectPanes(): Promise<void> {
    const panes = this.panes;
    this.panes = [];
    for (const p of panes) {
      try {
        await p.client.Page.stopScreencast();
      } catch {
        /* ignore */
      }
      try {
        await p.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  private async disconnectAll(): Promise<void> {
    if (this.refresh) {
      clearInterval(this.refresh);
      this.refresh = null;
    }
    await this.disconnectPanes();
    log.info('CDP screencast disconnected');
  }
}

export const browserView = new BrowserViewManager();

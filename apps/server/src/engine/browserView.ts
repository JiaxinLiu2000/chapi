import CDP from 'chrome-remote-interface';
import { config } from '../config.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';

const log = createLogger('browser-view');
const HOST = '127.0.0.1';
const DEFAULT_TARGET = '__default__';

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
  index: number; // slot/page index shown on the frontend (reassigned on diff)
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

const sameIds = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Streams the live cloakbrowser screen to viewing sessions via CDP screencast.
 * Shows up to `maxBrowserPages` (1–2) non-idle page targets, each as its own pane
 * (`browser.frame` with a page index).
 *
 * Re-sync is **incremental + debounced**: it only attaches to NEW targets and
 * closes GONE ones (never tears down unchanged panes), and a target must be stable
 * for one poll before we attach to it. This avoids racing the agent's own
 * `connect_over_cdp` driver while it creates/navigates tabs (which previously
 * caused TargetClosedError and connection-handshake stomping under concurrency).
 */
class BrowserViewManager {
  private viewers = new Set<string>();
  private panes: Pane[] = [];
  private busy = false;
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

  private emitStateToAll(status: 'connecting' | 'connected'): void {
    for (const sid of this.viewers) this.emitStateTo(sid, status);
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

  private async activeTargets(maxPages: number): Promise<Array<{ id: string; url: string }>> {
    const all = await this.listPageTargets().catch(() => []);
    return all.filter((t) => !this.isIdleUrl(t.url)).slice(0, maxPages);
  }

  private hideForAllViewers(): void {
    for (const sid of this.viewers) bus.emit({ type: 'browser.hide', sessionId: sid });
  }

  private async ensureConnected(forSession: string): Promise<void> {
    if (this.panes.length || this.busy) return;
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
    this.busy = true;
    try {
      const maxPages = await settings.getMaxBrowserPages();
      const targets = await this.activeTargets(maxPages);
      if (targets.length === 0) {
        await this.connectPane(undefined); // show the current/default tab on open
      } else {
        await this.syncPanes(targets);
      }
      log.info(`CDP screencast connected (${this.panes.length} pane(s))`);
    } catch (err) {
      await this.closeAllPanes();
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
      this.busy = false;
    }
  }

  /** Reconcile shown panes to `desired` WITHOUT touching unchanged ones. */
  private async syncPanes(desired: Array<{ id: string; url: string }>): Promise<void> {
    const desiredIds = desired.map((t) => t.id);
    // Close panes whose target is gone.
    for (const pane of [...this.panes]) {
      if (!desiredIds.includes(pane.targetId)) await this.closePane(pane);
    }
    // Attach to newly-appeared targets (each independently — one failing attach
    // must not stop the others, so both active tabs still show).
    for (const t of desired) {
      if (!this.panes.find((p) => p.targetId === t.id)) {
        try {
          await this.connectPane(t.id);
        } catch (err) {
          log.warn(`attach pane failed for ${t.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // Order panes by desired order and reassign slot indices.
    this.panes.sort((a, b) => desiredIds.indexOf(a.targetId) - desiredIds.indexOf(b.targetId));
    this.panes.forEach((p, i) => (p.index = i));
  }

  private async connectPane(targetId: string | undefined): Promise<void> {
    const client = (await CDP({
      host: HOST,
      port: config.cloakbrowserCdpPort,
      ...(targetId ? { target: targetId } : {}),
    })) as unknown as CdpClient;
    const pane: Pane = {
      targetId: targetId ?? DEFAULT_TARGET,
      client,
      url: null,
      index: this.panes.length,
    };
    this.panes.push(pane);
    const { Page } = client;
    await Page.enable();
    client.on('Page.frameNavigated', (p: unknown) => {
      const frame = (p as { frame?: { parentId?: string; url?: string } }).frame;
      if (frame && !frame.parentId && frame.url) pane.url = frame.url;
    });
    client.on('Page.screencastFrame', (p: unknown) => {
      const f = p as { data: string; sessionId: number };
      for (const sid of this.viewers) {
        bus.emit({ type: 'browser.frame', sessionId: sid, page: pane.index, dataBase64: f.data, url: pane.url });
      }
      client.Page.screencastFrameAck({ sessionId: f.sessionId }).catch(() => undefined);
    });
    client.on('disconnect', () => {
      // A target the agent closed — drop the pane so the next poll re-diffs cleanly.
      this.panes = this.panes.filter((x) => x !== pane);
      this.panes.forEach((x, i) => (x.index = i));
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

  private async closePane(pane: Pane): Promise<void> {
    this.panes = this.panes.filter((p) => p !== pane);
    try {
      await pane.client.Page.stopScreencast();
    } catch {
      /* ignore */
    }
    try {
      await pane.client.close();
    } catch {
      /* ignore */
    }
  }

  private startRefresh(): void {
    if (this.refresh) return;
    // Poll briskly so a 2nd tab appears within a few seconds and idle tabs drop fast.
    this.refresh = setInterval(() => void this.resync(), 3000);
  }

  private async resync(): Promise<void> {
    if (this.viewers.size === 0 || this.busy) return;
    if (!(await cloakserveReachable())) return;
    this.busy = true;
    try {
      const maxPages = await settings.getMaxBrowserPages();
      const desired = await this.activeTargets(maxPages);
      const desiredIds = desired.map((t) => t.id);

      // All pages idle/blank → the agent stopped browsing. Collapse the panel.
      if (desiredIds.length === 0) {
        if (this.panes.length) await this.closeAllPanes();
        this.hideForAllViewers();
        return;
      }

      // Incremental: attach to NEW active targets, close GONE ones, leave unchanged
      // panes alone. This is how a 2nd active tab appears and how 2→1 happens when
      // one tab goes idle. (No debounce — window.open tabs are real, so attaching is
      // safe; the earlier TargetClosedError was from dead ctx.new_page() targets.)
      const haveIds = this.panes.map((p) => p.targetId);
      if (sameIds(desiredIds, haveIds)) return; // nothing changed

      await this.syncPanes(desired);
      this.emitStateToAll('connected');
    } catch (err) {
      log.warn(`CDP resync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async closeAllPanes(): Promise<void> {
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
    await this.closeAllPanes();
    log.info('CDP screencast disconnected');
  }
}

export const browserView = new BrowserViewManager();

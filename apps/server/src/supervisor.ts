import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CDP from 'chrome-remote-interface';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { settings } from './secrets.js';
import { cloakserveReachable } from './engine/browserView.js';

const log = createLogger('supervisor');
const isWin = process.platform === 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// repo-root/tools/browser/serve.py  (here = apps/server/src or apps/server/dist)
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_SCRIPT = path.resolve(here, '../../../tools/browser/serve.py');

/**
 * Manages cloakbrowser's `cloakserve` CDP server (the single persistent stealth
 * browser the agent drives and the user logs into). Auto-installed/run via `uv`.
 *
 * Per the cloakbrowser README, `cloakserve` binds 127.0.0.1:9222 by default and
 * takes flags like `--headless=false`; it does NOT take --port/--user-data-dir.
 * We run it headed so the user can log into accounts in the same browser.
 */
// How often to check that cloakbrowser is still up while it's enabled, and
// restart it if not. Without this, once the browser dies for any reason (the
// user closes the visible window, it crashes, the machine sleeps, …) nothing
// notices — ensureBrowserRunning() previously only ran at server boot or on an
// explicit user action, so it would just silently stay dead until someone
// happened to open Settings and re-toggle it, which is what "启用不成功"
// (looks like it never started, when it actually died sometime after) reports.
const HEALTH_CHECK_INTERVAL_MS = 30_000;

class Supervisor {
  private procs: ChildProcess[] = [];
  private logs: string[] = [];
  private starting = false;
  private serveProc: ChildProcess | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  private pushLog(chunk: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim();
      if (line) this.logs.push(`[${ts}] ${line}`);
    }
    if (this.logs.length > 100) this.logs = this.logs.slice(-100);
  }

  getLogs(): string[] {
    return this.logs.slice(-60);
  }

  start(): void {
    void this.ensureBrowserRunning().catch((err) => {
      this.pushLog(`浏览器自动启动检查失败（稍后可在设置重试）: ${err}`);
      log.warn('ensureBrowserRunning failed at startup', err);
    });
    this.healthCheckTimer = setInterval(() => {
      void this.ensureBrowserRunning().catch((err) => log.warn('browser health check failed', err));
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /** Idempotent: ensure cloakserve is installed and listening on the CDP port. */
  async ensureBrowserRunning(): Promise<void> {
    if (!(await settings.getBrowserEnabled())) return;
    if (this.starting) return;
    if (await cloakserveReachable()) return;
    this.starting = true;
    this.pushLog('启用 cloakbrowser：检查内核并启动 cloakserve（首次会下载内核 ~200MB）…');
    log.info('ensuring cloakbrowser / cloakserve');

    const install = spawn(
      'uvx',
      ['--from', 'cloakbrowser', 'python', '-m', 'cloakbrowser', 'install'],
      { shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    install.stdout?.on('data', (d) => this.pushLog(`install: ${d}`));
    install.stderr?.on('data', (d) => this.pushLog(`install: ${d}`));
    install.on('error', (e) => {
      this.pushLog(`install 失败: ${e}. 请确认已安装 uv (https://docs.astral.sh/uv/).`);
      this.starting = false;
    });
    const hidden = await settings.getBrowserHidden();
    install.on('exit', (code) => {
      this.pushLog(`内核检查/安装完成 (code ${code})，启动 cloakbrowser…`);
      this.startCloakserve(hidden);
      this.starting = false;
    });
  }

  /** Stop the current browser and start a fresh one (e.g. after toggling hidden mode). */
  async restartBrowser(): Promise<void> {
    this.stop();
    this.serveProc = null;
    await sleep(1500);
    await this.ensureBrowserRunning();
  }

  /**
   * Kill any stray `serve.py` processes left over from a previous server
   * instance. Windows doesn't deliver our SIGTERM handler's `supervisor.stop()`
   * reliably on every shutdown path (in particular, a dev-server auto-restart
   * on file change can terminate the old process before its cleanup runs) —
   * so a leftover orphan can keep holding the persistent Chromium profile's
   * singleton lock, silently blocking a fresh launch from starting cleanly
   * and accumulating across restarts. Clear the slate before every launch.
   */
  private killOrphanCloakserve(): void {
    if (!isWin) return;
    try {
      spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          // Match on the script filename alone — the exec'd grandchild python.exe
          // (the one actually hosting the browser) only carries `serve.py` in its
          // own argv, not the `cloakbrowser` package name from the uvx wrapper
          // that spawned it, so requiring both substrings would miss exactly the
          // process that matters. Restrict to the actual launcher executable
          // names too — otherwise this PowerShell invocation's own command line
          // (which necessarily contains the text "serve.py") matches itself.
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and " +
            "$_.CommandLine.Contains('serve.py') -and " +
            "$_.Name -in @('python.exe','uvx.exe','uv.exe') } " +
            '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
        ],
        { stdio: 'ignore' },
      );
    } catch {
      /* best-effort cleanup — a failure here shouldn't block starting a fresh one */
    }
  }

  private startCloakserve(hidden: boolean): void {
    if (this.serveProc) return;
    this.killOrphanCloakserve();
    const port = String(config.cloakbrowserCdpPort);
    this.pushLog(
      `启动持久化 cloakbrowser (${hidden ? 'headless/隐藏' : 'headed/可见'}, CDP 127.0.0.1:${port})`,
    );
    const child = spawn(
      'uvx',
      [
        '--from',
        'cloakbrowser',
        'python',
        SERVE_SCRIPT,
        config.cloakbrowserProfileDir,
        port,
        String(hidden),
      ],
      { shell: isWin, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout?.on('data', (d) => this.pushLog(`cloakserve: ${d}`));
    child.stderr?.on('data', (d) => this.pushLog(`cloakserve: ${d}`));
    child.on('error', (e) => this.pushLog(`cloakserve 启动失败: ${e}`));
    child.on('exit', (code) => {
      this.pushLog(`cloakserve 退出 (code ${code})`);
      this.serveProc = null;
    });
    this.serveProc = child;
    this.procs.push(child);
  }

  /** Open a URL in the cloakserve browser (same persistent profile) for manual login. */
  async openLoginPage(url: string): Promise<{ ok: boolean; message: string }> {
    await this.ensureBrowserRunning();
    for (let i = 0; i < 40; i++) {
      if (await cloakserveReachable()) break;
      await sleep(2000);
    }
    if (!(await cloakserveReachable())) {
      return {
        ok: false,
        message: 'cloakbrowser 尚未就绪（仍在下载/启动）。请在下方日志查看进度，稍后重试。',
      };
    }
    try {
      await CDP.New({ host: '127.0.0.1', port: config.cloakbrowserCdpPort, url });
      this.pushLog(`已在 cloakbrowser 打开登录页: ${url}`);
      return { ok: true, message: '' };
    } catch (e) {
      return { ok: false, message: `打开登录页失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    for (const p of this.procs) {
      try {
        if (isWin && p.pid) spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
        else p.kill();
      } catch {
        /* ignore */
      }
    }
    this.procs = [];
    this.serveProc = null;
  }
}

export const supervisor = new Supervisor();

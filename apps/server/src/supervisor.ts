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
class Supervisor {
  private procs: ChildProcess[] = [];
  private logs: string[] = [];
  private starting = false;
  private serveProc: ChildProcess | null = null;

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
    void this.ensureBrowserRunning();
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
    install.on('exit', (code) => {
      this.pushLog(`内核检查/安装完成 (code ${code})，启动 cloakserve…`);
      this.startCloakserve();
      this.starting = false;
    });
  }

  private startCloakserve(): void {
    if (this.serveProc) return;
    const port = String(config.cloakbrowserCdpPort);
    this.pushLog(`启动持久化 cloakbrowser (headed, CDP 127.0.0.1:${port}, profile ${config.cloakbrowserProfileDir})`);
    const child = spawn(
      'uvx',
      ['--from', 'cloakbrowser', 'python', SERVE_SCRIPT, config.cloakbrowserProfileDir, port],
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
      return {
        ok: true,
        message: '已在 cloakbrowser 窗口打开登录页，请在该窗口登录账号，登录态会持久保存并被 agent 复用。',
      };
    } catch (e) {
      return { ok: false, message: `打开登录页失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  stop(): void {
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

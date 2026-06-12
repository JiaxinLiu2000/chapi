import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { settings } from './secrets.js';
import { cloakserveReachable } from './engine/browserView.js';

const log = createLogger('supervisor');
const isWin = process.platform === 'win32';

const here = path.dirname(fileURLToPath(import.meta.url));
// repo-root/tools/browser/login.py  (here = apps/server/src or dist)
const LOGIN_SCRIPT = path.resolve(here, '../../../tools/browser/login.py');

/**
 * Manages cloakbrowser's `cloakserve` CDP server. cloakbrowser is auto-installed
 * and run via `uv` (no manual pip). Playwright MCP + the live-view screencast both
 * connect to this CDP endpoint; the persistent profile dir carries saved logins.
 *
 * Enabled via the `enableBrowser` setting (or CHAPI_ENABLE_BROWSER=1).
 */
class Supervisor {
  private procs: ChildProcess[] = [];

  start(): void {
    void this.maybeStartBrowser();
  }

  private async maybeStartBrowser(): Promise<void> {
    if (!(await settings.getBrowserEnabled())) return;
    fs.mkdirSync(config.cloakbrowserProfileDir, { recursive: true });
    if (await cloakserveReachable()) {
      log.info('cloakserve already reachable — not starting another');
      return;
    }
    log.info('cloakbrowser enabled — ensuring kernel (first run downloads ~200MB)…');
    // Pre-fetch the kernel, then start cloakserve. Best-effort; cloakserve may also
    // self-download on first launch.
    const install = spawn(
      'uvx',
      ['--from', 'cloakbrowser', 'python', '-m', 'cloakbrowser', 'install'],
      { stdio: 'ignore', shell: isWin },
    );
    install.on('error', (err) => log.warn(`cloakbrowser install failed (is uv installed?): ${String(err)}`));
    install.on('exit', () => this.startCloakserve());
  }

  private startCloakserve(): void {
    const port = String(config.cloakbrowserCdpPort);
    log.info(`starting cloakserve on :${port} (profile ${config.cloakbrowserProfileDir})`);
    const child = spawn(
      'uvx',
      [
        '--from',
        'cloakbrowser',
        'cloakserve',
        '--port',
        port,
        '--user-data-dir',
        config.cloakbrowserProfileDir,
      ],
      { stdio: 'ignore', shell: isWin },
    );
    child.on('error', (err) =>
      log.warn(`cloakserve failed to start (uv/cloakbrowser ok?): ${String(err)}`),
    );
    child.on('exit', (code) => log.warn(`cloakserve exited (code ${code})`));
    this.procs.push(child);
  }

  /** Launch a headful cloakbrowser with the persistent profile for manual login. */
  launchLogin(): { ok: boolean; message: string } {
    if (!fs.existsSync(LOGIN_SCRIPT)) {
      return { ok: false, message: `登录脚本缺失：${LOGIN_SCRIPT}` };
    }
    fs.mkdirSync(config.cloakbrowserProfileDir, { recursive: true });
    log.info('launching headful cloakbrowser for manual login');
    const child = spawn(
      'uvx',
      ['--from', 'cloakbrowser', '--with', 'cloakbrowser', 'python', LOGIN_SCRIPT, config.cloakbrowserProfileDir],
      { stdio: 'ignore', shell: isWin, detached: !isWin },
    );
    child.on('error', (err) => log.warn(`login launch failed: ${String(err)}`));
    this.procs.push(child);
    return {
      ok: true,
      message: '已打开浏览器，请登录所需账号后关闭窗口，登录信息会保存到持久化 profile。',
    };
  }

  stop(): void {
    for (const p of this.procs) {
      try {
        if (isWin && p.pid) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
        else p.kill();
      } catch {
        /* ignore */
      }
    }
    this.procs = [];
  }
}

export const supervisor = new Supervisor();

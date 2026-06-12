import { type ChildProcess, spawn } from 'node:child_process';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('supervisor');

/**
 * Manages local tool sidecars that the Agent SDK does NOT spawn itself.
 *
 * Note: Playwright MCP and google_workspace_mcp are launched by the SDK as
 * stdio MCP processes (see mcpRegistry). The only sidecar we manage here is
 * cloakbrowser's `cloakserve` CDP server, which the Playwright MCP connects to.
 *
 * Enabled via CHAPI_ENABLE_BROWSER=1. Requires (one-time):
 *   pip install cloakbrowser && python -m cloakbrowser install
 */
class Supervisor {
  private procs: ChildProcess[] = [];

  start(): void {
    if (process.env.CHAPI_ENABLE_BROWSER === '1') this.startCloakserve();
  }

  private startCloakserve(): void {
    const port = String(config.cloakbrowserCdpPort);
    log.info(`starting cloakserve on :${port} (profile ${config.cloakbrowserProfileDir})`);
    const child = spawn(
      'cloakserve',
      ['--port', port, '--user-data-dir', config.cloakbrowserProfileDir],
      { stdio: 'ignore', shell: process.platform === 'win32' },
    );
    child.on('error', (err) =>
      log.warn(`cloakserve failed to start (install cloakbrowser?): ${String(err)}`),
    );
    child.on('exit', (code) => log.warn(`cloakserve exited (code ${code})`));
    this.procs.push(child);
  }

  stop(): void {
    for (const p of this.procs) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    this.procs = [];
  }
}

export const supervisor = new Supervisor();

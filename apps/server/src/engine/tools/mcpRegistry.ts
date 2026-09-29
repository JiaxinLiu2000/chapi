import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { settings } from '../../secrets.js';

const log = createLogger('mcp-registry');

// Pinned so launches never re-resolve: an unpinned `uvx workspace-mcp` sometimes
// re-resolved and reinstalled ~96 packages on launch, which plus the heavy Python
// import pushed startup past the SDK's MCP connect timeout — the run then never
// got any mcp__google_workspace__* tools.
const WORKSPACE_MCP_VERSION = '1.30.0'; // PyPI version (the server self-reports 4.0.10)
const isWin = process.platform === 'win32';

/** Path to the persistently-installed workspace-mcp executable, if present. */
function installedWorkspaceMcp(): string | null {
  // NO_COLOR: the launcher sets FORCE_COLOR=1, which makes uv wrap the path in ANSI codes.
  const r = spawnSync('uv', ['tool', 'dir', '--bin'], {
    encoding: 'utf8',
    shell: isWin,
    env: { ...process.env, FORCE_COLOR: '', NO_COLOR: '1' },
  });
  const bin = r.status === 0 ? r.stdout.trim() : '';
  if (!bin) return null;
  const exe = path.join(bin, isWin ? 'workspace-mcp.exe' : 'workspace-mcp');
  return fs.existsSync(exe) ? exe : null;
}

let workspaceMcpExe: string | null = null;

/**
 * Install workspace-mcp once as a persistent uv tool (idempotent, run at boot in
 * the background) so each agent run launches the ready executable directly
 * instead of resolving it through `uvx` every time.
 */
export function ensureWorkspaceMcpInstalled(): void {
  workspaceMcpExe = installedWorkspaceMcp();
  const child = spawn('uv', ['tool', 'install', `workspace-mcp==${WORKSPACE_MCP_VERSION}`], {
    shell: isWin,
    stdio: 'ignore',
  });
  child.on('exit', (code) => {
    workspaceMcpExe = installedWorkspaceMcp();
    log.info(`workspace-mcp tool install exit=${code} exe=${workspaceMcpExe ?? '(none, using uvx)'}`);
  });
  child.on('error', (e) => log.warn('workspace-mcp tool install failed', e));
}

/**
 * Build the external MCP servers to attach to a run, based on settings/env.
 * Each is gated (off by default) because they require installs/credentials.
 * Failed/unavailable servers degrade gracefully (the SDK marks them failed).
 *
 *   CHAPI_ENABLE_CONTEXT7=1   docs lookup (npx @upstash/context7-mcp)
 *   CHAPI_ENABLE_BROWSER=1    cloakbrowser via Playwright MCP over CDP
 *   Google Workspace         auto-enabled when OAuth client id+secret are set in Settings
 *   Settings.canvaEnabled     Canva remote MCP
 */
export async function buildExternalMcpServers(): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {};

  if (process.env.CHAPI_ENABLE_CONTEXT7 === '1') {
    servers.context7 = { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
  }

  // Playwright MCP is OFF by default: its `npx @playwright/mcp` startup is slow
  // and has been observed to hang on init. The agent drives cloakbrowser directly
  // over CDP via the `chapi_browser.py` sandbox helper instead (reliable, scriptable,
  // shown live). Set CHAPI_ENABLE_BROWSER_MCP=1 to also expose the mcp__browser__* tools.
  if ((await settings.getBrowserEnabled()) && process.env.CHAPI_ENABLE_BROWSER_MCP === '1') {
    servers.browser = {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@playwright/mcp@latest',
        '--cdp-endpoint',
        `http://127.0.0.1:${config.cloakbrowserCdpPort}`,
      ],
    };
  }

  // Google Workspace: enabled whenever OAuth credentials are configured (Settings
  // or env). No separate enable flag — configuring credentials IS the opt-in.
  // First Google tool call triggers the browser OAuth consent flow.
  {
    const google = await settings.getGoogleOAuth();
    if (google.clientId && google.clientSecret) {
      const userEmail = await settings.getGoogleUserEmail();
      // --single-user: use the cached OAuth credentials directly (no per-session
      // mapping) so tools work in normal agent runs.
      // --tool-tier extended: registers Gmail's draft_gmail_message (not in 'core').
      // Sending is still blocked by permissions.ts + disallowedToolsFor.
      const flags = ['--single-user', '--tool-tier', 'extended'];
      workspaceMcpExe ??= installedWorkspaceMcp();
      servers.google_workspace = {
        type: 'stdio',
        ...(workspaceMcpExe
          ? { command: workspaceMcpExe, args: flags }
          : { command: 'uvx', args: [`workspace-mcp@${WORKSPACE_MCP_VERSION}`, ...flags] }),
        env: {
          GOOGLE_OAUTH_CLIENT_ID: google.clientId,
          GOOGLE_OAUTH_CLIENT_SECRET: google.clientSecret,
          ...(userEmail ? { USER_GOOGLE_EMAIL: userEmail } : {}),
        },
      };
    }
  }

  if (await settings.getCanvaEnabled()) {
    servers.canva = { type: 'http', url: 'https://mcp.canva.com/mcp' };
  }

  if (Object.keys(servers).length > 0) {
    log.info(`external MCP servers enabled: ${Object.keys(servers).join(', ')}`);
  }
  return servers;
}

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../config.js';
import { createLogger } from '../../logger.js';
import { settings } from '../../secrets.js';

const log = createLogger('mcp-registry');

/**
 * Build the external MCP servers to attach to a run, based on settings/env.
 * Each is gated (off by default) because they require installs/credentials.
 * Failed/unavailable servers degrade gracefully (the SDK marks them failed).
 *
 *   CHAPI_ENABLE_CONTEXT7=1   docs lookup (npx @upstash/context7-mcp)
 *   CHAPI_ENABLE_BROWSER=1    cloakbrowser via Playwright MCP over CDP
 *   CHAPI_ENABLE_GOOGLE=1     google_workspace_mcp (needs OAuth client in Settings)
 *   Settings.canvaEnabled     Canva remote MCP
 */
export async function buildExternalMcpServers(): Promise<Record<string, McpServerConfig>> {
  const servers: Record<string, McpServerConfig> = {};

  if (process.env.CHAPI_ENABLE_CONTEXT7 === '1') {
    servers.context7 = { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
  }

  if (process.env.CHAPI_ENABLE_BROWSER === '1') {
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

  if (process.env.CHAPI_ENABLE_GOOGLE === '1') {
    const google = await settings.getGoogleOAuth();
    if (google.clientId && google.clientSecret) {
      const userEmail = await settings.getGoogleUserEmail();
      servers.google_workspace = {
        type: 'stdio',
        command: 'uvx',
        args: ['workspace-mcp', '--tool-tier', 'core'],
        env: {
          GOOGLE_OAUTH_CLIENT_ID: google.clientId,
          GOOGLE_OAUTH_CLIENT_SECRET: google.clientSecret,
          ...(userEmail ? { USER_GOOGLE_EMAIL: userEmail } : {}),
        },
      };
    } else {
      log.warn('CHAPI_ENABLE_GOOGLE set but Google OAuth client not configured in Settings');
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

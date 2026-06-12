import type { FastifyInstance } from 'fastify';
import type { BrowserLoginResponse, BrowserStatusResponse } from '@chapi/shared';
import { config } from '../../config.js';
import { settings } from '../../secrets.js';
import { supervisor } from '../../supervisor.js';
import { cloakserveReachable } from '../../engine/browserView.js';

export async function browserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/browser/status', async (): Promise<BrowserStatusResponse> => {
    const serving = await cloakserveReachable();
    const enabled = await settings.getBrowserEnabled();
    return {
      installed: serving,
      serving,
      enabled,
      profileDir: config.cloakbrowserProfileDir,
      message: serving
        ? 'cloakbrowser 正在运行 (127.0.0.1:9222)。'
        : enabled
          ? 'cloakbrowser 已启用，正在启动/下载内核中（看下方日志）。'
          : '未启用 cloakbrowser。',
      logs: supervisor.getLogs(),
    };
  });

  // Start (or restart) the cloakserve browser process.
  app.post('/browser/start', async (): Promise<BrowserStatusResponse> => {
    await supervisor.ensureBrowserRunning();
    const serving = await cloakserveReachable();
    const enabled = await settings.getBrowserEnabled();
    return {
      installed: serving,
      serving,
      enabled,
      profileDir: config.cloakbrowserProfileDir,
      message: enabled
        ? '正在启动 cloakbrowser…（首次需下载内核，请稍候并刷新状态）'
        : '请先在上方启用 cloakbrowser 并保存。',
      logs: supervisor.getLogs(),
    };
  });

  app.post('/browser/login', async (): Promise<BrowserLoginResponse> => {
    const r = await supervisor.openLoginPage('https://accounts.google.com');
    return { status: r.ok ? 'launched' : 'error', message: r.message };
  });
}

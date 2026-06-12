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
        ? 'cloakbrowser 正在运行。'
        : enabled
          ? 'cloakbrowser 已启用，正在启动/下载内核中（首次较慢）。'
          : '未启用 cloakbrowser。',
    };
  });

  app.post('/browser/login', async (): Promise<BrowserLoginResponse> => {
    const r = supervisor.launchLogin();
    return { status: r.ok ? 'launched' : 'error', message: r.message };
  });
}

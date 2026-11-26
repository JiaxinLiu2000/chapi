import type { FastifyInstance } from 'fastify';
import { wechatBridge } from '../../wechat/bridge.js';

/** WeChat remote: QR login, status, and per-session connect/disconnect. */
export async function wechatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/wechat/status', async () => ({ status: await wechatBridge.status() }));

  app.post('/wechat/login', async (_req, reply) => {
    try {
      return { login: await wechatBridge.startLogin() };
    } catch (err) {
      return reply.status(502).send({ error: `获取微信二维码失败：${err instanceof Error ? err.message : String(err)}` });
    }
  });

  app.get('/wechat/login', async () => ({ login: wechatBridge.loginSnapshot() }));

  app.post<{ Body: { code?: string } }>('/wechat/login/verify', async (req, reply) => {
    const code = String(req.body?.code ?? '').trim();
    if (!code) return reply.status(400).send({ error: 'code required' });
    wechatBridge.submitVerifyCode(code);
    return { login: wechatBridge.loginSnapshot() };
  });

  app.post('/wechat/logout', async () => {
    await wechatBridge.logout();
    return { status: await wechatBridge.status() };
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/wechat', async (req) => ({ state: wechatBridge.sessionState(req.params.id) }));

  app.post<{ Params: { id: string }; Body: { on?: boolean } }>('/sessions/:id/wechat', async (req, reply) => {
    try {
      const state = req.body?.on === false
        ? await wechatBridge.disconnect(req.params.id)
        : await wechatBridge.connect(req.params.id);
      return { state };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

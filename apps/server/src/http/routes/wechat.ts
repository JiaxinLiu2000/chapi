import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { wechatBridge } from '../../wechat/bridge.js';
import { fromWebUI } from '../originGuard.js';

/** Changing remote settings / connections / login must come from the chapi web UI (not the AI's shell, not another site). */
function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  if (fromWebUI(req.headers.origin)) return true;
  void reply.status(403).send({ error: '只能由用户在 chapi 页面上操作。' });
  return false;
}

/** WeChat remote: QR login, status, and per-session connect/disconnect. */
export async function wechatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/wechat/status', async () => ({ status: await wechatBridge.status() }));

  app.post('/wechat/login', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    try {
      return { login: await wechatBridge.startLogin() };
    } catch (err) {
      return reply.status(502).send({ error: `获取微信二维码失败：${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // The QR code is a pairing secret: only the web UI may read it.
  app.get('/wechat/login', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    return { login: wechatBridge.loginSnapshot() };
  });

  app.post<{ Body: { code?: string } }>('/wechat/login/verify', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const code = String(req.body?.code ?? '').trim();
    if (!code) return reply.status(400).send({ error: 'code required' });
    wechatBridge.submitVerifyCode(code);
    return { login: wechatBridge.loginSnapshot() };
  });

  app.post('/wechat/logout', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    await wechatBridge.logout();
    return { status: await wechatBridge.status() };
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/wechat', async (req) => ({ state: wechatBridge.sessionState(req.params.id) }));

  app.post<{ Params: { id: string }; Body: { on?: boolean } }>('/sessions/:id/wechat', async (req, reply) => {
    if (!guard(req, reply)) return reply;
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

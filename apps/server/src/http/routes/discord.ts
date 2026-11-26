import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { discordBridge, discordGateway } from '../../discord/gateway.js';
import { settings } from '../../secrets.js';
import { fromWebUI } from '../originGuard.js';

/** Changing remote settings / connections / login must come from the chapi web UI (not the AI's shell, not another site). */
function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  if (fromWebUI(req.headers.origin)) return true;
  void reply.status(403).send({ error: '只能由用户在 chapi 页面上操作。' });
  return false;
}

/** Discord remote: bot token / channel config, prefs, status, per-session connect. */
export async function discordRoutes(app: FastifyInstance): Promise<void> {
  app.get('/discord/status', async () => ({ status: await discordGateway.status() }));

  app.put<{ Body: { token?: string | null; channelId?: string | null } }>('/discord/config', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const body = req.body ?? {};
    const input: { token?: string | null; channelId?: string | null } = {};
    if (body.token !== undefined) input.token = typeof body.token === 'string' ? body.token.trim() : null;
    if (body.channelId !== undefined) input.channelId = body.channelId ? String(body.channelId) : null;
    await discordGateway.configure(input);
    return { status: await discordGateway.status() };
  });

  app.put<{ Body: { autoAutomations?: unknown; remindManual?: unknown } }>('/discord/prefs', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const b = req.body ?? {};
    const patch: { autoAutomations?: boolean; remindManual?: boolean } = {};
    if (typeof b.autoAutomations === 'boolean') patch.autoAutomations = b.autoAutomations;
    if (typeof b.remindManual === 'boolean') patch.remindManual = b.remindManual;
    await settings.setDiscordPrefs(patch);
    return { status: await discordGateway.status() };
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/discord', async (req) => ({ state: discordBridge.sessionState(req.params.id) }));

  app.post<{ Params: { id: string }; Body: { on?: boolean } }>('/sessions/:id/discord', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    try {
      const state = req.body?.on === false ? await discordBridge.disconnect(req.params.id) : await discordBridge.connect(req.params.id);
      return { state };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

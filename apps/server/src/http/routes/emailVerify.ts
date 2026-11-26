import type { FastifyInstance } from 'fastify';
import { emailVerifySchema, type EmailVerifyResponse, type EmailVerifyStatusResponse } from '@chapi/shared';
import { emailVerifier } from '../../tools/emailVerify.js';

export async function emailVerifyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/email-verify/status', async (): Promise<EmailVerifyStatusResponse> => {
    return emailVerifier.status();
  });

  // Also callable from the agent's batch scripts via CHAPI_SERVER_URL.
  app.post('/email-verify', async (req, reply): Promise<EmailVerifyResponse | void> => {
    const parsed = emailVerifySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      const { results, notes } = await emailVerifier.verify(parsed.data.emails);
      return { results, notes };
    } catch (e) {
      return reply.status(503).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}

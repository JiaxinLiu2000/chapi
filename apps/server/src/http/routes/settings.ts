import type { FastifyInstance } from 'fastify';
import { updateSettingsSchema } from '@chapi/shared';
import { settings } from '../../secrets.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', async () => {
    return { settings: await settings.getPublic() };
  });

  app.put('/settings', async (req, reply) => {
    const parsed = updateSettingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    await settings.update(parsed.data);
    return { settings: await settings.getPublic() };
  });
}

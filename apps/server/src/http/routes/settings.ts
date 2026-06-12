import type { FastifyInstance } from 'fastify';
import { updateSettingsSchema } from '@chapi/shared';
import { settings } from '../../secrets.js';
import { connectGoogle } from '../../services/googleAuth.js';
import { supervisor } from '../../supervisor.js';

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
    // Turning cloakbrowser on starts cloakserve immediately (no server restart).
    if (parsed.data.enableBrowser === true) void supervisor.ensureBrowserRunning();
    return { settings: await settings.getPublic() };
  });

  // Proactively start Google Workspace authorization from the Settings UI.
  app.post('/google/connect', async () => {
    return connectGoogle();
  });
}

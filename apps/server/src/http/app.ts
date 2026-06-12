import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/sessions.js';
import { settingsRoutes } from './routes/settings.js';
import { wikiRoutes } from './routes/wiki.js';
import { uploadRoutes } from './routes/uploads.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

  // Local single-user app: the server binds to loopback, so reflecting any origin
  // is safe and avoids "Failed to fetch" when the web is opened via a LAN URL
  // (e.g. http://192.168.x.x:3100) or a non-default port.
  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(multipart, {
    limits: { fileSize: 100 * 1024 * 1024, files: 10 },
  });

  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(wikiRoutes, { prefix: '/api' });
  await app.register(uploadRoutes, { prefix: '/api' });

  return app;
}

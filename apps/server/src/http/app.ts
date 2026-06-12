import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from '../config.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/sessions.js';
import { settingsRoutes } from './routes/settings.js';
import { wikiRoutes } from './routes/wiki.js';
import { uploadRoutes } from './routes/uploads.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

  await app.register(cors, {
    origin: [`http://localhost:${config.webPort}`, `http://127.0.0.1:${config.webPort}`],
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

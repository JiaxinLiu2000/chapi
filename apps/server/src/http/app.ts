import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/sessions.js';
import { settingsRoutes } from './routes/settings.js';
import { wikiRoutes } from './routes/wiki.js';
import { uploadRoutes } from './routes/uploads.js';
import { browserRoutes } from './routes/browser.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });

  // Tolerate empty bodies on JSON POSTs (e.g. /google/connect, /browser/login send
  // content-type: application/json with no body). Default Fastify rejects these 400.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const s = typeof body === 'string' ? body.trim() : '';
      if (!s) return done(null, {});
      try {
        done(null, JSON.parse(s));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

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
  await app.register(browserRoutes, { prefix: '/api' });

  return app;
}

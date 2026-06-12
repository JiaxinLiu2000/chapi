import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db/client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    let db = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      db = false;
    }
    return { ok: true, db };
  });
}

import '../config.js'; // ensure .env (DATABASE_URL) is loaded before client init
import { PrismaClient } from '@prisma/client';
import { createLogger } from '../logger.js';

const log = createLogger('db');

/** Single shared Prisma client for the process. */
export const prisma = new PrismaClient();

/**
 * Block until the DB accepts queries, retrying until `maxWaitMs` elapses. MySQL's
 * container can report "healthy" (internal check) well before Docker Desktop's HOST
 * port forwarding is ready — especially right after Docker cold-starts — so the
 * host-side connection can be refused for a couple of minutes. Wait it out instead
 * of crashing startup.
 */
export async function waitForDb(maxWaitMs = 180000, delayMs = 1500): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (attempt > 1) log.info(`database reachable after ${attempt} attempt(s)`);
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      if (attempt === 1) {
        log.warn('waiting for database (Docker/WSL2 host port forwarding can lag on cold start)…');
      } else if (attempt % 10 === 0) {
        log.warn(`still waiting for database… (${attempt} tries)`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

import '../config.js'; // ensure .env (DATABASE_URL) is loaded before client init
import { PrismaClient } from '@prisma/client';
import { createLogger } from '../logger.js';

const log = createLogger('db');

/** Single shared Prisma client for the process. */
export const prisma = new PrismaClient();

/**
 * Block until the DB accepts queries. The server can boot a hair before MySQL is
 * ready to accept connections (even after the launcher's healthcheck), and the
 * very first query would otherwise throw an init error and crash startup.
 */
export async function waitForDb(attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (i > 1) log.info(`database reachable after ${i} attempt(s)`);
      return;
    } catch (err) {
      if (i === attempts) throw err;
      if (i === 1) log.warn('waiting for database to become reachable…');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

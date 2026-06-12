import '../config.js'; // ensure .env (DATABASE_URL) is loaded before client init
import { PrismaClient } from '@prisma/client';

/** Single shared Prisma client for the process. */
export const prisma = new PrismaClient();

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

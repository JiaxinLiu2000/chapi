import { config, ensureBaseDirs } from './config.js';
import { disconnectDb } from './db/client.js';
import { attachWebSocket } from './gateway/ws.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';
import { SdkOrchestrator } from './engine/orchestrator.js';
import { scheduler } from './engine/scheduler.js';
import { setOrchestrator } from './orchestrator/types.js';
import { seedWorkspaces } from './services/workspaces.js';
import { supervisor } from './supervisor.js';

const log = createLogger('server');

async function main(): Promise<void> {
  ensureBaseDirs();
  await seedWorkspaces();
  supervisor.start();

  // Claude Agent SDK orchestrator drives sessions. Requires ANTHROPIC_API_KEY
  // (env or Settings); without it, runs emit an error event prompting setup.
  setOrchestrator(new SdkOrchestrator());
  void scheduler.reloadPending(); // re-arm any timed tasks left from a restart

  const app = await buildApp();
  await app.listen({ port: config.serverPort, host: config.host });
  attachWebSocket(app.server);

  log.info(`HTTP + WS on http://${config.host}:${config.serverPort}`);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    supervisor.stop();
    await app.close().catch(() => undefined);
    await disconnectDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal startup error', err);
  process.exit(1);
});

import { config, ensureBaseDirs } from './config.js';
import { disconnectDb, waitForDb } from './db/client.js';
import { attachWebSocket } from './gateway/ws.js';
import { buildApp } from './http/app.js';
import { createLogger } from './logger.js';
import { SdkOrchestrator } from './engine/orchestrator.js';
import { scheduler } from './engine/scheduler.js';
import { qualityAdvisor } from './engine/quality.js';
import { initWikiVault } from './rag/wiki.js';
import { setOrchestrator } from './orchestrator/types.js';
import { seedWorkspaces } from './services/workspaces.js';
import { supervisor } from './supervisor.js';
import { ensureWorkspaceMcpInstalled } from './engine/tools/mcpRegistry.js';
import { emailVerifier } from './tools/emailVerify.js';
import { startRunnerListeners } from './board/runner.js';
import { boardCron } from './board/cron.js';
import { seedAutomations } from './board/seed.js';
import { wechatBridge } from './wechat/bridge.js';
import { discordGateway } from './discord/gateway.js';

const log = createLogger('server');

async function main(): Promise<void> {
  ensureBaseDirs();
  await waitForDb(); // don't touch the DB until MySQL actually accepts connections
  await seedWorkspaces();
  supervisor.start();
  ensureWorkspaceMcpInstalled();
  void emailVerifier.prepare(); // builds the verifier if enabled and missing/stale

  // Claude Agent SDK orchestrator drives sessions. Requires ANTHROPIC_API_KEY
  // (env or Settings); without it, runs emit an error event prompting setup.
  setOrchestrator(new SdkOrchestrator());
  void scheduler.reloadPending(); // re-arm any timed tasks left from a restart
  startRunnerListeners(); // board automations: status sync + sweep
  void boardCron.start(); // board automations: 30s tick + restart catch-up
  void seedAutomations().catch((err) => log.warn('seedAutomations failed', err)); // once per install (Setting board.seeded): 6 starter tasks
  void qualityAdvisor.reloadAll(); // re-arm quality advisors (timers are in-memory)
  void initWikiVault(); // Obsidian vault ⇄ DB sync + file watcher
  void wechatBridge.start().catch((err) => log.error('wechat bridge failed to start', err)); // WeChat remote (no-op until logged in)
  void discordGateway.start().catch((err) => log.error('discord bridge failed to start', err)); // Discord remote (no-op without a bot token)

  const app = await buildApp();
  await app.listen({ port: config.serverPort, host: config.host });
  attachWebSocket(app.server);

  log.info(`HTTP + WS on http://${config.host}:${config.serverPort}`);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    supervisor.stop();
    wechatBridge.stop();
    await discordGateway.stop();
    await app.close().catch(() => undefined);
    await disconnectDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Safety net: a transient async error (e.g. a brief DB blip, a CDP disconnect)
// must NOT take down the whole server — background sessions/timers keep running.
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection (server kept alive)', reason);
});
process.on('uncaughtException', (err) => {
  log.error('uncaughtException (server kept alive)', err);
});

main().catch((err) => {
  log.error('fatal startup error', err);
  process.exit(1);
});

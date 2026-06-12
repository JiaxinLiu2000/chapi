/** Tiny structured-ish logger. Local single-user app; keep it simple. */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold: Level = process.env.LOG_LEVEL === 'debug' ? 'debug' : 'info';

function log(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (order[level] < order[threshold]) return;
  const ts = new Date().toISOString();
  const prefix = `${ts} ${level.toUpperCase()} [${scope}]`;
  if (extra !== undefined) {
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](prefix, msg, extra);
  } else {
    // eslint-disable-next-line no-console
    console[level === 'debug' ? 'log' : level](prefix, msg);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => log('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => log('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => log('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => log('error', scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof createLogger>;

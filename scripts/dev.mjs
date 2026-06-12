#!/usr/bin/env node
// One-click dev launcher: starts MySQL + backend + frontend, and tears ALL of
// them down (incl. the database container) when this process is stopped (Ctrl+C),
// terminated, or a child crashes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = (t, m) => console.log(`\x1b[2m[${t}]\x1b[0m ${m}`);
const DATABASE_URL = process.env.DATABASE_URL || 'mysql://chapi:chapi@127.0.0.1:3307/chapi';

const children = [];
let shuttingDown = false;

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (isWin) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

function shutdown(reason = '') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n\x1b[33m[chapi] stopping frontend + backend + database${reason ? ` (${reason})` : ''}…\x1b[0m`);
  for (const c of children) killTree(c);
  spawnSync('docker', ['compose', 'stop'], { cwd: root, stdio: 'inherit', shell: isWin });
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => shutdown(sig));
}

function start(name, args, color) {
  const child = spawn('pnpm', args, {
    cwd: root,
    shell: isWin,
    detached: !isWin, // own process group on posix so we can kill the whole tree
    env: { ...process.env, DATABASE_URL, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (line) => `${color}[${name}]\x1b[0m ${line}`;
  const pipe = (stream) =>
    stream.on('data', (d) => {
      const out = d
        .toString()
        .split('\n')
        .filter((l) => l.length > 0)
        .map(prefix)
        .join('\n');
      if (out) process.stdout.write(out + '\n');
    });
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) shutdown(`${name} exited with ${code}`);
  });
  children.push(child);
}

async function main() {
  if (!fs.existsSync(path.join(root, '.env'))) {
    tag('setup', '.env not found — run `node scripts/setup.mjs` first (continuing with defaults).');
  }

  tag('db', 'starting MySQL (docker compose up -d mysql)…');
  spawnSync('docker', ['compose', 'up', '-d', 'mysql'], { cwd: root, stdio: 'inherit', shell: isWin });

  tag('db', 'waiting for MySQL to be healthy…');
  let healthy = false;
  for (let i = 0; i < 45; i++) {
    const out = spawnSync(
      'docker',
      ['inspect', '--format', '{{.State.Health.Status}}', 'chapi-mysql'],
      { encoding: 'utf8' },
    );
    if ((out.stdout || '').trim() === 'healthy') {
      healthy = true;
      break;
    }
    await sleep(2000);
  }
  tag('db', healthy ? 'MySQL healthy ✓' : 'MySQL not healthy yet (continuing)');

  tag('db', 'ensuring schema (prisma db push)…');
  spawnSync('pnpm', ['--filter', '@chapi/server', 'exec', 'prisma', 'db', 'push', '--skip-generate'], {
    cwd: root,
    stdio: 'ignore',
    shell: isWin,
    env: { ...process.env, DATABASE_URL },
  });

  tag('run', 'starting backend (:8123) and frontend (:3100)…');
  start('server', ['--filter', '@chapi/server', 'dev'], '\x1b[36m');
  start('web', ['--filter', '@chapi/web', 'dev'], '\x1b[35m');

  console.log(
    '\n\x1b[32m✅ Chapi is starting →\x1b[0m  web http://localhost:3100   |   server http://localhost:8123',
  );
  console.log('   Press Ctrl+C to stop everything (frontend + backend + database).\n');
}

main().catch((err) => {
  console.error('[chapi] launcher error:', err);
  shutdown('launcher error');
});

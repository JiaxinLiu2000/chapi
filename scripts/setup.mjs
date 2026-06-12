#!/usr/bin/env node
// One-shot local setup: check tools, create .env, start MySQL, push schema.
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
const has = (cmd) => spawnSync(cmd, ['--version'], { shell: true }).status === 0;

console.log('— Chapi setup —');

for (const [tool, ok] of [
  ['node', has('node')],
  ['pnpm', has('pnpm')],
  ['docker', has('docker')],
  ['uv', has('uv')],
]) {
  console.log(`  ${ok ? '✓' : '✗'} ${tool}${ok ? '' : ' (missing — install it)'}`);
}

// .env
const envPath = path.join(root, '.env');
if (!fs.existsSync(envPath)) {
  let env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  env = env.replace(/^SECRETS_KEY=.*$/m, `SECRETS_KEY=${randomBytes(32).toString('hex')}`);
  fs.writeFileSync(envPath, env);
  console.log('  ✓ created .env (with generated SECRETS_KEY) — add your API keys');
} else {
  console.log('  · .env already exists');
}

console.log('\n→ installing dependencies (pnpm install)');
run('pnpm install');

console.log('\n→ starting MySQL (docker compose up -d mysql)');
run('docker compose up -d mysql');

console.log('\n→ waiting for MySQL to be healthy…');
let healthy = false;
for (let i = 0; i < 45; i++) {
  const out = spawnSync(
    'docker',
    ['inspect', '--format', '{{.State.Health.Status}}', 'chapi-mysql'],
    { encoding: 'utf8' },
  );
  if ((out.stdout || '').trim() === 'healthy') { healthy = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(healthy ? '  ✓ MySQL healthy' : '  ! MySQL not healthy yet — check `docker logs chapi-mysql`');

console.log('\n→ applying database schema (prisma db push)');
run('pnpm --filter @chapi/server exec prisma db push', {
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://chapi:chapi@127.0.0.1:3307/chapi' },
});

console.log('\n✅ Setup complete. Start with:  pnpm dev   (web :3100, server :8123)');
console.log('   Then open http://localhost:3100 and add your Anthropic/OpenAI keys in Settings.');

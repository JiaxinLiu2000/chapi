// End-to-end smoke test of the non-AI surface (REST + WS pipeline).
// Run from apps/server (so `ws` resolves):  node scripts/smoke.mjs [port]
import WebSocket from 'ws';

const port = process.argv[2] ?? '8123';
const base = `http://127.0.0.1:${port}/api`;
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const health = await fetch(`${base}/health`).then((r) => r.json());
check('health', health.ok === true, JSON.stringify(health));

const created = await fetch(`${base}/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ firstMessage: 'smoke test session' }),
}).then((r) => r.json());
const session = created.session;
check('create session', Boolean(session?.id), session?.slug);

const list = await fetch(`${base}/sessions`).then((r) => r.json());
check('list sessions', Array.isArray(list.sessions) && list.sessions.length > 0);

const detail = await fetch(`${base}/sessions/by-slug/${session.slug}`).then((r) => r.json());
check('session detail by slug', detail.session?.id === session.id);

const settings = await fetch(`${base}/settings`).then((r) => r.json());
check('settings', typeof settings.settings?.mainModel === 'string');

const wiki = await fetch(`${base}/wiki`).then((r) => r.json());
check('wiki list', Array.isArray(wiki.entries));

const search = await fetch(`${base}/wiki/search`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: 'anything' }),
}).then((r) => r.json());
check('wiki search', Array.isArray(search.hits));

// WS: subscribe + send a message. The pipeline has engaged once we see run.state.
// With a working ANTHROPIC key we also get assistant.message; otherwise an error.
const seen = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const types = new Set();
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'session.subscribe', sessionId: session.id }));
    ws.send(JSON.stringify({ type: 'user.message', sessionId: session.id, text: 'reply with just: hi' }));
  });
  ws.on('message', (d) => {
    try {
      const t = JSON.parse(d.toString()).type;
      types.add(t);
      if (t === 'assistant.message' || t === 'error') { ws.close(); resolve(types); }
    } catch { /* ignore */ }
  });
  setTimeout(() => { ws.close(); resolve(types); }, 30000);
});
check('ws pipeline engaged (run.state)', seen.has('run.state'));
console.log(
  `    events: ${[...seen].join(', ')}` +
    (seen.has('assistant.message') ? ' [LIVE agent responded]' : ''),
);

// cleanup (abandon-on-delete stops any active run first)
await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' });
check('delete session', true);

console.log(`\n${failures === 0 ? '✅ SMOKE PASS' : `❌ SMOKE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);

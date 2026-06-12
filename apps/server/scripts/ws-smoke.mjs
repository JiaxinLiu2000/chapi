// Dev smoke test for the WebSocket gateway.
// Usage: node scripts/ws-smoke.mjs <sessionId> [port]
import WebSocket from 'ws';

const sessionId = process.argv[2];
const port = process.argv[3] ?? '8123';
if (!sessionId) {
  console.error('usage: node ws-smoke.mjs <sessionId> [port]');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
const seen = [];

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'session.subscribe', sessionId }));
  ws.send(JSON.stringify({ type: 'user.message', sessionId, text: 'hello from smoke test' }));
});

ws.on('message', (data) => {
  const ev = JSON.parse(data.toString());
  seen.push(ev.type);
  console.log('EVENT', ev.type, ev.type === 'assistant.message' ? `(text len ${ev.message.text.length})` : '');
});

setTimeout(() => {
  console.log('---');
  console.log('event types seen:', seen.join(', ') || '(none)');
  const ok = seen.includes('run.state') && seen.includes('assistant.message');
  console.log(ok ? 'WS SMOKE: PASS' : 'WS SMOKE: FAIL');
  ws.close();
  process.exit(ok ? 0 : 1);
}, 2500);

// End-to-end driver for the workflow engine against a running test backend.
// Usage: node scripts/wf-e2e.mjs [port] "first message" [timeoutMin]
// Logs tool calls, workflow run updates, plan, approvals; auto-answers questions
// with "按默认继续" and approves the final delivery. Exits when the run is done
// and an approval arrived, or on timeout.
import WebSocket from 'ws';

const port = process.argv[2] ?? '8125';
const text = process.argv[3] ?? '按演示 SOP 跑一遍，运行标签写 E2E';
const timeoutMin = Number(process.argv[4] ?? 20);
const base = `http://127.0.0.1:${port}/api`;

// optional 5th arg: reuse an existing session id (to chain several runs in one conversation)
const session = process.argv[5]
  ? { id: process.argv[5], slug: '(reused)' }
  : (
      await (
        await fetch(`${base}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'workflow e2e', qualityReviewMinutes: 0, effort: 'medium' }),
        })
      ).json()
    ).session;
console.log('SESSION', session.id, session.slug);

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`;
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let runDone = false;
let approved = false;
let lastRunLine = '';

const finish = (code) => {
  console.log(`END code=${code} runDone=${runDone} approved=${approved}`);
  ws.close();
  process.exit(code);
};

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'session.subscribe', sessionId: session.id }));
  ws.send(JSON.stringify({ type: 'user.message', sessionId: session.id, text }));
});

ws.on('message', (data) => {
  const e = JSON.parse(data.toString());
  switch (e.type) {
    case 'tool.started': {
      const tc = e.toolCall;
      const who = tc.agentRunId ? 'sub ' : 'MAIN';
      if (/workflow_|^Task$|^Agent$|request_approval|set_plan|update_plan_step|ask_user/.test(tc.toolName))
        console.log(ts(), who, 'TOOL', tc.toolName, tc.inputPreview.replace(/\s+/g, ' ').slice(0, 160));
      break;
    }
    case 'tool.finished': {
      const tc = e.toolCall;
      if (tc && /workflow_|^Task$|^Agent$|request_approval/.test(tc.toolName))
        console.log(ts(), '     RESULT', tc.toolName, tc.status, (tc.outputPreview ?? '').replace(/\s+/g, ' ').slice(0, 220));
      break;
    }
    case 'workflow.run.updated': {
      const r = e.run;
      const line = `${r.status} cursor=${r.cursor?.nodeId ?? '-'} token=${r.pendingToken ?? '-'} | ${r.nodeRuns.map((n) => `${n.nodeId}:${n.status}${n.attempts > 1 ? `x${n.attempts}` : ''}`).join(' ')}`;
      if (line !== lastRunLine) console.log(ts(), 'RUN ', line);
      lastRunLine = line;
      if (r.status === 'done') runDone = true;
      break;
    }
    case 'question.open':
      console.log(ts(), 'QUESTION', e.question.question.slice(0, 200));
      ws.send(JSON.stringify({ type: 'answer.question', sessionId: session.id, questionId: e.question.id, answer: '按默认继续' }));
      break;
    case 'approval.request':
      console.log(ts(), 'APPROVAL', e.approval.summary.replace(/\s+/g, ' ').slice(0, 300));
      approved = true;
      ws.send(JSON.stringify({ type: 'approval.decision', sessionId: session.id, approvalId: e.approval.id, decision: 'approve' }));
      if (runDone) setTimeout(() => finish(0), 3000);
      break;
    case 'assistant.message':
      if (e.message.text?.trim()) console.log(ts(), 'SAY ', e.message.text.replace(/\s+/g, ' ').slice(0, 200));
      break;
    case 'error':
      console.log(ts(), 'ERROR', e.message);
      break;
  }
});

setTimeout(() => finish(runDone && approved ? 0 : 1), timeoutMin * 60_000);

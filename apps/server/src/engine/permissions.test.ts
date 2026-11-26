import { describe, expect, it } from 'vitest';
import { buildCanUseTool, isChiefOutboundTool, looksLikeBoardMutation, looksLikeSlackWrite, looksLikeWorkflowConfirm } from './permissions.js';

const c = (n: string) => `mcp__chief__${n}`;

describe('looksLikeWorkflowConfirm', () => {
  it('flags shell / script calls that confirm a SOP', () => {
    expect(looksLikeWorkflowConfirm('Bash', { command: 'curl -X POST $CHAPI_SERVER_URL/api/workflows/bi-sop/confirm' })).toBe(true);
    expect(looksLikeWorkflowConfirm('PowerShell', { command: 'Invoke-RestMethod -Method Post http://127.0.0.1:8123/api/workflows/x/confirm' })).toBe(true);
    expect(looksLikeWorkflowConfirm('Write', { file_path: 'a.py', content: 'prisma.workflow.update({ data: { status: "confirmed", confirmedVersion: 2 } })' })).toBe(true);
    expect(looksLikeWorkflowConfirm('Bash', { command: 'mysql -e "UPDATE Workflow SET status=\'confirmed\'"' })).toBe(true);
    // forging the user's click on the in-chat confirm card
    expect(looksLikeWorkflowConfirm('Write', { file_path: 'ws.js', content: "ws.send(JSON.stringify({ type: 'approval.decision', decision: 'approve' }))" })).toBe(true);
  });

  it('leaves ordinary calls alone', () => {
    expect(looksLikeWorkflowConfirm('Bash', { command: 'curl $CHAPI_SERVER_URL/api/workflows' })).toBe(false);
    expect(looksLikeWorkflowConfirm('Bash', { command: 'echo "please confirm with the user"' })).toBe(false);
    expect(looksLikeWorkflowConfirm('Read', { file_path: '/x/workflows/confirm.md' })).toBe(false);
  });
});

describe('isChiefOutboundTool', () => {
  it.each([
    'approve_and_send',
    'approveOutreach',
    'send_email',
    'reply_to_thread',
    'inbox-reply',
    'send_calendar_invite',
    'create_invite',
    'book_meeting',
    'schedule_meeting',
    'bulk_approve',
  ])('blocks %s', (n) => expect(isChiefOutboundTool(c(n))).toBe(true));

  it.each(['list_leads', 'get_outreach', 'list_meetings', 'search_inbox', 'get_pipeline', 'list_sent'])(
    'allows read tool %s',
    (n) => expect(isChiefOutboundTool(c(n))).toBe(false),
  );

  it('blocks a generic tool whose action field sends', () => {
    expect(isChiefOutboundTool(c('run_action'), { action: 'approve_send' })).toBe(true);
    expect(isChiefOutboundTool(c('outreach'), { op: 'reply' })).toBe(true);
  });

  it('blocks writes that move a draft to a delivered state, not reads filtered by it', () => {
    expect(isChiefOutboundTool(c('update_outreach'), { status: 'approved' })).toBe(true);
    expect(isChiefOutboundTool(c('list_outreach'), { status: 'sent' })).toBe(false);
    expect(isChiefOutboundTool(c('update_outreach'), { status: 'draft' })).toBe(false);
  });

  it('ignores non-chief tools', () => {
    expect(isChiefOutboundTool('mcp__google_workspace__create_event')).toBe(false);
  });
});

describe('buildCanUseTool chief guard', () => {
  it('denies chief outbound even on the vscode (full-access) profile', async () => {
    const can = buildCanUseTool('test-session', 'vscode');
    const r = await can(c('approve_and_send'), {}, { signal: new AbortController().signal } as never);
    expect(r?.behavior).toBe('deny');
    const ok = await can(c('list_leads'), {}, { signal: new AbortController().signal } as never);
    expect(ok?.behavior).toBe('allow');
  });
});

describe('buildCanUseTool workflow-confirm guard', () => {
  it('denies the agent confirming a SOP from its shell, on every profile', async () => {
    for (const profile of ['web', 'vscode'] as const) {
      const can = buildCanUseTool('test-session', profile);
      const r = await can('Bash', { command: 'curl -X POST $CHAPI_SERVER_URL/api/workflows/demo-draft/confirm' }, { signal: new AbortController().signal } as never);
      expect(r?.behavior).toBe('deny');
      if (r?.behavior === 'deny') expect(r.message).toContain('用户');
    }
  });
});

describe('looksLikeBoardMutation', () => {
  it.each([
    ['Bash', { command: 'curl -X POST $CHAPI_SERVER_URL/api/board/automations -d "{}"' }],
    ['Bash', { command: 'curl -s -XPATCH http://127.0.0.1:8123/api/board/automations/abc -H "Origin: http://127.0.0.1:3100" --data \'{"mode":"auto"}\'' }],
    ['Bash', { command: 'curl --request DELETE http://127.0.0.1:8123/api/board/automations/abc' }],
    ['Bash', { command: 'curl http://127.0.0.1:8123/api/board/automations/abc/run -d ""' }],
    ['PowerShell', { command: 'Invoke-RestMethod -Method Patch -Uri http://127.0.0.1:8123/api/sessions/s1/project -Body $b' }],
    ['Write', { file_path: 'a.py', content: 'requests.post(f"{base}/api/board/automations/{id}/run")' }],
    ['Write', { file_path: 'a.js', content: "await fetch(`${u}/api/board/projects/p1/merge`, { method: 'POST' })" }],
    ['Write', { file_path: 'a.ts', content: 'await prisma.automation.update({ where: { id }, data: { mode: "auto" } })' }],
    ['Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'prisma.automationRun.deleteMany({})' }],
    ['Write', { file_path: 'a.ts', content: 'prisma.project.create({ data: { name } })' }],
    ['Bash', { command: 'mysql -e "UPDATE Automation SET mode=\'auto\'"' }],
    ['Bash', { command: 'mysql -e "insert into `AutomationRun` (id) values (1)"' }],
    ['Bash', { command: 'mysql -e "DELETE FROM `Project` WHERE 1"' }],
    ['Bash', { command: 'mysql -e "UPDATE Session SET projectId=NULL"' }],
    // reviewer probe: write cases
    ['Bash', { command: "wget --post-data '{}' http://127.0.0.1:8123/api/board/automations/a/run" }],
    ['Bash', { command: 'wget --method=DELETE http://127.0.0.1:8123/api/board/automations/a' }],
    ['Bash', { command: 'curl -X POST http://127.0.0.1:8123/api/sessions/abc/project -d x' }],
    ['PowerShell', { command: 'Invoke-RestMethod -Method:Post http://127.0.0.1:8123/api/board/automations/a/run' }],
    ['PowerShell', { command: "irm -method 'delete' http://127.0.0.1:8123/api/board/automations/a" }],
    ['Bash', { command: 'curl -XPOST http://127.0.0.1:8123/api/board/automations/a/run' }],
    ['Bash', { command: 'curl -X POST \\\n  http://127.0.0.1:8123/api/board/automations/a/run' }],
    // re-review: URL in a variable / on another line than the write
    ['PowerShell', { command: '$u = "http://127.0.0.1:8123/api/board/automations/a/run"\nInvoke-RestMethod -Method Post -Uri $u' }],
    ['Bash', { command: 'U=$CHAPI_SERVER_URL/api/board/automations/a/run; curl -X POST $U' }],
    ['Bash', { command: "python - <<'EOF'\nimport requests\nu = \"http://127.0.0.1:8123/api/board/automations/a/run\"\nrequests.post(u)\nEOF" }],
    ['Bash', { command: 'B=http://127.0.0.1:8123/api/board/automations/a; curl -d "{}" $B' }],
    // a write marker anywhere with a board URL anywhere → conservative block
    ['Bash', { command: 'curl -s http://127.0.0.1:8123/api/board/today; curl -X POST https://example.com/hook -d x' }],
    // combined short flags
    ['Bash', { command: 'curl -sX POST http://127.0.0.1:8123/api/board/automations/a/run' }],
    ['Bash', { command: 'curl -sSXPATCH http://127.0.0.1:8123/api/board/automations/a' }],
    ['Bash', { command: "curl -sd '{}' http://127.0.0.1:8123/api/board/automations" }],
    // SQL table names are case-insensitive on Windows MySQL (lower_case_table_names=1)
    ['Bash', { command: 'mysql -e "update automation set mode=\'auto\'"' }],
    ['Bash', { command: 'mysql -e "delete from automationrun where 1"' }],
    ['Bash', { command: 'mysql -e "INSERT INTO `automationRun` (id) VALUES (1)"' }],
    ['Bash', { command: 'curl -s http://127.0.0.1:8123/api/board/today && curl -X PATCH http://127.0.0.1:8123/api/board/automations/a -d "{}"' }],
    ['Write', { file_path: 'x.ts', content: 'prisma.automation.update ({})' }],
    ['Write', { file_path: 'x.ts', content: 'db.automation.update({})' }],
    ['Write', { file_path: 'x.ts', content: 'await tx.project.delete({ where: { id } })' }],
    ['Write', { file_path: 'x.sql', content: 'INSERT INTO `Project` (id, name) VALUES (1, 2);' }],
    ['MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'prisma.automationRun.create({})' }] }],
    ['MultiEdit', { file_path: 'a.sh', edits: [{ old_string: 'a', new_string: 'curl -X DELETE $CHAPI_SERVER_URL/api/board/automations/x' }] }],
  ])('blocks %s %j', (tool, input) => expect(looksLikeBoardMutation(tool, input)).toBe(true));

  it.each([
    ['Bash', { command: 'curl $CHAPI_SERVER_URL/api/board/automations' }],
    ['Bash', { command: 'curl -s http://127.0.0.1:8123/api/board/today | jq .' }],
    ['PowerShell', { command: 'Invoke-RestMethod -Method Get http://127.0.0.1:8123/api/board/projects' }],
    ['Write', { file_path: 'r.ts', content: 'const rows = await prisma.automation.findMany({ include: { runs: true } })' }],
    ['Bash', { command: 'mysql -e "SELECT * FROM AutomationRun"' }],
    ['Write', { file_path: 'notes.md', content: 'Update project tracker and delete from the list' }],
    ['Read', { file_path: '/x/api/board/automations' }],
    ['mcp__chapi__automation_upsert', { name: 'x' }],
    // reviewer probe: reads that must stay allowed
    ['Bash', { command: 'curl -f $CHAPI_SERVER_URL/api/board/today' }],
    ['Bash', { command: 'curl -sf http://127.0.0.1:8123/api/board/automations | jq .' }],
    ['Bash', { command: "curl -s http://127.0.0.1:8123/api/board/today | cut -d ' ' -f1" }],
    ['Bash', { command: 'curl -s "http://127.0.0.1:8123/api/board/today?d=$(date -d yesterday +%F)"' }],
    ['Bash', { command: 'curl -D - http://127.0.0.1:8123/api/board/today' }],
    ['Bash', { command: "curl -s http://127.0.0.1:8123/api/board/automations | awk -F ',' '{print $1}'" }],
    ['Bash', { command: "curl -s http://127.0.0.1:8123/api/board/automations | grep -F 'EOD'" }],
    ['Bash', { command: 'curl -X GET http://127.0.0.1:8123/api/board/today' }],
    ['Bash', { command: 'U=http://127.0.0.1:8123/api/board/today; curl -s $U | jq .' }],
    ['Bash', { command: 'curl -sS http://127.0.0.1:8123/api/board/automations -o /tmp/a.json' }],
    ['Bash', { command: 'mysql -e "SELECT * FROM Automation; update project_tracker set x=1"' }],
    ['Bash', { command: 'psql -c "UPDATE project SET name=1"' }],
    ['Bash', { command: "git commit -m 'update project settings'" }],
    ['Bash', { command: "python -c \"c.execute('delete from project where id=1')\"" }],
    ['MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'prisma.automation.findMany()' }] }],
  ])('allows %s %j', (tool, input) => expect(looksLikeBoardMutation(tool, input)).toBe(false));

  it('canUseTool denies it on every profile with a Chinese hint to the automation tools', async () => {
    for (const profile of ['web', 'vscode'] as const) {
      const can = buildCanUseTool('test-session', profile);
      const r = await can('Bash', { command: 'curl -X PATCH $CHAPI_SERVER_URL/api/board/automations/a1 -d "{}"' }, { signal: new AbortController().signal } as never);
      expect(r?.behavior).toBe('deny');
      if (r?.behavior === 'deny') expect(r.message).toContain('automation_');
    }
  });
});

describe('looksLikeSlackWrite', () => {
  it.each([
    ['Bash', { command: "python -c \"page.evaluate('fetch(\'/api/chat.postMessage\')')\"" }],
    ['Write', { file_path: 'x.py', content: 's.call("reactions.add", name="x")' }],
    ['Bash', { command: 'curl https://slack.com/api/conversations.mark' }],
    ['Edit', { file_path: 'x.py', old_string: 'a', new_string: 'files.completeUploadExternal' }],
    ['mcp__slack__slack_post_message', {}],
    ['mcp__claude_ai_Slack__send_message', {}],
  ])('blocks %s', (tool, input) => expect(looksLikeSlackWrite(tool, input)).toBe(true));

  it.each([
    ['Bash', { command: 'uv run --with playwright python chapi_slack.py export --since 2026-11-07 --until 2026-11-13' }],
    ['Write', { file_path: 'r.py', content: 's.call("conversations.history", channel=c)' }],
    ['Bash', { command: 'echo "we chat.  Update later"' }],
    ['mcp__slack__slack_get_channel_history', {}],
    ['Read', { file_path: 'chat.postMessage.md' }],
  ])('allows %s', (tool, input) => expect(looksLikeSlackWrite(tool, input)).toBe(false));
});

import path from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionProfile } from '@chapi/shared';
import { config, sessionPaths } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('permissions');

/** Tools that write to the filesystem; their target path must be inside allowed dirs. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Returns true if `child` is the same as or inside `parent`. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function looksLikeGmailSend(toolName: string): boolean {
  const n = toolName.toLowerCase();
  // Block anything that delivers mail (send / forward / reply), not just "send".
  const delivers = n.includes('send') || n.includes('forward') || n.includes('reply');
  return delivers && (n.includes('gmail') || n.includes('mail') || n.includes('message'));
}

/**
 * Slack is read-only for chapi (read via the sandbox's chapi_slack.py whitelist;
 * chapi_browser also aborts Slack write requests in the browser). As defense in
 * depth, refuse scripts/commands that name a Slack Web API write method.
 */
const SLACK_WRITE_METHOD_RE =
  /\b(?:chat\.(?:postMessage|postEphemeral|update|delete|meMessage|scheduleMessage|deleteScheduledMessage|command|unfurl)|reactions\.(?:add|remove)|files\.(?:upload|delete|share|completeUploadExternal|getUploadURLExternal|sharedPublicURL)|conversations\.(?:mark|join|leave|invite|kick|archive|unarchive|create|rename|setTopic|setPurpose|open|close)|(?:pins|stars)\.(?:add|remove)|reminders\.add|drafts\.(?:create|update|delete)|bookmarks\.(?:add|edit|remove)|users\.(?:setPresence|profile\.set))\b/;
const SLACK_WRITE_WORDS = new Set([
  'post', 'send', 'reply', 'update', 'edit', 'delete', 'add', 'remove', 'create', 'set', 'upload',
  'invite', 'join', 'leave', 'kick', 'archive', 'mark', 'react', 'reaction', 'schedule', 'pin', 'star', 'share',
]);
const SLACK_SCRIPT_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'PowerShell']);

export function looksLikeSlackWrite(toolName: string, input: Record<string, unknown> = {}): boolean {
  // Any Slack MCP tool (none today): refuse write-style tool names.
  if (toolName.toLowerCase().includes('slack') && words(toolName.split('__').pop() ?? '').some((w) => SLACK_WRITE_WORDS.has(w))) {
    return true;
  }
  if (!SLACK_SCRIPT_TOOLS.has(toolName)) return false;
  return SLACK_WRITE_METHOD_RE.test(JSON.stringify(input));
}

/**
 * The Chief MCP (mcp__chief__*): anything that reaches a real customer is off —
 * approving/sending outreach, replying to inbox threads, calendar invites/bookings.
 * Matched on name words (snake/camel/kebab split), plus action-like input fields
 * so a generic "run_action {action:'send'}" style tool can't slip through.
 */
const CHIEF_PREFIX = 'mcp__chief__';
/** Verbs that deliver something to a customer (in a tool name or an action field). */
const CHIEF_OUTBOUND_WORDS = new Set([
  'send', 'sends', 'resend', 'approve', 'approves', 'approval', 'approvals',
  'reply', 'replies', 'respond', 'responds', 'forward', 'dispatch', 'deliver',
  'invite', 'invites', 'invitation', 'invitations', 'rsvp',
  'book', 'booking', 'schedule', 'reschedule',
  'launch', 'enroll', 'enrol', 'publish', 'push', 'execute', 'blast',
]);
/** Target states that imply delivery, when a write tool sets status/stage. */
const CHIEF_OUTBOUND_STATES = new Set(['sent', 'approved', 'replied', 'scheduled', 'booked', 'invited', 'queued']);
const CHIEF_WRITE_WORDS = new Set(['update', 'set', 'change', 'mark', 'move', 'create', 'patch', 'edit', 'transition']);
/** Exact Chief tool names known to be outbound (also removed from context). */
export const CHIEF_BLOCKED_TOOLS: string[] = [];
const ACTION_KEYS = ['action', 'op', 'operation', 'method', 'command', 'intent'];
const STATE_KEYS = ['status', 'state', 'stage', 'type'];

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isChiefOutboundTool(toolName: string, input: Record<string, unknown> = {}): boolean {
  if (!toolName.startsWith(CHIEF_PREFIX)) return false;
  const name = toolName.slice(CHIEF_PREFIX.length);
  if (CHIEF_BLOCKED_TOOLS.includes(toolName)) return true;
  const nameWords = words(name);
  if (nameWords.some((w) => CHIEF_OUTBOUND_WORDS.has(w))) return true;
  const fieldHas = (keys: string[], set: Set<string>) =>
    keys.some((k) => {
      const v = input[k];
      return typeof v === 'string' && words(v).some((w) => set.has(w));
    });
  if (fieldHas(ACTION_KEYS, CHIEF_OUTBOUND_WORDS)) return true;
  // e.g. update_outreach {status:'approved'} — but list_outreach {status:'sent'} is a read.
  const isWrite = nameWords.some((w) => CHIEF_WRITE_WORDS.has(w));
  return isWrite && fieldHas(STATE_KEYS, new Set([...CHIEF_OUTBOUND_STATES, ...CHIEF_OUTBOUND_WORDS]));
}

/**
 * Only the user confirms an SOP (web UI). Refuse agent shell commands / scripts
 * that would hit the confirm endpoint or flip a workflow to confirmed in the DB.
 */
const WORKFLOW_CONFIRM_TOOLS = new Set(['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const WORKFLOW_CONFIRM_RE =
  /\/workflows\/[^\s"'`/]+\/confirm\b|approval\.decision|confirmedVersion|\bupdate\s+`?workflow(?:version)?`?\s+set\b|prisma\.workflow(?:Version)?\.(?:update|updateMany|upsert)\b/i;

export function looksLikeWorkflowConfirm(toolName: string, input: Record<string, unknown> = {}): boolean {
  if (!WORKFLOW_CONFIRM_TOOLS.has(toolName)) return false;
  return WORKFLOW_CONFIRM_RE.test(JSON.stringify(input));
}

/**
 * The automation registry / project board is changed only through the chapi
 * automation tools (with their confirmation cards) or by the user in the web UI.
 * Refuse shell / script calls that hit the board write endpoints (any method other
 * than GET) or write the Automation / AutomationRun / Project tables directly.
 * Reads stay allowed.
 */
const BOARD_URL_RE = /\/api\/board\/|\/api\/sessions\/[^\s"'`/]+\/project\b/i;
/** Case-insensitive word inside an otherwise case-sensitive regex source. */
const ci = (w: string) => w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const METHOD = `(?:${['POST', 'PUT', 'PATCH', 'DELETE'].map(ci).join('|')})\\b`;
/**
 * Write markers of curl / wget / PowerShell. Short flags are case-sensitive
 * (curl -d/-F/-T write; -D/-f do not); PowerShell parameters and method names
 * are case-insensitive by nature.
 */
/** Unambiguous write markers: never something else in a pipeline (unlike cut -d / awk -F / grep -F). */
const STRONG_WRITE = [
  // -X with a write method, also inside combined short flags (-sX POST, -XPOST, -sSXPATCH)
  `(?:^|\\s)-[a-zA-Z]{0,4}X\\s*['"]?${METHOD}`,
  `--request[\\s=]+['"]?${METHOD}`,
  `(?:^|\\s)--data(?:-raw|-binary|-urlencode|-ascii)?(?=[\\s=]|$)`,
  `(?:^|\\s)--json(?=[\\s=]|$)`,
  `(?:^|\\s)--form(?:-string)?(?=[\\s=])`,
  `(?:^|\\s)--upload-file(?=[\\s=])`,
  `--(?:post|body)-(?:data|file)(?=[\\s=])`,
  `--method[\\s=]+['"]?${METHOD}`,
  `(?:^|\\s)-${ci('Method')}[:\\s]+['"]?${METHOD}`,
  `(?:^|\\s)-${ci('Body')}\\b`,
];
/**
 * Write markers of curl / wget / PowerShell. Short flags are case-sensitive
 * (curl -d/-F/-T write; -D/-f do not); PowerShell parameters and method names
 * are case-insensitive by nature. The short ones are only trusted next to the URL.
 */
const SHELL_WRITE_RE = new RegExp(
  [
    ...STRONG_WRITE,
    `(?:^|\\s)-[a-zA-Z]{0,4}d(?=[\\s'"@={]|$)`, // -d, -sd (not -method: too long)
    `(?:^|\\s)-F(?=[\\s'"@])`,
    `(?:^|\\s)-T(?=[\\s=])`,
  ].join('|'),
);
/** Write markers in code (fetch / requests / axios …). */
const CODE_WRITE_RE = new RegExp(`${ci('method')}\\s*[:=]\\s*['"\`]${METHOD}|\\.(?:post|put|patch|delete)\\s*\\(`);
const STRONG_WRITE_RE = new RegExp([...STRONG_WRITE, CODE_WRITE_RE.source].join('|'));
/** The board URL assigned to a variable (sh U=…, PowerShell $u = "…", python u = "…"). */
const URL_ASSIGN_RE = /=\s*["']?[^"'\s]*(?:\/api\/board\/|\/api\/sessions\/[^\s"'`/]+\/project\b)/i;
/**
 * Direct writes to the chapi board tables (Prisma models, or SQL). Automation /
 * AutomationRun match in any case (Windows MySQL lower_case_table_names=1); Project
 * only backticked with a capital P, so unrelated `project` tables aren't blocked.
 */
const TABLE = `(?:\`?(?:${ci('AutomationRun')}|${ci('Automation')})\`?|\`Project\`)`;
const BOARD_DB_RE = new RegExp(
  [
    '\\b(?:prisma|tx|db)\\.(?:automationRun|automation)\\s*\\.\\s*(?:createMany|create|updateMany|update|upsert|deleteMany|delete)\\b',
    '\\b(?:prisma|tx)\\.project\\s*\\.\\s*(?:createMany|create|updateMany|update|upsert|deleteMany|delete)\\b',
    `\\b${ci('insert')}\\s+(?:${ci('ignore')}\\s+)?${ci('into')}\\s+${TABLE}(?=[\\s(;"']|$)`,
    `\\b${ci('update')}\\s+${TABLE}\\s+${ci('set')}\\b`,
    `\\b${ci('delete')}\\s+${ci('from')}\\s+${TABLE}(?=[\\s;"']|$)`,
    `\\b${ci('update')}\\s+\`?Session\`?\\s+${ci('set')}\\b[^;]*\\bprojectId\\b`,
  ].join('|'),
);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Every string in the input, nested ones included (MultiEdit edits[]). */
function inputStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) inputStrings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) inputStrings(x, out);
  return out;
}

export function looksLikeBoardMutation(toolName: string, input: Record<string, unknown> = {}): boolean {
  if (!WORKFLOW_CONFIRM_TOOLS.has(toolName)) return false;
  const s = inputStrings(input).join('\n');
  if (BOARD_DB_RE.test(s)) return true;
  if (!BOARD_URL_RE.test(s)) return false;
  // Code files: a request call may span lines (fetch(url, {\n method: 'POST' })).
  if (FILE_TOOLS.has(toolName) && CODE_WRITE_RE.test(s)) return true;
  // An unambiguous write anywhere in the same input as a board URL (the URL may sit in a
  // variable or on another line: $u = "…"; Invoke-RestMethod -Method Post -Uri $u).
  if (STRONG_WRITE_RE.test(s)) return true;
  // The URL is assigned to a variable: any write flag anywhere may use it (U=…; curl -d x $U).
  if (URL_ASSIGN_RE.test(s) && (SHELL_WRITE_RE.test(s) || CODE_WRITE_RE.test(s))) return true;
  // Only the pipeline / ; / && / || segment holding the board URL counts, with
  // $(…) substitutions removed (`cut -d`, `awk -F`, `date -d` elsewhere are not writes).
  return s
    .replace(/[\\`]\r?\n/g, ' ') // line continuations (sh \, PowerShell `)
    .replace(/\$\([^()]*\)/g, ' ')
    .split(/\r?\n|&&|\|\||[|;]/)
    .some((seg) => BOARD_URL_RE.test(seg) && (SHELL_WRITE_RE.test(seg) || CODE_WRITE_RE.test(seg)));
}

/**
 * Build the per-session permission callback.
 * - `vscode` profile: full access.
 * - `web` profile: file writes confined to the session sandbox + memory; Gmail
 *   send hard-blocked (defense in depth alongside disallowedTools).
 */
export function buildCanUseTool(
  sessionId: string,
  profile: PermissionProfile,
): CanUseTool {
  const sp = sessionPaths(sessionId);
  const writableRoots = [sp.sandbox, sp.memory];

  return async (toolName, input) => {
    // Gmail send is never allowed, regardless of profile.
    if (looksLikeGmailSend(toolName)) {
      log.warn(`blocked gmail-send-like tool: ${toolName}`);
      return {
        behavior: 'deny',
        message: 'Sending/forwarding/replying email is disabled. Create a draft instead.',
      };
    }

    // Slack is read-only, regardless of profile.
    if (looksLikeSlackWrite(toolName, input)) {
      log.warn(`blocked slack-write-like tool call: ${toolName}`);
      return {
        behavior: 'deny',
        message:
          'chapi 对 Slack 只读：发消息、编辑、删除、表情、上传、标为已读、加入或离开频道等写操作都已禁用。' +
          '读取请用沙盘里的 chapi_slack.py（login / check / export / search）；需要在 Slack 发的内容整理好交给用户自己发。',
      };
    }

    // SOPs are confirmed by the user only.
    if (looksLikeWorkflowConfirm(toolName, input)) {
      log.warn(`blocked workflow-confirm-like tool call: ${toolName}`);
      return {
        behavior: 'deny',
        message: 'SOP 只能由用户在 chapi 页面上确认。你可以起草或修改草稿，然后请用户去页面上点"确认"。',
      };
    }

    // Automation registry / board: only via the automation tools (or the user in the UI).
    if (looksLikeBoardMutation(toolName, input)) {
      log.warn(`blocked board-mutation-like tool call: ${toolName}`);
      return {
        behavior: 'deny',
        message:
          '自动化面板（定时任务、运行记录、项目归类）不能用命令行、脚本或直接改数据库来改。' +
          '请用 automation_list / automation_upsert / automation_link_history / automation_set_mode / automation_delete / automation_run_now 这些工具；' +
          '切到自动、删除、立即运行会在对话里请用户确认。项目归类请让用户在 /board 页面上操作。读取不受限制。',
      };
    }

    // The Chief: outbound actions (approve+send, reply, invites) never allowed.
    if (isChiefOutboundTool(toolName, input)) {
      log.warn(`blocked chief outbound tool: ${toolName}`);
      return {
        behavior: 'deny',
        message:
          'The Chief 里会直接发给客户的操作（批准并发送邮件、回复客户、发日历邀请/预约等）已禁用。' +
          '只能读取数据；需要发出的内容请整理好交给用户在 The Chief 里自己操作。',
      };
    }

    if (profile === 'vscode') {
      return { behavior: 'allow', updatedInput: input };
    }

    // web profile: restrict file-writing tools to the session's private dirs.
    if (FILE_WRITE_TOOLS.has(toolName)) {
      const target = (input.file_path ?? input.path ?? input.notebook_path) as
        | string
        | undefined;
      if (typeof target === 'string') {
        const abs = path.isAbsolute(target) ? target : path.resolve(sp.sandbox, target);
        const allowed = writableRoots.some((root) => isInside(abs, root));
        if (!allowed) {
          return {
            behavior: 'deny',
            message:
              `Web sessions may only write inside the session sandbox (${sp.sandbox}) ` +
              `or memory (${sp.memory}). Refused path: ${abs}`,
          };
        }
      }
    }

    return { behavior: 'allow', updatedInput: input };
  };
}

/** Tool names disallowed entirely for a profile (removed from the model's context). */
export function disallowedToolsFor(profile: PermissionProfile): string[] {
  if (profile === 'vscode') return [...CHIEF_BLOCKED_TOOLS];
  // Defense in depth: remove known Gmail send tools from context entirely.
  // canUseTool also blocks any send-like tool name at call time.
  return [
    'mcp__google_workspace__send_gmail_message',
    'mcp__google_workspace__send_message',
    'mcp__google_workspace__reply_to_gmail_message',
    'mcp__google_workspace__forward_gmail_message',
    'mcp__gmail__send_gmail_message',
    'mcp__gmail__send_message',
    'mcp__gmail__reply_to_gmail_message',
    'mcp__gmail__forward_gmail_message',
    ...CHIEF_BLOCKED_TOOLS,
  ];
}

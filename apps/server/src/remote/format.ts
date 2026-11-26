/**
 * Pure (no I/O, no LLM) helpers for the WeChat bridge: reply parsing fast paths,
 * commands, and phone-friendly text shaping. Kept separate so they're unit-tested.
 */

/** Full-width digits / punctuation → ASCII, trimmed. */
export function normalizeReply(text: string): string {
  return text
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[，、；]/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "2" / "选2" / "第2个" / "2." / "1,3" / "1 3" → 0-based option indexes.
 * Returns null unless the WHOLE reply is just a choice (anything extra → not a fast path).
 */
export function parseOptionPick(text: string, optionCount: number): number[] | null {
  const t = normalizeReply(text).replace(/^(选|选择|第|回复?|答)\s*/, '').replace(/(个|项|号|\.|。)$/, '');
  if (!/^\d+(\s*[, ]\s*\d+)*$/.test(t)) return null;
  const picks = [...new Set(t.split(/[, ]+/).map((n) => parseInt(n, 10) - 1))];
  if (picks.some((i) => Number.isNaN(i) || i < 0 || i >= optionCount)) return null;
  return picks;
}

const APPROVE_RE = /^(1|批准|通过|同意|可以|好的?|ok|okay|行|没问题|approve|yes|y|确认|就这样)[!！。.~]*$/i;
const REJECT_RE = /^(2|驳回|拒绝|不行|不要|不同意|否|reject|no|n)[!！。.~]*$/i;

export type ApprovalReply =
  | { decision: 'approve' }
  | { decision: 'reject' }
  | { decision: 'revise'; feedback: string };

/** Approval replies: a bare approve/reject word decides; anything else is revise-with-feedback. */
export function parseApprovalReply(text: string): ApprovalReply {
  const t = normalizeReply(text);
  if (APPROVE_RE.test(t)) return { decision: 'approve' };
  if (REJECT_RE.test(t)) return { decision: 'reject' };
  const m = /^(3|修改|改)\s*[:：,]?\s*([\s\S]*)$/.exec(t);
  const feedback = (m ? (m[2] ?? '') : t).trim();
  return { decision: 'revise', feedback: feedback || t };
}

export type Command =
  | { name: 'help' }
  | { name: 'list' }
  | { name: 'switch'; index: number }
  | { name: 'stop' }
  | { name: 'detail' }
  | { name: 'status' }
  | { name: 'disconnect' }
  | { name: 'new'; text: string }
  | { name: 'send' }
  | { name: 'settings' }
  | { name: 'preview'; text: string }
  | { name: 'search'; text: string }
  /** List / start SOP workflows (optionally a name to start directly). */
  | { name: 'workflow'; text: string }
  /** Workflow / task-flow progress. */
  | { name: 'progress' }
  | { name: 'quality' }
  | { name: 'archive' }
  | { name: 'browser' }
  /** The board's "today" columns (running / waiting on you / done). */
  | { name: 'today' }
  /** Board projects (in a thread: also move this task to another project). */
  | { name: 'projects' }
  /** Board automations (optionally a name to open its card). */
  | { name: 'automations'; text: string }
  | { name: 'unknown'; raw: string };

/** Slash commands (Chinese or English). Returns null for a normal message. */
export function parseCommand(text: string): Command | null {
  const t = normalizeReply(text);
  if (!/^[/／!！]/.test(t)) return null;
  const body = t.slice(1).trim();
  const [head = '', ...rest] = body.split(' ');
  const arg = rest.join(' ').trim();
  switch (head.toLowerCase()) {
    case '帮助':
    case 'help':
    case '?':
    case '？':
      return { name: 'help' };
    case '列表':
    case 'list':
    case 'ls':
      return { name: 'list' };
    case '切':
    case '切换':
    case 'switch':
    case 'sw': {
      const n = parseInt(arg, 10);
      return Number.isFinite(n) && n > 0 ? { name: 'switch', index: n } : { name: 'unknown', raw: t };
    }
    case '停':
    case '停止':
    case 'stop':
      return { name: 'stop' };
    case '详细':
    case '原文':
    case 'detail':
    case 'more':
      return { name: 'detail' };
    case '状态':
    case 'status':
      return { name: 'status' };
    case '断开':
    case 'disconnect':
      return { name: 'disconnect' };
    case '设置':
    case '配置':
    case 'settings':
    case 'config':
      return { name: 'settings' };
    case '预览':
    case '看':
    case 'preview':
    case 'pv':
      return { name: 'preview', text: arg };
    case '找':
    case '搜':
    case '搜索':
    case 'search':
    case 'find':
      return arg ? { name: 'search', text: arg } : { name: 'unknown', raw: t };
    case '历史':
    case 'history':
      return { name: 'list' };
    case '新':
    case '新建':
    case 'new':
      return arg ? { name: 'new', text: arg } : { name: 'unknown', raw: t };
    case '发':
    case 'send':
      return { name: 'send' };
    case '流程':
    case '工作流':
    case 'sop':
    case 'workflow':
    case 'wf':
      return { name: 'workflow', text: arg };
    case '进度':
    case '流程图':
    case 'progress':
      return { name: 'progress' };
    case '质检':
    case 'qa':
    case 'review':
      return { name: 'quality' };
    case '归档':
    case 'archive':
      return { name: 'archive' };
    case '浏览器':
    case '截图':
    case 'browser':
    case 'shot':
      return { name: 'browser' };
    case '今天':
    case '今日':
    case '看板':
    case 'today':
    case 'board':
    case 'kanban':
      return { name: 'today' };
    case '项目':
    case 'project':
    case 'projects':
      return { name: 'projects' };
    case '自动化':
    case '定时':
    case '定时任务':
    case 'auto':
    case 'automation':
    case 'automations':
      return { name: 'automations', text: arg };
    default: {
      // "/切2" without a space
      const m = /^(切|切换)(\d+)$/.exec(head);
      if (m) return { name: 'switch', index: parseInt(m[2]!, 10) };
      return { name: 'unknown', raw: t };
    }
  }
}

export const HELP_TEXT = [
  'chapi 微信指令：',
  '/列表  看已连接的对话',
  '/切 N  切到第 N 个对话',
  '/状态  当前对话在做什么',
  '/停    中断当前运行',
  '/详细  上一条推送的完整版',
  '/新 内容  新建一个对话并开始',
  '/断开  不再推送当前对话',
  '其他文字/语音 = 直接发给当前对话；长按引用某条推送再回复 = 发给那个对话。',
].join('\n');

/** Markdown → plain text that reads well in a WeChat bubble. */
export function toPlainText(md: string): string {
  return md
    .replace(/```[a-z]*\n([\s\S]*?)```/gi, (_m, code: string) => code.trim())
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 $2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} ${url}`))
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '· ')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, '')
    .replace(/^\|(.*)\|\s*$/gm, (_m, row: string) => row.split('|').map((c) => c.trim()).join(' · '))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split long text into WeChat-sized chunks, preferring paragraph/line breaks. */
export function chunkText(text: string, max = 1500): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Spreadsheet-style labels: A..Z, AA, AB… */
export function tagForIndex(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Messages that look like feedback on the push format itself (cheap pre-filter before the LLM). */
export const STYLE_FEEDBACK_RE =
  /(太长|太短|啰嗦|罗嗦|废话|简短|简洁|精简|详细点|详细一点|多说点|字太多|看不懂|只要结论|别推|不用推|少推|少发|别发|不要发|推送|格式)/;

/** Short label for a question/approval/completion push header. */
export function pushHeader(tag: string, title: string, multi: boolean): string {
  if (!multi) return '';
  const t = title.length > 14 ? `${title.slice(0, 14)}…` : title;
  return `[${tag}·${t}] `;
}

/**
 * Discord renders most Markdown but not tables (and headings are huge on a phone):
 * keep bold/lists/links, turn tables into "a · b" lines and headings into bold.
 */
export function discordSafe(md: string): string {
  return md
    .replace(/^\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, '')
    .replace(/^\|(.*)\|[ \t]*$/gm, (_m, row: string) => row.split('|').map((c) => c.trim()).join(' · '))
    .replace(/^#{1,6}[ \t]*(.+)$/gm, '**$1**')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

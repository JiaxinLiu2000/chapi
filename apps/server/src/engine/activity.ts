/**
 * Hard-coded detection of what an agent is doing from a tool call, producing a
 * short category tag + a human-friendly one-line label for the monitoring card.
 * Notably distinguishes Anthropic's built-in WebSearch from cloakbrowser browsing.
 */
export interface ToolActivity {
  tag: string;
  label: string;
}

function basename(p?: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  return p.split(/[\\/]/).pop() || p;
}

function trunc(v: unknown, n = 56): string {
  const s = String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function describeActivity(toolName: string, input: unknown): ToolActivity {
  const i = (input ?? {}) as Record<string, unknown>;

  // cloakbrowser via Playwright MCP
  if (toolName.startsWith('mcp__browser__') || toolName.startsWith('mcp__playwright__')) {
    const action = toolName.split('__').pop() ?? 'browser';
    const verbs: Record<string, string> = {
      browser_navigate: '打开',
      browser_navigate_back: '后退',
      browser_click: '点击',
      browser_type: '输入',
      browser_press_key: '按键',
      browser_snapshot: '读取页面',
      browser_take_screenshot: '截图',
      browser_select_option: '选择',
      browser_hover: '悬停',
      browser_wait_for: '等待',
      browser_tabs: '切换标签',
      browser_file_upload: '上传文件',
      browser_evaluate: '执行脚本',
      browser_fill_form: '填写表单',
    };
    const verb = verbs[action] ?? action.replace(/^browser_/, '');
    const detail = i.url ? trunc(i.url, 48) : i.text ? trunc(i.text, 36) : trunc(i.element, 36);
    return { tag: '浏览器', label: `浏览器(cloakbrowser) · ${verb}${detail ? `: ${detail}` : ''}` };
  }

  if (toolName.startsWith('mcp__google_workspace__')) {
    const action = toolName.replace('mcp__google_workspace__', '').replace(/_/g, ' ');
    return { tag: 'Google', label: `Google Workspace: ${action}` };
  }
  if (toolName.startsWith('mcp__canva__')) return { tag: 'Canva', label: 'Canva 设计/导出' };
  if (toolName.startsWith('mcp__context7__')) return { tag: '查文档', label: '查阅库/框架官方文档' };

  switch (toolName) {
    // in-process chapi tools
    case 'mcp__chapi__ask_user':
      return { tag: '提问', label: '向用户提问，等待回答' };
    case 'mcp__chapi__request_approval':
      return { tag: '审批', label: `提交成果审批${i.summary ? `: ${trunc(i.summary, 36)}` : ''}` };
    case 'mcp__chapi__notify_user':
      return { tag: '通知', label: trunc(i.title ?? '通知用户', 40) };
    case 'mcp__chapi__save_artifact':
      return { tag: '交付', label: `登记交付物${i.title ? `: ${trunc(i.title, 36)}` : ''}` };
    case 'mcp__chapi__wiki_search':
      return { tag: '查Wiki', label: `检索 AI Wiki: ${trunc(i.query, 40)}` };
    case 'mcp__chapi__wiki_write':
      return { tag: '写Wiki', label: `沉淀 Wiki: ${trunc(i.title, 40)}` };
    case 'mcp__chapi__pdf_edit':
      return { tag: 'PDF', label: `编辑 PDF (${trunc(i.op ?? '操作', 16)})${i.input ? `: ${basename(i.input)}` : ''}` };

    // built-in tools
    case 'Read':
      return { tag: '读取', label: `读取文件: ${basename(i.file_path)}` };
    case 'Write':
      return { tag: '写入', label: `写入文件: ${basename(i.file_path)}` };
    case 'Edit':
    case 'MultiEdit':
      return { tag: '编辑', label: `编辑文件: ${basename(i.file_path)}` };
    case 'NotebookEdit':
      return { tag: '编辑', label: `编辑笔记本: ${basename(i.notebook_path)}` };
    case 'Bash': {
      const cmd = String(i.command ?? '');
      // A script driving the shared cloakbrowser over CDP → tag as browser so the
      // live panel auto-opens and the user can watch it run.
      if (/chapi_browser|connect_over_cdp|cloakbrowser|playwright/i.test(cmd)) {
        return { tag: '浏览器', label: `浏览器(cloakbrowser) · 运行脚本: ${trunc(cmd, 40)}` };
      }
      return { tag: '命令', label: `运行命令: ${trunc(cmd, 48)}` };
    }
    case 'Grep':
      return { tag: '检索', label: `检索代码: ${trunc(i.pattern, 40)}` };
    case 'Glob':
      return { tag: '查找', label: `查找文件: ${trunc(i.pattern, 40)}` };
    case 'LS':
      return { tag: '列目录', label: '列出目录' };
    case 'TodoWrite':
      return { tag: '规划', label: '更新任务清单' };
    case 'Task':
      return { tag: '子任务', label: `派发子代理${i.description ? `: ${trunc(i.description, 40)}` : ''}` };
    case 'WebSearch':
      return { tag: '联网搜索', label: `联网搜索(Anthropic): ${trunc(i.query, 44)}` };
    case 'WebFetch':
      return { tag: '抓取网页', label: `抓取网页: ${trunc(i.url, 48)}` };
    case 'ToolSearch':
      return { tag: '找工具', label: '检索可用工具' };
    default:
      return { tag: '工具', label: trunc(toolName, 40) };
  }
}

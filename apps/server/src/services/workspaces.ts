import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('workspaces');

const RAW_INDEX = `# 原始资料 (Raw Materials) — 共享 · 只读

存放与用户工作内容相关的原始资料，**所有会话/代理共享**。

规则：
- **只读参考，禁止修改**（agent 不得在此写入或编辑）。
- 用户在对话中上传的文件落在 \`uploads/<sessionId>/\` 下。
- 收到重要资料时，应判断是否将要点用 \`wiki_write\` 总结进 AI Wiki（务必带来源路径）。
`;

const SKILLS_INDEX = `# 技能 (Skills) — 共享 · 工具用法目录

告诉 AI **有哪些工具/CLI/API、何时使用、如何使用、失败如何回退**。
遇到不熟悉或报错时：先查这里，再用 context7 / WebFetch 读官方文档。

可用能力（详见各子目录 / 内置工具）：
- **HITL**：\`ask_user\`（提问等待）、\`request_approval\`（成果审批）、\`notify_user\`、\`save_artifact\`。
- **知识**：\`wiki_search\`（规划前先查）、\`wiki_write\`（沉淀经验，带来源）。
- **网页**：用沙盘里的 \`chapi_browser\` 助手写脚本驱动 cloakbrowser（\`from chapi_browser import open_page\`/\`connect\`，over CDP，复用反检测内核+持久化登录，只关自己开的页面；\`uv run --with playwright python …\`）。Playwright MCP 默认关闭。— 见 web-research/
- **PDF**：本地 PyMuPDF/pypdf 对现有模板替换文字为主；Canva 仅用于从头设计。— 见 pdf-edit/
- **Google Workspace**：Docs/Sheets/Drive 创建编辑；Gmail **仅草稿、禁止发送**；在 \`Chapi/<会话>/\` 命名空间下操作，勿动他人文件。— 见 google-workspace/

约定：文件类产物放会话沙盘；最终优先上传 Google Drive 并用 \`save_artifact\` 登记链接。
`;

const WIKI_INDEX = `# AI Wiki — 共享 · 可复用知识

在需要时学习并总结成 wiki（重要文件要点、可复用的网络资料、用户偏好、纠错后的真实需求、
成功任务的工作流与正确的表格/邮件格式）。通过 \`wiki_write\` 写入、\`wiki_search\` 检索。

要求：
- 每条知识**保留来源**（原始资料路径 / 网页 URL / 会话消息 id），以便验证。
- 可提供多个「问法/索引」，让不同提问都能命中同一答案。
- 标题相同则更新已有条目，保持准确与稳定。

条目正文以 Markdown 存于 \`entries/\`（由系统镜像写出，主索引在数据库 + 向量库）。
`;

async function writeIfMissing(file: string, content: string): Promise<void> {
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, content, 'utf8');
    log.info(`seeded ${path.relative(config.paths.repoRoot, file)}`);
  }
}

// Helper modules copied into every session sandbox so the agent's scripts can
// `import` them directly (cwd = sandbox). Kept fresh by copying on each run.
const SANDBOX_HELPERS = ['chapi_browser.py'];

/**
 * Copy the script helpers (e.g. chapi_browser.py — the CDP interface to the
 * running cloakbrowser) into a session sandbox. Overwrites so updates to the
 * source propagate. Idempotent + best-effort.
 */
export async function ensureSandboxHelpers(sandboxDir: string): Promise<void> {
  const srcDir = path.join(config.paths.repoRoot, 'tools', 'browser');
  await fs.mkdir(sandboxDir, { recursive: true }).catch(() => undefined);
  for (const name of SANDBOX_HELPERS) {
    try {
      await fs.copyFile(path.join(srcDir, name), path.join(sandboxDir, name));
    } catch (err) {
      log.warn(`failed to seed sandbox helper ${name}`, err);
    }
  }
}

/** Ensure the three shared workspaces have an INDEX.md describing their purpose & limits. */
export async function seedWorkspaces(): Promise<void> {
  await fs.mkdir(path.join(config.paths.aiWiki, 'entries'), { recursive: true });
  await writeIfMissing(path.join(config.paths.rawMaterials, 'INDEX.md'), RAW_INDEX);
  await writeIfMissing(path.join(config.paths.skills, 'INDEX.md'), SKILLS_INDEX);
  await writeIfMissing(path.join(config.paths.aiWiki, 'INDEX.md'), WIKI_INDEX);
}

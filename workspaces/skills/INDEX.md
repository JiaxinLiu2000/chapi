# 技能 (Skills) — 共享 · 工具用法目录

告诉 AI **有哪些工具/CLI/API、何时使用、如何使用、失败如何回退**。
遇到不熟悉或报错时：先查这里，再用 context7 / WebFetch 读官方文档。

可用能力（详见各子目录 / 内置工具）：
- **任务流**：`set_plan`（任何任务先建一个简单清单；状态 pending/in_progress/done/problem/failed/replaced/blocked；可清空重建）。
- **时间**：`get_current_time`（本工作流看重时间，随时取最新本地/UTC 时间）。
- **定时**：`schedule_task`（延时/定时执行，监控显示倒计时，**勿用 Bash sleep**）。— 见 scheduled-tasks/
- **批量**：批量/重复任务**先写脚本跑通再全量+抽查**，别逐条手动。— 见 batch-scripting/
- **并行**：互不依赖的耗时任务用 Task 子代理并行执行（上限见设置）。
- **HITL**：`ask_user`（提问等待）、`request_approval`（成果审批）、`notify_user`、`save_artifact`。
- **任务流**补充：推进中用 `update_plan_step` 改单个步骤（problem/failed/blocked/replaced 必须写 reason；换方案用 replacement）。学习代理靠它学习，`request_approval` 前必须全部收尾。
- **知识图谱**：`wiki_search`（相关知识点按权重/置信度排序，可按 kind 过滤）→ `wiki_read`（全文、来源、历史、双链）；`wiki_write` 只在明确值得记时手动记一个原子知识点（技能/偏好/数据）。平时由学习代理自动学习。Wiki 是 Obsidian 库（`workspaces/ai-wiki/entries/技能|偏好|数据/`），网页有知识图谱。
- **联网搜索**：cloakbrowser 里的 Google 拟人搜索 `google_search(page, q, pages=2)`（每个关键词 ≥2 页；`WebSearch` 只作补充）。关键数据 ≥3 个独立来源，用 `rate_sources` 算置信度并在交付中标注。— 见 web-research/
- **反爬侦察**：抓取任何网站前先 `site_recon(url)` 定等级 L0–L3：L0/L1 直接调 API/纯 HTTP（快、可并发），L2 浏览器，L3 浏览器+完整拟人；被拦截 `report="blocked"` 升级。— 见 web-research/
- **网页**：用沙盘里的 `chapi_browser` 助手写脚本驱动 cloakbrowser（`from chapi_browser import open_page`/`connect`，over CDP，复用反检测内核+持久化登录，只关自己开的页面；`uv run --with playwright python …`）。这是主要方式，Playwright MCP 默认关闭。— 见 web-research/ 与 batch-scripting/
- **PDF**：本地 PyMuPDF/pypdf 对现有模板替换文字为主；Canva 仅用于从头设计。— 见 pdf-edit/
- **邮箱验证**：`verify_email`（本地 AfterShip email-verifier：语法→MX→SMTP 握手，不发信；另测一次性/角色/免费邮箱与拼写；需用户在设置启用；`unknown` ≠ 无效）。— 见 email-verify/
- **学习材料**：讲解 ML/AI 概念与公式、cheatsheet、翻面卡、复习讲义、练习题——先问清考试/资料/形态，复用 `tools/` 里已验证的 KaTeX 翻面卡、Word 公式、Google Docs 公式转图流水线。— 见 study-materials/
- **Google Workspace**：Docs/Sheets/Drive 创建编辑；Gmail **仅草稿、禁止发送/转发/回复**（`draft_gmail_message`，extended 档）；Apps Script 自动化；在 `Chapi/<会话>/` 命名空间下操作，勿动他人文件。— 见 google-workspace/

- **Slack（只读）**：沙盘里的 `chapi_slack.py` 借 cloakbrowser 已登录的 Slack 读频道+私信（`check`/`login`/`export --since --until`/`search`）；**禁止任何写操作**（浏览器与权限层都会拦截）；聊天内容不进 Wiki。— 见 slack-readonly/

- **质检顾问指南**：`quality-advisor/GUIDE.md` 是质检顾问每次检查都会对照的规则清单（用户维护）；交付前质检退回时按条修正再提交。

约定：文件类产物放会话沙盘；最终优先上传 Google Drive 并用 `save_artifact` 登记链接。

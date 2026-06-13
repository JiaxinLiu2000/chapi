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
- **知识**：`wiki_search`（规划前先查）、`wiki_write`（沉淀经验，带来源）。
- **网页**：cloakbrowser + Playwright（Google 搜索 / 固定站点抓取，专用持久化登录）。— 见 web-research/
- **PDF**：本地 PyMuPDF/pypdf 对现有模板替换文字为主；Canva 仅用于从头设计。— 见 pdf-edit/
- **Google Workspace**：Docs/Sheets/Drive 创建编辑；Gmail **仅草稿、禁止发送/转发/回复**（`draft_gmail_message`，extended 档）；Apps Script 自动化；在 `Chapi/<会话>/` 命名空间下操作，勿动他人文件。— 见 google-workspace/

约定：文件类产物放会话沙盘；最终优先上传 Google Drive 并用 `save_artifact` 登记链接。

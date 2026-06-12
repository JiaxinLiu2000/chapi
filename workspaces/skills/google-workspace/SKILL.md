# 技能：Google Workspace（Docs / Sheets / Drive / Gmail 草稿 / Apps Script）

## 何时使用（**云端优先：文档/表格优先直接在这里创建，而不是先落沙盘**）
- 生成/编辑 Google Doc、Google Sheet（直接在云端创建，本就存于 Drive）。
- 把本地产物（如改好的 PDF）上传到 Google Drive 并取分享链接（**最终交付都用 Drive**）。
- 起草邮件 → **存为 Gmail 草稿**（`draft_gmail_message`）。
- 需要批量/自动化（如批处理表格、生成文档、定时逻辑）时，用 **Apps Script**。

## 如何使用
- 工具前缀：`mcp__google_workspace__*`（taylorwilsdon/google_workspace_mcp，运行在 `--tool-tier extended`）。
  例：创建/修改文档、`modify_sheet_values`、Drive 上传、`draft_gmail_message`。
- **Gmail 建草稿**：用 `mcp__google_workspace__draft_gmail_message`（属 extended 档；core 档没有，
  所以平台已用 extended 启动）。建好后把草稿信息回报用户，不要尝试发送。
- **Apps Script**（已启用 Apps Script API）：用 google_workspace 暴露的 script 类工具创建/更新/运行
  Apps Script 项目，做表格/文档的批量自动化。脚本里**同样禁止发送邮件**（只 `createDraft`，不 `send`）。
- **防冲突**：在 Drive 的专用文件夹 `Chapi/<会话slug>/` 下创建文件；文件名带会话/时间前缀；
  只新增或修改自己产出的文件，**绝不改动他人文件**。
- 交付：把最终文件链接用 `save_artifact`(kind=drive|sheet|doc) 登记，再 `request_approval`。

## 硬性红线
- **Gmail 只能创建草稿（draft），严禁发送/转发/回复发送邮件。** 平台在两层硬拦截
  （`looksLikeGmailSend` + 黑名单）拦掉 send/forward/reply 类工具，不要尝试绕过（包括用 Apps Script 发信）。

## 失败回退
- 首次需 OAuth 授权：若工具报未授权，提示用户在设置点「连接 Google（开始授权）」或在弹出的浏览器完成授权。
- 某 Gmail/脚本工具「未注册/找不到」：确认服务端以 `--tool-tier extended` 启动（draft/script 在 extended 档）。
- 工具用法/字段不清：用 context7/WebFetch 阅读 google_workspace_mcp 与 Google API 文档后重试。
- 启用前提：在设置中填好 Google OAuth Client ID/Secret（填了即自动启用），并已启用对应 Google API
  （Drive/Docs/Sheets/Gmail/Apps Script）。

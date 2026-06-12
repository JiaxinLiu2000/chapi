# 技能：Google Workspace（Docs / Sheets / Drive / Gmail 草稿）

## 何时使用（**云端优先：文档/表格优先直接在这里创建，而不是先落沙盘**）
- 生成/编辑 Google Doc、Google Sheet（直接在云端创建，本就存于 Drive）。
- 把本地产物（如改好的 PDF）上传到 Google Drive 并取分享链接（**最终交付都用 Drive**）。
- 起草邮件 → **存为 Gmail 草稿**。

## 如何使用
- 工具前缀：`mcp__google_workspace__*`（taylorwilsdon/google_workspace_mcp）。
  例：创建/修改文档、`modify_sheet_values`、Drive 上传、`draft_gmail_message`。
- **防冲突**：在 Drive 的专用文件夹 `Chapi/<会话slug>/` 下创建文件；文件名带会话/时间前缀；
  只新增或修改自己产出的文件，**绝不改动他人文件**。
- 交付：把最终文件链接用 `save_artifact`(kind=drive|sheet|doc) 登记，再 `request_approval`。

## 硬性红线
- **Gmail 只能创建草稿（draft），严禁发送邮件。** 发送类工具已被平台禁用/拦截，不要尝试绕过。

## 失败回退
- 首次需 OAuth 授权：若工具报未授权，调用 `ask_user` 请用户在弹出的浏览器完成 Google 授权。
- 工具用法/字段不清：阅读 google_workspace_mcp 文档（context7/WebFetch）后重试。
- 启用前提：服务端 `CHAPI_ENABLE_GOOGLE=1` 且在设置中填好 Google OAuth Client ID/Secret。

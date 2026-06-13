# 技能：网页搜索与抓取（cloakbrowser + Playwright MCP）

## 何时使用
- 需要在 Google / 互联网搜索信息。
- 需要从固定网站提取内容（表格、文章、价格等）。
- 需要登录态才能访问的页面（用持久化登录的受控浏览器）。

## 如何使用
- 工具前缀：`mcp__browser__*`（Playwright MCP，连接到 cloakbrowser 的 CDP 端点）。
  常用：`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_evaluate` 等。
- 登录：cloakbrowser 使用**专用持久化 profile**。若目标站点需要登录而当前未登录，调用 `ask_user`
  请用户在受控浏览器窗口完成一次登录（登录态会持久保存、后续复用）。
- 抓取的网页要点应：必要时用 `wiki_write` 沉淀（带 URL 来源），临时数据放会话 `memory/web-cache`。

## 批量/脚本化（反反爬）
- 大量/重复抓取改写脚本时，**脚本必须连到运行中的 cloakbrowser**（CDP `http://127.0.0.1:9222`，
  `connect_over_cdp` 后 `contexts[0].new_page()`），复用反检测内核 + 登录态；新页面会自动显示在实时浏览器。
- 不要用裸 `requests`/`httpx` 抓受保护站点（易被反爬）。详见 `batch-scripting` 技能。

## 失败回退
- 被风控/验证码：不要硬刚；调用 `ask_user` 说明情况、请用户协助或更换策略。
- 工具用法不清/报错：先用 `context7` 或 `WebFetch` 阅读 Playwright MCP 文档，再重试。
- 启用前提：服务端需开启 `CHAPI_ENABLE_BROWSER=1` 并运行 cloakserve（见 docs）。

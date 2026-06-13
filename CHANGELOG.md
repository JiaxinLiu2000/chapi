# Changelog

Version is the single source of truth in `packages/shared/src/version.ts` (`APP_VERSION`),
shown at the bottom of the web UI. **Convention: bump the PATCH (third) digit on every
code update, and use the same `vX.Y.Z` in the commit message.**

## v0.1.27

- 启动器去掉「路由已预热，首次打开会话将更快」这条日志（预热仍照常进行，只是不再打印）。

## v0.1.26

- **后台对话流通知**：当你切到别的对话流后，正在后台运行的会话（或等待中的定时任务）一旦
  **提问 / 待审批 / 完成或定时触发**，会在右下角弹出一条**可点击的提示**（同时触发桌面通知），
  点击即切换到该对话流。后台会话本就在服务端独立执行、定时器服务端触发，本次补齐了跨对话流的提示。
- 实现：新增 `session.attention` 全局事件（`isGlobalEvent`，下发到所有客户端）+ `emitAttention()`；
  `ask_user`/`request_approval`/`notify_user`/定时任务触发都会发出该事件；前端新增 `GlobalAlerts`
  监听器（仅对**非当前**会话弹提示，当前会话仍走原有内联提示），Toast 支持点击跳转。

## v0.1.25

- Batch scripts must drive the running **cloakbrowser over CDP** (connect_over_cdp
  http://127.0.0.1:9222 + new page) to reuse its anti-detection kernel + saved logins, instead
  of raw requests/httpx (which get anti-bot-blocked). The new page auto-appears in the live
  browser panel (auto-split) so the user can watch the script run. Updated system prompt +
  batch-scripting/web-research skills with a connect_over_cdp example.

## v0.1.24 — 工作流/提示/技能/监控/浏览器优化

- **任务流（set_plan）**：新增工具，任何任务都建一个可见任务流；状态扩展为
  done/in_progress/problem(黄)/failed(红❗)/replaced(划线)/blocked；可清空重建。系统提示要求"先建流"。
  监控图标按状态区分。**主代理副标题改为显示当前进行中的步骤**（而非首条消息）。
- **定时任务（schedule_task）**：延时执行会在监控显示一个"定时检查"代理 + **实时倒计时**，到点自动执行
  （不再用 Bash sleep）；服务端重启会重载未触发的定时器。
- **当前时间**：新增 `get_current_time` 工具，并在系统提示注入当前时间（本工作流看重时间）。
- **语言**：每会话语言（中文/English，默认中文）选择器（在 effort 右侧）；交流用所选语言，
  但表格/邮件/查资料默认英文（使用环境在美国）。
- **批量优先写脚本**：系统提示 + 新技能 batch-scripting（先跑通→写脚本→小批测试+抽查→全量→抽查验收）。
- **鼓励并行子代理**：互不依赖的耗时任务并行执行。
- **实时浏览器最多 2 页**：`maxBrowserPages` 设置（默认 2）；浏览器开第二个页面时自动**上下分屏**各显示一页
  （CDP 多 target 截屏）。
- 技能 INDEX 补充上述新工具与"何时用"。**已实测**：set_plan/get_current_time/语言切换在线生效。

## v0.1.23

- Resize: clamp the live-browser panel so it can no longer grow past the screen / squeeze the
  chat to nothing (reserves room for the monitor + a chat minimum; chat can shrink via min-w-0).
- Left monitor bar: the collapse/expand ‹ › chevrons are vertically centered, and the bar now
  animates its width (200ms) when collapsing/expanding.

## v0.1.22

- Fix "google_workspace 完全没连上": launch workspace-mcp with **--single-user** so it uses the
  cached OAuth credentials directly (without it, multi-user/session mapping left the agent
  session with no working Google tools). Verified the MCP starts and registers 91 tools incl.
  draft_gmail_message (send_gmail_message stays blocked).
- Log MCP connection status on session init (no longer false-alarms on the normal "pending").

## v0.1.21

- Left monitor bar is now **collapsible** (click the edge to collapse/expand; remembered in
  localStorage).
- **Draggable divider** between the chat and the live browser panel to adjust their proportions.
- Revert the separate sub-agent model selector — **main and sub-agent now use one model**
  (the single 模型 selector in the chat top bar; summaries/consolidation use it too).
- Rename the completion button to **归档**.
- Hide the **🌐 实时浏览器** toggle while the panel is open (the panel has its own close button);
  it reappears after closing.

## v0.1.20

- Enable **Gmail drafts**: launch `google_workspace_mcp` with `--tool-tier extended` (in both
  mcpRegistry and the OAuth probe) so `draft_gmail_message` is registered — `core` lacked it.
- Harden the never-send rule for the extended tier: `looksLikeGmailSend` now blocks
  **send/forward/reply** Gmail tools (not just "send"), and `forward_gmail_message` is added to the
  disallowed list. Drafting stays allowed.
- Skills: document Gmail drafts (extended tier) + Apps Script automation in the Google Workspace
  skill and the skills index.

## v0.1.19

- **Auto-open the 实时浏览器 panel** when the agent uses a browser tool: the server emits a
  `browser.show` signal on browser-tool use; the client opens the panel and starts the screencast.
- **Sub-agent model selector** added to the chat top bar (主模型 / 子模型 / 思考强度), per session.
  The sub-model is used for sub-tasks and the summary/consolidation LLM calls; switchable live.

## v0.1.18

- Launcher now **pre-warms the dev routes** (`/`, `/wiki`, `/s/[slug]`) in the background right
  after startup, so the first time you open a conversation it's already compiled (no ~14s wait).
  Verified: post-warm session-page requests respond in ~1.4s instead of ~14s.

## v0.1.17

- Add **隐藏浏览器窗口** toggle: runs cloakbrowser **headless** (no taskbar window) while it stays
  visible in the 实时浏览器 panel (CDP screencast works headless — verified 9222 reachable).
  Toggling relaunches the browser; log in with it unhidden, then hide for normal use.
- Remove the verbose "已在 cloakbrowser 窗口打开登录页…" prompt.

## v0.1.16

- **Fix: agents kept showing 运行中 after the AI finished** (because the page stayed open and the
  long-lived run never re-emitted idle). The run now settles on each turn: main agent → idle and
  sub-agents → done on `result`, and re-marks running on the next message. Verified in tests.
- Settings: add **清空 AI Wiki** button (with confirmation; deletes all entries + vectors).
- Settings: removed the debug cloakbrowser controls (log box + 刷新状态); merged
  start + login into one **启动浏览器并登录账号** button; friendlier help text.
- Settings: removed the 主代理/子代理模型 selectors — use the per-session model selector in the
  chat top bar instead.
- Moved the **出色完成** button to the right of the composer.

## v0.1.15

- **运行耗时 now ticks live** (every second) while the AI is actively running and **pauses**
  when idle or waiting on a user question/approval; re-anchors to the server's authoritative value.
- **Fix cloakbrowser ECONNREFUSED 127.0.0.1:9222.** The package has no `cloakserve` command
  (only `cloakbrowser` for binary management). The supervisor now launches a persistent, headed
  cloakbrowser via `tools/browser/serve.py` (`launch_persistent_context(..., args=["--remote-debugging-port=9222"])`).
  **Verified live: CDP on 9222 is reachable** (Chrome/146). Logs are captured and shown in Settings;
  enabling the toggle starts it immediately; login opens a tab in that same persistent browser.
- **Completion button moved left**, compact, side-by-side with the composer bottom, **with a
  confirmation dialog** (warns the session becomes read-only).
- **Settings shows "Google 已连接" persistently** once authorized (persisted flag), not only right
  after clicking connect.

## v0.1.14

- Fix duplicate "主代理" rows when opening a history conversation. Each run used to create a
  new `main` AgentRun row, and rows left `running` by a killed process were never closed —
  so history piled up multiple main agents (one with stale raw-JSON activity).
  - `ensureMainAgent` now reuses one `main` row across runs, drops duplicates, and closes
    agents stuck `running` from a previous process.
  - Loading a session reconciles agents: collapses duplicate `main` rows into one and, when no
    run is active, marks stale `running` agents as interrupted. Verified 2 → 1.

## v0.1.13

- Settings polish: "Google 已连接" now shows as a green badge (when connected); errors show in red.
- Added an `outline` Button variant with a visible border; the **连接 Google（开始授权）**,
  **打开浏览器登录账号并保存**, and **开启桌面通知** buttons now clearly look like buttons.

## v0.1.12

- Fix "Bad Request" on the **连接 Google（开始授权）** and **打开浏览器登录账号并保存** buttons:
  these are bodyless POSTs sent with `content-type: application/json`, which Fastify rejected
  (`FST_ERR_CTP_EMPTY_JSON_BODY`). The server now tolerates an empty JSON body (parses to `{}`).
  Verified both endpoints return 200; `/google/connect` reports connected when access works.

## v0.1.11

- Fix a console hydration warning caused by browser extensions injecting attributes onto
  `<body>` (e.g. `data-atm-ext-installed`): added `suppressHydrationWarning` to `<html>`/`<body>`
  in the root layout (the standard Next.js fix; not a code bug).

## v0.1.10

- Monitoring card overhaul:
  - Main agent shows a **simple task title** (the session task), not raw tool JSON.
  - Sub-agents get a **short task description** the moment they start (captured from the Task call).
  - **Hard-coded per-tool activity detection** → a colored **tag chip** + concise one-line label in
    each agent's status (read/edit/command/search/browser/Google/Wiki/PDF/ask/approve…).
  - **WebSearch (Anthropic)** and **cloakbrowser browsing** are labeled distinctly
    ("联网搜索(Anthropic)" vs "浏览器(cloakbrowser)").
  - Verified live: main agent title + tags 找工具 / 抓取网页 instead of JSON.
- Fix: footer version was stale (0.1.7); `APP_VERSION` now tracks releases again.

## v0.1.9

- **cloakbrowser integration (auto-managed)**: new "启用 cloakbrowser" setting; the platform
  auto-installs cloakbrowser via `uv` and runs `cloakserve` (persistent profile) on start.
- **Live browser view (left/right split)**: a "🌐 实时浏览器" toggle streams the agent's
  cloakbrowser screen into the session UI via CDP screencast (`browser.frame`/`browser.state`
  events). Verified the WS plumbing (connecting → connected/unavailable) end-to-end.
- **Login & save**: Settings button "打开浏览器登录账号并保存" launches a headful cloakbrowser
  with the persistent profile so you can sign into account-gated sites once; logins persist and
  are reused by the agent.
- Browser MCP (Playwright over CDP) now enabled by the setting instead of an env flag.
- `GET /api/browser/status`, `POST /api/browser/login` endpoints.

## v0.1.8

- Settings: add a **连接 Google（开始授权）** button that proactively starts Google Workspace
  OAuth from Settings (instead of waiting for the first agent task). It runs a tool-only probe
  through the google_workspace MCP and opens the returned consent URL in a new tab; reports
  already-connected when access works.

## v0.1.7

- Fix: Google Workspace now **auto-enables when OAuth credentials are set in Settings** —
  no separate `CHAPI_ENABLE_GOOGLE` env flag needed. This is why no OAuth consent popup
  appeared and the agent had no Google tools. The first Google tool call triggers consent.
- Fix: web tools failing ("harness-level permission error"). `allowedTools` was narrowed to
  only the 7 in-process tools, forcing WebSearch/WebFetch/Task/etc. through the permission
  path. Now built-in safe tools (Read/Grep/Glob/TodoWrite/Task/WebSearch/WebFetch) are
  pre-approved; writes + external MCP tools still go through canUseTool. **Verified live:**
  WebFetch on example.com returns "Example Domain".
- Add **max parallel sub-agents** setting (1–8, default 3), enforced via the system prompt
  and surfaced in Settings.
- UI: stop rendering empty message bubbles (tool-only/empty assistant turns).
- Resilience: vector search degrades to empty on a dimension mismatch instead of throwing.
- canUseTool now returns `updatedInput` on allow (correct SDK contract).

## v0.1.6

- Fix "Failed to fetch" when sending a message: CORS now reflects any origin (the server
  binds to loopback, so this is safe locally), fixing the case where the web is opened via a
  LAN URL (e.g. http://192.168.x.x:3100) or a non-default port. Verified the API returns 201
  with `access-control-allow-origin` echoing a LAN origin.
- The web now shows an actionable error ("无法连接后端 … 请确认后端已启动 pnpm start") instead of a
  bare "Failed to fetch" when the backend is unreachable.

## v0.1.5

- Fix: stale production `.next` cache (from `next build`) crashed `next dev` with
  "Cannot find module './NNN.js'". The launcher now detects a leftover production build
  (`.next/BUILD_ID`) and clears `apps/web/.next` before starting dev. Verified `/` and
  `/wiki` render 200 with a fresh cache.

## v0.1.4

- Settings: saved secret fields (OpenAI key, Google OAuth Client ID & Secret) now show a
  green **已保存** badge next to the label and the input shows only dots (masked), instead of
  text placeholders. Client ID is masked like the Secret.

## v0.1.3

- Settings: add a **Google account email** field (passed as `USER_GOOGLE_EMAIL` to the
  Google Workspace MCP so the agent operates as that account); seeded to
  `joannaliubus@gmail.com` in env defaults.
- Settings: **remove the Anthropic API Key field** — the engine uses this machine's
  Claude Code credentials.
- Settings: **main/sub-agent model are now dropdowns** (from `MODEL_OPTIONS`) instead of
  free-text inputs.

## v0.1.2

- Per-session **model and effort selectors** in the session UI (top config bar), with live
  switching: model changes apply immediately via `query.setModel()`; effort changes apply on
  the next message (run restarts with `resume` to preserve context). Both persist on the session.

## v0.1.1

- Cloud-first delivery: prefer generating documents/sheets directly in Google Workspace
  and designs/PDFs in Canva; the session sandbox is only a temporary/fallback workspace.
  Final results land on Google Drive (`save_artifact(kind=drive|doc|sheet)`).
- No Anthropic API key required: the engine uses this machine's Claude Code credentials,
  and the learning loop's one-shot calls were re-routed through the Agent SDK `query()`.
- One-click launcher (`pnpm start` / `start.cmd` / `start.sh`) starts MySQL + backend +
  frontend and tears all three down on Ctrl+C.
- Version shown at the bottom of every page.

## v0.1.0

- Initial full build (M1–M8): monorepo, shared protocol, MySQL+Prisma, Fastify REST +
  WebSocket gateway; Claude Agent SDK engine (streaming, resume, canUseTool permissions,
  interrupt, hook-based monitoring); Next.js frontend (chat, monitoring card, nav, wiki);
  HITL tools; 5 workspaces; OpenAI + LanceDB RAG/wiki; local PDF tool + gated external MCPs
  (cloakbrowser/Google/Canva/context7); learning loop; setup/smoke scripts.

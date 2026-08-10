# Changelog

Version is the single source of truth in `packages/shared/src/version.ts` (`APP_VERSION`),
shown at the bottom of the web UI. **Convention: bump the PATCH (third) digit on every
code update, and use the same `vX.Y.Z` in the commit message.**

## v0.1.43 — 主页也能带文件/图片开新任务

- **主页输入框支持附件**：回形针选择、**拖入整块输入区**（描边高亮 + "松手即可添加文件"）、
  **Cmd/Ctrl+V 直接粘贴截图**。图片显示缩略图，其他文件显示带类型图标的 chip（含大小）。
  只丢文件、不写字也能发起任务（标题取首个文件名）。
- **上传时机**：主页在会话创建后才存在 sessionId，所以附件先留在本地（`URL.createObjectURL` 出预览），
  按下发送时才 `建会话 → 上传 → 拼消息 → 跳转`。不产生空会话，后端无新增端点。
  上传失败会把刚建的空会话删掉并留在主页，附件还在，可直接重试。
- **会话页输入框同步升级**：与主页共用 `useAttachmentDraft` + `AttachmentTray`，同样支持拖拽/粘贴/缩略图。
  顺带修掉一个旧毛病——之前"选中即上传"，用户再点 ✕ 移除时文件已落盘且 `Attachment` 表留了孤儿记录；
  现在改为发送时才上传。
- **修复：同名文件互相覆盖**。上传落盘名原为 `Date.now()-文件名`，同一请求内多个同名文件若落在同一毫秒会
  生成相同路径，后者覆盖前者、而两条数据库记录都指向它。粘贴截图全叫 `image.png`，这条路从"极少触发"变成主路径，
  故加入 4 位随机串。
- **修复：中文文件名被抹平**。文件名清洗用的 `[^\w.\-]` 中 `\w` 只匹配 ASCII，`报价单.pdf` 会变成 `___.pdf`；
  改用 `\p{L}\p{N}` 保留各种文字。
- 客户端限额与服务端 multipart 对齐（单文件 100MB、单次 10 个），超限当场提示而不是传到一半失败。

## v0.1.42 — 修复"登录后手动访问任何网站都一直加载"

- **根因**：任务等待你登录时，代理的 Playwright(connect_over_cdp)会话仍控制着浏览器。connect_over_cdp
  会开启浏览器级 `Target.setAutoAttach(waitForDebuggerOnStart)`——**每个新标签/导航都会被冻结、等调试器恢复**。
  任务挂起等你登录期间，你手动打开的网站就一直卡在"加载中"。
- **修复**：
  - 每次 `connect()`/`open_page()` 收尾（断开前）都**关掉浏览器级 auto-attach**（`Target.setAutoAttach:false`），
    让浏览器恢复"可手动使用"，脚本结束后手动浏览不再被冻结。
  - 新增 **`open_login(url)`**：打开登录页 → **立即断开自动化并清 auto-attach** → 返回。配套流程写进技能/提示：
    需要用户登录时**先 `open_login` 放手，再 `ask_user` 等登录**，**绝不**用 open_page/connect 占着浏览器等。
- **恢复当前卡死**：设置里把「浏览器」关掉再打开（重启 cloakbrowser）即可；登录态(cookie)保留。

## v0.1.41 — connect() 收尾不再误关用户手动打开的标签

- `chapi_browser.connect()` 收尾时**只关本会话新开的标签**（之前会关掉所有多余标签），保留用户/既有标签——
  避免代理任务在你手动浏览时把你打开的页面（如 Google 登录页）误关。默认页仍回到空白以便闲置收起。

## v0.1.40 — 启动更耐受 Docker 冷启动（不再因连不上 DB 就退出）

- **问题**：刚"启动 Docker Desktop"后一键启动，容器内部 healthcheck 已 healthy，但 Docker/WSL2 的**宿主端口
  3307 转发**还没就绪，服务端连了 ~88s 仍 ECONNREFUSED，`waitForDb` 用尽 30 次重试后**致命退出**（整个后端挂掉）。
- **修复**：
  - `waitForDb` 改为**按时限重试**（默认最多 180s、每 1.5s 一次，期间每 10 次打一条等待日志），覆盖 Docker
    冷启动的端口转发延迟，不再过早放弃。
  - 一键启动器在"容器 healthy"之后，**再等宿主端口 3307 真正可 TCP 连接**（最多 90s）才做 schema push /
    启动后端——避免它们过早撞上 ECONNREFUSED。
- 注：日志里另一个 `chachapi`（端口 8787/5173、MySQL 3306）是**另一个项目**，其 `/api/interrupt` 报错与本项目无关
  （本项目早在 v0.1.12 已修复空 JSON body）。

## v0.1.39 — 历史记录下拉改版（可扩展到上百条）

- 历史下拉加**搜索框**（按标题过滤）+ **状态筛选**（全部/进行中/已归档，各带计数）。
- 列表按**时间分组**（今天/昨天/过去 7 天/过去 30 天/更早），上百条也好扫。
- 列表项更舒展：进行中显示蓝点、已归档显示对勾;**高亮当前所在对话**；悬停才出删除按钮。
- 下拉更宽（w-96）、sticky 头部（搜索+筛选不随滚动），最高 78vh 滚动。

## v0.1.38 — Wiki UI 改版（不再挤）

- Wiki 页改为**全宽**布局（不再 max-w-6xl 居中挤在中间），内容区更舒展。
- 侧栏：加**搜索框**（按标题/标签过滤）+ 条目计数；列表项改成**卡片**（更大间距、两行标题、时间 + 标签 chip、
  悬停/选中态）。
- 正文：更大标题、标签 chip + 更新时间、`leading-relaxed` 正文、来源区改为带边框的卡片。空态文案更新为「归档」。

## v0.1.37 — 归档/完成时不再误报"Operation aborted"

- **问题**：点击"归档"完成任务时弹出运行错误 `Operation aborted`。原因是归档会主动停止运行（abort
  SDK 子进程），而运行循环的 catch 把这个**有意的中止**也当成错误 emit 出来，给用户弹了错误提示。
- **修复**：`run.ts` 的 consume catch 里，若是**有意中止**（`abortController.signal.aborted` 或 AbortError/
  "...aborted" 消息）只记 debug、不再 emit error 事件。归档照常完成、学习复盘照常进行，只是不再误报。

## v0.1.36 — 实时浏览器：两个标签页都显示 + 闲置可靠收起

- **问题**：用两个标签页时实时浏览器从头到尾只显示一个。根因是 Chromium 只合成**前台**标签，Windows 上
  更会因 `CalculateNativeWinOcclusion` 把后台/被遮挡标签停掉合成，导致第二个标签的 screencast 不出帧。
- **修复（多管齐下）**：
  - `serve.py` 启动加 `--disable-features=CalculateNativeWinOcclusion`、`--disable-backgrounding-occluded-windows`、
    `--disable-renderer-backgrounding`、`--disable-background-timer-throttling`——让非前台标签也持续合成出帧。
  - `browserView.ts` 截屏去掉防抖延迟、轮询 6s→3s，**增量**接入新标签/关闭消失标签，且**每个 pane 独立接入**
    （一个失败不影响另一个）。只要有 ≥2 个活跃标签，就显示活跃的 2 个（上下分屏）。
  - `chapi_browser.connect()` 收尾**关掉多开的标签、默认页回到空白**——闲置后 activeTargets 归零 → 实时浏览器
    自动收起；单个标签变空闲则 2→1。

## v0.1.35 — 方案选型提示 + 秒级时间戳/超时纪律 + 修复第二个标签页无法导航

- **规划选型提示**：系统提示新增"方案选型"段，教 AI 按情况选最优：查信息先用内置 `WebSearch`（快/无反爬），
  批量/重复/结构化处理**写脚本**（省调用、稳定），互不依赖且**非浏览器**的活才用子代理并行，需对照两页时
  在一个连接里 `new_tab` 开第二个标签减少切换；总原则 WebSearch→脚本→浏览器脚本→手动逐级升级。
- **时间感知 + 超时纪律**：每轮对话（UserPromptSubmit hook）和每次工具返回（PostToolUse hook）都注入
  **秒级时间戳**，让 AI 留意时间流逝、及早发现卡住。提示强调：任何工具/脚本都设**合理超时**，简单操作
  十几秒无结果就怀疑卡住、果断中止重试，绝不无限干等。
- **修复"第二个标签页无法导航 / 监控看不到"**：cloakbrowser + CDP 下 `ctx.new_page()` 建的标签拿不到
  渲染进程，goto 永远卡在 commit（与并发无关，之前归因有误，已更正注释）。`new_tab()` 改为从已工作的页面
  用 **`window.open` 弹出浏览器原生标签**（过 cloak 反检测注入、分到渲染进程）+ `bring_to_front` 置前，
  并保留 `ctx.new_page()` 兜底。（实测：example.com 0.0s、bilibili 0.5s 打开；旧法 12s 超时/被关。）

## v0.1.34 — 子代理工作总结 + 并发浏览不再踩踏（单驱动锁 + 增量截屏）

- **子代理工作总结**：子代理结束后，在监控里保留一段**工作总结**（取其最后一条 assistant 消息，
  `SubagentStop.last_assistant_message`）。新增 `AgentRun.summary` 列 + DTO，监控卡片在子代理"已结束"时显示。
- **修复并发浏览踩踏**（实测 4 个报错：goto 超时 / connect_over_cdp 180s 卡死 / TargetClosedError）。根因是
  同一浏览器上有 3 个 CDP 客户端互相抢 target（截屏流 + 两个子代理的 connect_over_cdp）：
  - **截屏改增量 + 防抖**（`browserView.ts`）：不再"集合一变就全量拆了重连"，改为只对**新增** target 连接、
    对**消失**的单独关闭，不动未变的 pane；且新 target 需稳定一个轮询周期才接入，避开 agent 正在创建/导航
    的竞态窗口（消除 TargetClosedError 与 2→1 闪断）。
  - **跨进程 CDP 锁**（`chapi_browser.py`）：同一时刻只允许一个脚本驱动 cloakbrowser，第二个**自动排队**
    （崩溃残留锁按心跳超时夺取）。两个子代理各开网站仍可跑，但**串行**不再卡死握手。
  - **连接更稳健**：`connect_over_cdp` 超时从 180s 降到 30s + 有限重试。
- **同时浏览两个页面的正确姿势**：在**同一个脚本/连接**里用 `new_tab(ctx, url)` 多开第二个标签（最多 2，
  实时浏览器上下分屏）；不要派两个子代理各自连浏览器。提示词与 web-research/batch-scripting 技能同步更新。
  （澄清：之前"new_page 无法导航"是并发踩踏所致，单驱动下多标签正常。）

## v0.1.33 — "Claude 调用"实时计数（不再一直是 0）

- **问题**：v0.1.32 的"Claude 调用"只在每轮**结束**（`result`）时才 +1，所以任务进行中、或一轮被中断/
  DB 崩溃打断时，它一直显示 0（实测：某会话工具调用已 39 次，但 claudeCalls 仍为 0，因为那一轮没跑到 result）。
- **修复**：改为**每条 assistant 消息（一次 Claude Code 模型响应）实时 +1**，且**包含后台子代理**的响应——
  这正是"Claude Code 在后台被调用的次数"。计数随工作实时增长，不会卡在 0；从 `handleResult` 移除原先的
  回合末计数避免重复。

## v0.1.32 — 浏览器复用默认页修复 + 上传进沙盘 + 监控计数 + 闲置自动收起

- **修复"打不开浏览器/首次全超时"**：`chapi_browser` 改为**复用 cloakbrowser 已有的持久化页面
  `ctx.pages[0]`，不再 `new_page()`**——经 CDP 新开的页面无法导航（goto 卡到超时，连 example.com 都打不开）；
  复用默认页后秒开。新增 `active_page(ctx)`，`open_page()` 退出时把页面导回 `about:blank`。
- **拟人/反爬强化**：新增 `click_next(page)`（点"下一页"按钮，**别拼 `?page=2` 冷跳**）、`wait_for_any(...)`
  （等延迟/封装加载的搜索框，解决 `inputs: 0`）。小批测试改为"**跑几页、随机抽 ~5 条核对**"。
- **Windows 控制台编码**：脚本环境注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`，并把自检里的 `→`
  换成 ASCII，避免 cp1252 报错。
- **上传文件**：除存入原始资料外，**同时复制一份到当前会话沙盘 `uploads/`**；上传后在**下一条消息**
  自动附带各文件在沙盘的位置（输入框上方显示可移除的文件 chip），AI 可立即定位；支持一次多文件。
- **监控计数改版（实时）**：成本→**Claude 调用**次数；代理→**工具调用**次数；Token→**学习次数**（wiki_write）。
  新增 Session 列 `claudeCalls`/`toolCallCount`/`learnings`，随事件实时增长并持久化。
- **实时浏览器闲置自愈**：页面回到空白即视为闲置——两个窗口只剩一个活动时 **2→1 分屏**，**全部闲置则
  自动收起**实时浏览器面板（新增 `browser.hide` 事件）。

## v0.1.31 — 修复 cloakbrowser “死机”：崩溃-恢复死循环

- **根因（已实测定位）**：cloakbrowser 是指纹伪装 Chromium（C++ 层 patch WebGL/canvas）。在 apartments.com
  这类重度 WebGL/地图 + PerimeterX 站点上 GPU 进程会崩一次，Chromium 于是把 `Default/Preferences` 的
  `exit_type` 记为 `"Crashed"`，**下次启动自动恢复那个重度崩溃标签 + 弹恢复气泡 → 立刻又崩 → profile 永久卡死**
  （于是“连手动打开任何网页都死机”）。对照实验：用**全新 profile** 时（无论 headless 还是 headed、默认参数）
  apartments.com 都能正常加载不崩——证明是**用户 profile 的崩溃状态**所致，而非指纹补丁本身；普通 Chrome 用的是
  各自健康 profile，所以没事。
- **修复**：`serve.py` 每次启动前**自愈 profile**——把 `exit_type` 重置为 `Normal`、清掉会话/标签恢复数据
  （`Current/Last Session/Tabs`、`Sessions/`，**不动 cookie/登录态**），若检测到曾崩溃再清掉可能损坏的 GPU
  着色器缓存（`GrShaderCache`/`ShaderCache`/`GraphiteDawnCache`）。启动参数加 `--hide-crash-restore-bubble`
  `--disable-session-crashed-bubble` `--no-first-run`。
- 新增 `CLOAKBROWSER_EXTRA_ARGS` 环境变量：必要时可加 `--disable-gpu` 或 `--fingerprint-noise=false`
  作为重度站点的兜底稳定开关（一般用不到，自愈后默认参数即可）。
- **生效方式**：重启启动器（Ctrl+C 后重新运行）即可自愈当前已卡死的 profile。

## v0.1.30 — 浏览器“像真人一样”操作（防 Akamai 封锁 + 治卡顿）

- **问题**：上几版把浏览改成“快速脚本直驱”，导致机械化、冷链接直达详情页 → 触发 Akamai 等**行为反爬**封锁；
  而 Akamai 的挑战脚本把 cloakbrowser CPU 拖满 → 浏览器卡死/打不开页、CDP 反复掉线、supervisor 不停重启。
- **方案——拟人**：`chapi_browser.py` 新增一套拟人助手：`human_pause`（动作间随机停顿）、`human_goto`、
  `human_click`（滚动到可见→悬停→点击→停顿）、`human_scroll`、`human_mouse`、`human_type`、`warmup`（先暖身首页），
  以及异步版。规则贯穿系统提示 + web-research / batch-scripting 技能：① 始终经 cloakbrowser；② 动作间随机停顿、
  滚动、移动鼠标；③ **顺网站路径走**，先开首页/列表再**点进**详情，**绝不冷 goto 深层详情 URL**；④ 节流低并发，
  同一站点顺序慢走、不并发猛刷；⑤ 被封/验证码就**停手**别硬刚。**探索与脚本都适用。**
- **治卡顿**：实时浏览器截屏降负载（quality 55→45、1280×800→1100×720、everyNthFrame 2→4）、resync 间隔 3s→6s
  减少 teardown 抖动；连接/重连失败时清理半连接的 pane 并只记简短日志（不再刷满 stack trace）。

## v0.1.29 — 启动不再因数据库瞬时不可达而崩溃

- **问题**：服务端启动比 MySQL 接受连接早一瞬，supervisor 的 `ensureBrowserRunning()`（fire-and-forget）
  里 `getBrowserEnabled()` 命中 Prisma 抛 `PrismaClientInitializationError`，**未捕获的 rejection 直接让整个 server 进程退出**。
- **修复**：启动时先 `waitForDb()`（重试 `SELECT 1`，最多 30 次/每秒）直到数据库可用再继续；supervisor
  的启动检查加 catch（失败只记日志、可在设置重试）；并加 `unhandledRejection`/`uncaughtException`
  兜底——瞬时异步错误（DB 抖动、CDP 断开等）只记日志、**不再杀进程**，保证后台会话/定时任务存活。

## v0.1.28 — 浏览器改为脚本驱动 CDP（弃用易卡的 Playwright MCP）

- **问题**：Playwright MCP（`npx @playwright/mcp`）初始化常卡住（日志里 `browser=pending` 几十秒），
  导致 AI「打不开浏览器」；而 cloakbrowser 的 CDP 其实是通的。
- **方案**：新增沙盘助手 `chapi_browser.py`——AI 写脚本即可接管**正在运行的 cloakbrowser**
  （`from chapi_browser import open_page` / `connect` / 异步 `*_async`），over CDP 复用反检测内核 +
  持久化登录态，**只关自己开的页面、绝不关闭共享浏览器**（修复脚本误关浏览器导致后续打不开）。
  用 `uv run --with playwright python 脚本.py` 运行（connect_over_cdp 不需要 `playwright install`）。
- 助手会在建会话时 + 每次运行时自动拷进会话沙盘（老会话也能用）；服务端注入 `CHAPI_CDP_ENDPOINT`。
- **Playwright MCP 默认关闭**（`mcp__browser__*`），设 `CHAPI_ENABLE_BROWSER_MCP=1` 才挂载。
- 监控：检测到 Bash 跑浏览器脚本（chapi_browser/connect_over_cdp/playwright）即标「浏览器」并自动展开实时浏览器。
- 同步更新系统提示 + web-research / batch-scripting / INDEX 技能，统一改为脚本驱动 CDP。

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

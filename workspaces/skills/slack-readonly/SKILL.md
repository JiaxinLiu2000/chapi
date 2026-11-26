# 技能：Slack 只读（频道 + 私信）

> chapi 借用 cloakbrowser 里**用户本人**已登录的 Slack 网页会话读取 Tripalink 工作区（tripalinkworkspace.slack.com，UnitPulse BD 团队在其中）的聊天记录。
> **只读是硬性规定**：沙盘助手 `chapi_slack.py` 只放行读取接口白名单；`chapi_browser` 每次连接都会在浏览器里
> 中止 Slack 写请求；权限层也会拒绝出现 Slack 写接口名的脚本。

## 何时使用
- 写 UP BD Weekly Report 等汇报时，需要本周 Slack 里的客户进展、会议、hot leads、同事反馈。
- 用户问"Slack 里 X 说了什么 / 某客户最近在 Slack 里有什么进展"。

## 如何使用（都在会话沙盘里运行）
```bash
# 1) 查登录状态
uv run --with playwright python chapi_slack.py check
#    → NOT_LOGGED_IN：先 login（只打开登录页就放手），再 ask_user 请用户在实时浏览器里登录，然后再 check
uv run --with playwright python chapi_slack.py login

# 2) 导出时间段（PT 日期，含两端；默认频道+私有频道+群私信+私信，含消息串回复）
uv run --with playwright --with tzdata python chapi_slack.py export --since 2026-11-07 --until 2026-11-13 --out slack_week
#    → slack_week.md（按会话分组）+ slack_week.json（结构化）

# 3) 按需搜索（Slack 搜索语法）
uv run --with playwright python chapi_slack.py search "Copperline after:2026-11-06" --count 50
```
脚本里：`from chapi_slack import slack_reader` → `with slack_reader() as s: s.conversations(); s.history(id, oldest=, latest=); s.search(q)`。

## 规则
- **禁止任何写操作**：发/改/删消息、表情、上传、置顶、标为已读、加入/离开频道、草稿、提醒、改资料。
  需要在 Slack 发的内容，整理好交给用户自己发。
- 不在 Slack 网页界面里点按钮或打字；不自己从浏览器取令牌/cookie 另写请求；不改白名单。
- 读取不会把会话标为已读（走 API，不打开频道界面）。
- 聊天内容只用于当前任务，**不要写进 AI Wiki**；交付里引用时写清会话名和 PT 时间。
- 导出是浏览器单驱动操作（持有 CDP 锁），会话多时需要几分钟，别并行开别的浏览器任务。

## 用于周报（UP BD Weekly Report）
- 时间窗：与周报其他数据（GoTo、Workbook）用同一个统计周期，按 PT 日期；拿不准就问用户。
- **并入现有板块，不新增板块**，样式照旧：
  - Key contacts：仍以 sales 同事的 hot-lead 原话为准；Slack 里同事对同一客户的补充进展可并进对应条目，
    Slack 与 notes/Workbook 不一致时列出差异请用户确认。
  - 会议/约访、回复、下周计划等：Slack 里确认的会议、客户回复、内部决定补进对应板块。
- 只摘与 BD/客户/销售相关的内容，闲聊和个人事务不进周报。

## 失败回退
- `NOT_LOGGED_IN` / `invalid_auth`：会话过期 → `login` + `ask_user`。
- `ratelimited`：助手已自动按 Retry-After 退避；仍失败就缩小时间窗或类型（`--types public_channel,private_channel`）。
- 多个工作区：`--team unitpulse`。

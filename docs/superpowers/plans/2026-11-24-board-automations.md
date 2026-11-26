# chapi 看板 + 自动化登记表 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/board` 页面，分为「今天 / 项目 / 自动化」三个 tab，并在后端实现一套基于 SOP 引擎的定时与手动运行机制。

**Architecture:** 后端新增 `src/board/` 模块，内含四部分：纯函数调度计算（schedule.ts）、运行器（runner.ts，负责新建会话、启动 workflow、状态回写、排队）、定时器（cron.ts，负责 tick 和补跑）、归类与总结（classify.ts）。另有一个 board 路由，以及一个防抖后广播的全局事件 `board.changed`。前端新增 `/board` 页面，用 react-query 拉数据，收到 `board.changed` 后重新拉取。

**Tech Stack:** Fastify, Prisma(MySQL), vitest, Next.js App Router, @tanstack/react-query, Tailwind（`--c-*` 令牌）, lucide-react, `Intl.DateTimeFormat`（处理 PT 时区，不引入新依赖）。

**Spec:** `docs/superpowers/specs/2026-11-24-board-automations-design.md`

## Global Constraints

- 时区一律为 `America/Los_Angeles`，界面和计算都用 PT。
- 只有绑定了**已确认 SOP** 的任务才能设 `mode='auto'`。服务端要校验这一点，前端只是置灰。
- 每次运行都新建会话，标题为 `{任务名} · M/D`，language 为 `zh`。
- 同一个任务同一时间最多只能有一个 `running|queued` 实例。全局同时 `running` 的自动运行（trigger 为 cron/catchup）不超过 2 个；`waiting_user` 不占名额。
- 补跑只限 24 小时以内的错过，每个应运行时刻最多补跑一次。超过 24 小时的记一条 `skipped`，note 写「错过」。
- 前端颜色一律使用令牌，不硬编码；图标统一为 lucide，stroke 1.75；字体沿用全局字体；顶栏入口放在 Wiki 之前。
- 不修改其他页面的布局。
- 开发在 worktree `../chapi-kb`（分支 `feat/board`）进行，测试库用 3308 上的 `chapi_kb`。合入主目录前必须征得用户同意。

## Review Focus

1. **DST 切换日**（2027-03-14、2026-11-01）：daily 18:00 的任务，下一次运行时间仍然要落在 PT 18:00，不能偏一小时。→ Task 2 测试
2. **同一时刻双触发**：tick 和手动按钮同时触发，或者两次 tick 重叠，都只能生成一条 AutomationRun。→ Task 3 测试（靠任务级互斥加 DB 唯一键 `automationId+dueAt`）
3. **会话被删除时运行还没结束**：AutomationRun 要记为 failed，不能永远停在 running 占着名额。→ Task 3 测试
4. **SOP 被归档后 tick 到点**：不能启动，任务要改回手动并发出提醒。→ Task 4 测试
5. **超长项目名或会话标题**（≥80 字）、0 个会话的项目、200+ 会话的「未归类」：卡片不能撑破布局，长列表要能滚动。→ Task 7 的验证步骤要截图

---

### Task 0: Worktree 与测试库

**Files:** 无代码改动

- [ ] 执行 `git worktree add ../chapi-kb -b feat/board`。把主目录 `apps/` 和 `packages/` 的未提交状态逐文件复制进去（先去掉 `\r` 再比 md5，全量比对），提交 `sync: main working tree`，记下这个基线提交的 hash。
- [ ] 在 chapi-wx-mysql(3308) 上建库 `chapi_kb`，执行 `prisma db push`，并从正式库复制 Setting、Session、Message、MemorySummary、PlanTask、Workflow、WorkflowVersion 几张表（归类要用真实会话来测）。worktree 的 `.env` 指向 `chapi_kb`，后端端口 8126，web 端口 3104，`browser_enabled=false`。
- [ ] 验证：`pnpm --filter server test` 跑通现有测试，后端 `/api/health` 返回 ok。

### Task 1: 数据模型与共享 DTO

**Files:**
- Modify: `apps/server/prisma/schema.prisma`
- Modify: `packages/shared/src/domain.ts`、`packages/shared/src/events.ts`、`packages/shared/src/api.ts`
- Modify: `apps/server/src/mappers.ts`

**Interfaces — Produces:**
- Prisma：`Project`、`Automation`、`AutomationRun` 三个模型，字段见 spec 5.2，另外再加：
  - `Automation.inputs Json?`
  - `AutomationRun.dueAt DateTime?`，加 `@@unique([automationId, dueAt])`（手动运行的 dueAt 为 null，MySQL 允许多个 null）
  - `AutomationRun.status` 取值：`queued|running|waiting_user|done|failed|skipped|stale`
  - `Session.projectId String?`（relation 设 onDelete SetNull）、`Session.projectSource String @default("ai")`
- 共享类型：
  - `ScheduleSpec = { kind: 'daily'|'weekdays'|'weekly'|'biweekly'|'monthly'; time: string; weekdays?: number[]; anchorDate?: string; dayOfMonth?: number }`
  - `ProjectDTO { id, name, summary: string|null, summaryAt: string|null, sessionCount: number, lastActivityAt: string|null, sortOrder: number }`
  - `AutomationDTO { id, name, workflowSlug: string|null, workflowName: string|null, workflowConfirmed: boolean, prompt: string|null, schedule: ScheduleSpec, mode: 'manual'|'auto', enabled: boolean, model: string, effort: string, inputs: Record<string,string>|null, projectId: string|null, nextRunAt: string|null, lastRun: AutomationRunDTO|null, openRuns: AutomationRunDTO[] }`
  - `AutomationRunDTO { id, automationId, sessionId, sessionSlug, workflowRunId: string|null, workflowVersion: number|null, trigger: 'manual'|'cron'|'catchup', status, note: string|null, dueAt: string|null, startedAt: string, endedAt: string|null }`
  - `BoardTodayDTO { running: BoardSessionCard[]; waiting: BoardSessionCard[]; done: BoardSessionCard[] }`，其中 `BoardSessionCard { id, slug, title, projectName: string|null, state: RunState, progress: string|null, waitingKind: 'question'|'approval'|null, updatedAt, automationRunId: string|null, stale: boolean }`
  - 事件：`{ type: 'board.changed' }`，在 `isGlobalEvent` 里登记为全局事件。

- [ ] 改 schema，执行 `prisma db push` 和 `prisma generate`（先停掉 tsx watch 的子进程，Windows 上 Prisma 的 dll 会被锁住）。
- [ ] 加 DTO 和 mapper（`toProjectDTO`、`toAutomationDTO`、`toAutomationRunDTO`）。
- [ ] 验证：`pnpm -r typecheck` 通过。
- [ ] Commit `feat(board): schema + shared DTOs`

### Task 2: 调度纯函数

**Files:**
- Create: `apps/server/src/board/schedule.ts`
- Test: `apps/server/src/board/schedule.test.ts`

**Interfaces — Produces:**
- `nextDue(spec: ScheduleSpec, after: Date): Date`：严格晚于 `after` 的下一个应运行时刻
- `lastDue(spec: ScheduleSpec, atOrBefore: Date): Date | null`
- `renderInputs(tpl: Record<string,string> | null, now: Date): Record<string,string> | undefined`：替换 `{today}`→`YYYY-MM-DD`、`{MD}`→`M/D`、`{MDYY}`→`M/D/YY`、`{weekStart}`/`{weekEnd}`→本周一/本周日（都按 PT）
- `describeSchedule(spec: ScheduleSpec): string`，例如「每个工作日 18:00」「每两周 周三 09:00」

用 `Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',...})` 求 PT 的墙钟时间；从 PT 墙钟换算回 UTC 时，先猜一个偏移，再校正一次，这样能处理 DST。weekdays 用 0=周日…6=周六。biweekly 以 anchorDate 所在那一周为第 0 周，偶数周触发。monthly 的 dayOfMonth 超过当月天数时，取当月最后一天。

- [ ] **写失败测试**，覆盖以下用例：
  - `nextDue({kind:'daily',time:'18:00'}, 2026-11-24T10:00-08:00)` 返回 `2026-11-24T18:00-08:00`
  - 同一个 spec，`after` = `2027-03-13T19:00-08:00`，返回 `2027-03-14T18:00-07:00`（DST 那天）
  - `weekdays` 18:00，`after` = 周五 19:00 PT，返回下周一 18:00
  - `biweekly {weekdays:[3], anchorDate:'2026-11-18', time:'09:00'}`，`after` = 2026-11-19，返回 2026-12-02 09:00 PT
  - `monthly {dayOfMonth:31}`，在 2027-02 返回 2-28
  - `lastDue(daily 18:00, 2026-11-24T17:59 PT)` 返回 11-23 18:00 PT
  - `renderInputs({col:'{MDYY} Updates'}, 2026-11-25T12:00Z)` 返回 `{col:'11/25/26 Updates'}`
- [ ] 运行 `pnpm --filter server exec vitest run src/board/schedule.test.ts`，预期 FAIL。
- [ ] 实现。
- [ ] 再运行，预期 PASS。
- [ ] Commit `feat(board): PT schedule math`

### Task 3: 运行器

**Files:**
- Create: `apps/server/src/board/runner.ts`
- Test: `apps/server/src/board/runner.test.ts`（用真实测试库，mock 掉 orchestrator 的 `handleUserMessage` 和 `notifyMainAI`，做法同 engine.test.ts）

**Interfaces:**
- Consumes：`createSession`（services/sessions.ts）、`workflowEngine.start(sessionId,{workflow,label,inputs,trigger})`、`getOrchestrator().handleUserMessage`、workflow 路由里的 `notifyMainAI`（如果它在路由文件里，先挪到 `workflow/notify.ts` 再导出）、`renderInputs`
- Produces：
  - `runAutomation(id: string, opts: { trigger: 'manual'|'cron'|'catchup'; dueAt?: Date }): Promise<{ ok: true; run: AutomationRunDTO } | { ok: false; error: string; runId?: string }>`
  - `syncRunStatus(runId: string): Promise<void>`：从 WorkflowRun 状态和会话 run.state 推出 AutomationRun 状态
  - `drainQueue(): Promise<void>`
  - `startRunnerListeners(): void`：订阅 bus 上的 `workflow.run.updated`、`run.state`、`question.*`、`approval.*`、`session.updated`（deleted），据此调用 syncRunStatus，并防抖 1 秒后 emit `board.changed`

状态推导规则：
- WorkflowRun done → done；cancelled/failed → failed；waiting_user/blocked → waiting_user。
- 没有 SOP 的运行：会话 run.state 从 running 变成 idle，且没有待回答的提问或审批 → done。
- 会话被删除 → failed，note 写「会话已删除」。
- 下一次同任务运行创建时，把仍处于 waiting_user 的旧运行改成 `stale`；`stale` 仍会出现在「等你处理」里，标为「已过期，未完成」。

互斥：进程内每个任务一把锁，再加上 `dueAt` 唯一键兜底，P2002 冲突一律视为「已经处理过」。全局名额满的时候，cron/catchup 运行先写成 `queued`，`drainQueue` 按 dueAt 顺序出队；出队时如果 `now - dueAt > 24h`，记 skipped，note 写「错过」。

- [ ] **写失败测试**：
  - `manual 无 SOP → 新会话标题「EOD 每日总结 · 11/24」、handleUserMessage 收到 prompt、run.status='running'`
  - `有 SOP → WorkflowRun.trigger='manual'、AutomationRun.workflowRunId 已填`
  - `已有 running 实例时再 manual → ok:false，error 含「上次还没完成」，runId 指向旧运行`
  - `同 dueAt 并发两次 cron → 只有 1 条 AutomationRun`
  - `已有 2 个 cron running → 第 3 个为 queued；其中一个 done 后 drainQueue → 第 3 个变 running`
  - `queued 超过 24h 出队 → skipped，note「错过」`
  - `会话删除 → failed`
  - `旧运行 waiting_user，新 cron 运行 → 旧运行 stale、新运行 running`
  - `mode=auto 但 SOP 是草稿 → ok:false`
- [ ] 运行，预期 FAIL。实现。再运行，预期 PASS。
- [ ] Commit `feat(board): automation runner with queue + status sync`

### Task 4: 定时器与补跑

**Files:**
- Create: `apps/server/src/board/cron.ts`
- Test: `apps/server/src/board/cron.test.ts`
- Modify: `apps/server/src/index.ts`（在 `scheduler.reloadPending()` 旁边加 `void boardCron.start()`）

**Interfaces — Produces:** `boardCron.start(): Promise<void>`、`boardCron.tick(now?: Date): Promise<void>`（导出给测试用）、`boardCron.stop(): void`

- 每 30 秒 tick 一次。对每个 `enabled && mode==='auto'` 的任务，求 `d = lastDue(spec, now)`；如果 d 存在、`d > (createdAt)`、且 `(automationId, d)` 还没有对应的运行：`now - d ≤ 24h` 就调用 `runAutomation({trigger: now-d > 2min ? 'catchup' : 'cron', dueAt: d})`，否则写一条 skipped（note「错过」）。tick 结束后刷新各任务的 `nextRunAt = nextDue(spec, now)`。
- SOP 已归档或已不再是 confirmed 时：任务改回 `mode='manual'`，emit notification「{任务名} 的 SOP 已不可用，已改回手动」。
- 前一次 tick 还没跑完时，跳过这次 tick。

- [ ] **写失败测试**：
  - `tick 在 18:00:10 → 生成 1 条 trigger=cron`；再 tick 一次，仍然只有 1 条
  - `启动时 lastDue 在 3 小时前且无记录 → catchup`
  - `lastDue 在 30 小时前 → skipped，note「错过」`
  - `mode=manual 的任务 → 不生成任何运行`
  - `SOP archived → mode 变 manual，并发出 notification`
- [ ] 运行，预期 FAIL。实现。再运行，预期 PASS。
- [ ] Commit `feat(board): cron tick + catch-up`

### Task 5: 归类与项目总结

**Files:**
- Create: `apps/server/src/board/classify.ts`
- Test: `apps/server/src/board/classify.test.ts`（mock `complete`）
- Modify: `apps/server/src/learning/title.ts`（标题生成成功后 `void classifySession(sessionId)`）

**Interfaces — Produces:**
- `classifyAll(): Promise<{ projects: number; assigned: number }>`：只处理 `projectSource !== 'user'` 的非 deleted 会话，每批 40 个。第一批让模型同时提出项目列表；后面的批次只能从已有项目里选，或者归到「未归类」。模型输出 JSON `{ projects?: string[], assign: { [sessionId]: string } }`，解析失败重试 1 次，仍失败就跳过这一批并记日志。
- `classifySession(id): Promise<void>`：只从已有项目里选，选不出就是 null（未归类）；`projectSource='user'` 的会话不动。
- `summarizeProject(id): Promise<void>`：输入最近 10 个会话的标题、最新的 MemorySummary 和未完成的 PlanTask，生成 2-3 句中文总结。
- `refreshSummariesDaily()`：每天 PT 06:00 运行（由 cron.ts 调用，复用 `nextDue`），只处理 `lastActivityAt > summaryAt` 的项目。
- 模型一律用 `complete({ model: settings.subagent, trigger: 'summarize' })`。

- [ ] **写失败测试**：
  - `classifyAll：mock 返回 2 个项目 → 建出 2 个 Project，会话 projectSource 仍为 'ai'`
  - `projectSource='user' 的会话 → 不被改`
  - `模型返回非 JSON 两次 → 不抛错，该批跳过`
  - `classifySession：返回不存在的项目名 → projectId=null`
- [ ] 运行，预期 FAIL。实现。再运行，预期 PASS。
- [ ] Commit `feat(board): AI session classification + project summaries`

### Task 6: Board 路由

**Files:**
- Create: `apps/server/src/http/routes/board.ts`、`apps/server/src/board/today.ts`、`apps/server/src/board/seed.ts`
- Modify: `apps/server/src/http/app.ts`（注册路由，prefix `/api`）
- Test: `apps/server/src/http/routes/board.test.ts`（用 `app.inject`）

**Interfaces — Produces（REST）：**

| 方法 路径 | 用途 |
|---|---|
| GET `/board/today` | 返回 `BoardTodayDTO`。范围：PT 今天 updatedAt 的会话，加上所有 waiting/stale 的运行。running = currentRunState 为 running/paused；waiting = 有 open question 或 pending approval；其余进 done。progress 取进行中的 PlanTask 文本，没有则取 AgentRun.currentActivity |
| GET `/board/projects` | 返回 `ProjectDTO[]` 和「未归类」计数 |
| GET `/board/projects/:id/sessions` | 该项目的会话列表 |
| POST `/board/projects` `{name}`、PATCH `/board/projects/:id` `{name?,sortOrder?}`、POST `/board/projects/:id/merge` `{intoId}` | 管理项目 |
| PATCH `/sessions/:id/project` `{projectId: string\|null}` | 改会话归属，并设 projectSource='user' |
| POST `/board/classify` | 触发 classifyAll，在后台跑，返回 202 |
| POST `/board/projects/:id/summary` | 刷新单个项目的总结 |
| GET `/board/automations` | 返回 `AutomationDTO[]` |
| POST/PATCH/DELETE `/board/automations[/:id]` | 增改删任务。切到 auto 时，SOP 不是 confirmed 就返回 409 「先整理成 SOP」 |
| POST `/board/automations/:id/run` | `runAutomation({trigger:'manual'})`；冲突时返回 409，带 error 和 runId |
| POST `/board/automation-runs/:id/dismiss` | stale 或 waiting 的运行标为 failed，note「用户关闭」 |

`seed.ts`：`seedAutomations()` 只在 Automation 表为空时插入 spec 5.6 列出的 6 条任务，全部 `mode='manual'`。默认频率如下：
- EOD：weekdays 18:00
- Sales 周报：weekly 周五 16:00
- Tracker 周更：weekly 周三 10:00，绑 SOP `tracker-weekly`
- 画像表：weekly 周一 10:00，绑 `customer-profiles-weekly`
- Tracker Updates 列：biweekly 周三 09:00，anchor 2026-11-18，绑 `tracker-updates-column`，inputs `{column:'{MDYY} Updates'}`
- 三表同步：weekly 周三 11:00，暂时无 SOP，用 prompt

EOD 和周报先用 prompt：从历史会话「每日总结邮件及微信中文简版update」「生成Sales周报含回复率及草稿」中提取第一条用户消息作为 prompt。

- [ ] **写失败测试**：
  - `PATCH automation mode=auto 且无 SOP → 409`
  - `POST run 两次 → 第二次 409`
  - `PATCH sessions/:id/project → projectSource='user'`
  - `today：有 open question 的会话出现在 waiting 中`
  - `seed 执行两次 → 仍为 6 条`
- [ ] 运行，预期 FAIL。实现。再运行，预期 PASS。另外跑 `pnpm --filter server test` 全量。
- [ ] Commit `feat(board): REST routes + seed`

### Task 7: 前端 `/board` 页面（交付版）

**Files:**
- Create: `apps/web/src/app/board/page.tsx`，以及 `apps/web/src/components/board/` 下的 `TodayColumns.tsx`、`SessionCard.tsx`、`ProjectGrid.tsx`、`ProjectCard.tsx`、`AutomationTable.tsx`、`AutomationEditor.tsx`（用现有的 Modal 模式）、`ScheduleLabel.tsx`
- Modify: `apps/web/src/lib/api.ts`（补上 Task 6 各接口的方法）、`apps/web/src/lib/ws.ts`（收到 `board.changed` 后 invalidate `['board', …]`）、`apps/web/src/components/TopNav.tsx`（加 `LayoutDashboard` 入口，放在 Wiki 之前）

**设计要求**
- 动手前读 taste-skill 的 SKILL.md（只沿用规则）和 frontend-design 技能，并参照 `/workflows` 页面的排版方式：`main` 容器、h1 大小、说明文字、Section。
- 顶部是分段控件「今天 / 项目 / 自动化」，同步到 `?tab=`。
- **今天**：三列（≥lg 并排，<lg 纵向堆叠），每列标题带计数。卡片内容为标题（最多 2 行）、所属项目、一行进展、相对时间；stale 的卡片加 `.tone-warning` 标签「已过期，未完成」，并带一个「关闭」按钮；点卡片进入 `/s/{slug}`。
- **项目**：卡片网格（auto-fill，最小宽度 280px）。卡片内容为名称、总结、会话数、最近活动，以及「刷新总结」按钮；点开后展开会话列表，每个会话可以用「移到…」菜单改归属。页面顶部有「重新归类」按钮，点击前要二次确认，并说明手动改过的会话不会被动。「未归类」放在最后。
- **自动化**：≥md 显示为表格，<md 显示为卡片列表。列为：名称、频率（`describeSchedule`）、SOP（链接到 /workflows；没有 SOP 时用 `.tone-muted` 显示「未绑定 SOP」）、模式开关（没有已确认 SOP 时置灰，tooltip「先整理成 SOP」）、上次运行（状态标签 + 会话链接 + 时间）、下次运行、「立即运行」按钮（运行中显示 spinner，409 时用 toast 提示并附旧会话链接）、编辑。

- [ ] 实现。
- [ ] 验证：`pnpm --filter web typecheck` 和 `pnpm --filter web lint` 通过。
- [ ] 用 Playwright 打开 3104/board，三个 tab 各截一张图。宽度覆盖 390 / 820 / 1440 / 2560，配色覆盖琥珀和港湾蓝 × 白天和夜间。同时验证 Review Focus 第 5 条：用一条 80 字标题的测试数据看布局。
- [ ] 手动点「立即运行」跑一个测试任务（prompt 为「回复 OK」），确认生成了新会话、看板实时出现在「运行中」、结束后进入「今天已完成」、登记表的上次运行也更新了。
- [ ] Commit `feat(board): /board page`

### Task 8: 首次归类与 EOD/周报 SOP 草稿

**Files:**
- Create: `BISOP/workflow-drafts/eod_daily.json`、`sales_weekly.json`（与现有草稿目录放在一起）

- [ ] 在测试库执行 `POST /board/classify`，把项目列表和每个项目的会话数整理给用户过目，**请用户确认或调整项目划分**。
- [ ] 参照记忆里的 EOD 格式规则和周报规则，以及对应的历史会话，起草两份 SOP JSON，用 `POST /workflows` 写入（草稿状态），等用户在 /workflows 上确认。
- [ ] 进度记录写到 `.superpowers/sdd/2026-11-24-board/progress.md`。

### Task 9: 打磨三轮（全站）

**Files:** 涉及所有 `apps/web/src/**` 页面，只修细节，不改布局

- [ ] 拉取 `https://github.com/heydamir/unslop` 和 `https://github.com/jakubkrehel/make-interfaces-feel-better` 的规则文档放到 scratchpad 阅读。web-design-guidelines 用现成的技能。
- [ ] **unslop 轮**：逐页对照（首页、会话页、/board、/wiki、/wiki/graph、/workflows，以及设置弹窗、历史菜单、调色板），列出瑕疵清单，再逐条修改。
- [ ] **make-interfaces-feel-better 轮**：检查嵌套圆角、图标与文字基线对齐、字号字重、换行（`text-wrap: balance/pretty`）、点击区域 ≥32px、按下状态、展开/收起和进出场动画（尊重 `prefers-reduced-motion`）、不同内容长度下的对齐；四种宽度都要看；滚动条统一（`scrollbar-width: thin` 加令牌色，以及 `scrollbar-gutter: stable`）。
- [ ] **web-design-guidelines 轮**：调用技能逐页审查，逐项修复。
- [ ] 每轮做完：typecheck 和 lint 通过，四种宽度 × 两套配色 × 白天/夜间截图对比，并在 progress.md 记下改了什么。
- [ ] Commit：每一轮单独一个 commit。

### Task 10: 合入前准备

- [ ] 再做一次主目录 → worktree 的全量逐文件比对，把用户的新改动同步进来（单独的 `sync:` 提交）。
- [ ] 全量测试和类型检查。
- [ ] **向用户汇报并征求合入同意**。同意后，按记忆中 workflow 合入的顺序操作：正式库 db push → 只应用 schema → 停掉 tsx 子进程 → prisma generate → 应用其余改动 → touch index.ts。

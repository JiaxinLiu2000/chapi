# chapi 看板（Board）+ 自动化登记表 设计

日期：2026-11-24　状态：待用户批准

## 1. 目的与原因

用户每天在 chapi 里同时开很多会话（目前 96 个：76 个 active、20 个 completed），涉及十几个项目，此外还有一批要定期重复做的事，比如 EOD 邮件、Sales 周报、三表更新。现在的问题有三个：

- 看不到今天哪些会话在跑、哪些在等她回复；
- 会话没有按项目归类，找不到某个项目的最新进展；
- 定期任务全靠记忆手动开会话，没有记录频率、上次做的时间和所用的 SOP，而且第二次跑容易漏步骤。

要做一个看板页，集中展示以上三类信息。其中定期任务做成一张登记表，可以一键手动触发；每个任务可以单独选择「自动」（按时自己跑）或「手动」。**每次运行的稳定性是第一要求。**

## 2. 目标 / 非目标 / 反目标

**目标**
- G1 今天：用看板列的形式展示当天有活动的会话，分为「运行中 / 等你处理（提问或审批）/ 今天已完成或空闲」三列，每张卡片附一句当前进展。
- G2 项目：用 AI 把全部会话（不含 deleted）归到项目下，每个项目显示一段简短总结、会话数和最近活动时间。用户可以手动改会话的归属，以及新建、重命名、合并项目。
- G3 自动化登记表：每个任务记录名称、频率、绑定的 SOP、自动或手动、上次运行（哪个会话、什么时间、结果）、下次运行时间，并带一个「立即运行」按钮。
- G4 自动模式：后端按频率自动开会话运行。chapi 重启后能恢复定时；错过的运行只补跑一次。
- G5 稳定性：见第 5 节的规则。

**非目标**
- 不碰 Windows 计划任务或云端 routine；chapi 不开着就不会运行，开机后补跑。
- 不做跨设备通知；沿用 chapi 现有的 notification 和 attention。
- 不改其他页面的版面（用户已明确要求不改 layout）。

**反目标**（技术上能跑通也算失败的情况）
- 自动运行没走 SOP 就去写表或建草稿；
- 绕过审批：自动运行遇到写表或草稿审批时，必须停下来等用户；
- 同一个任务同时跑两个实例；
- 看板页样式和 chapi 其他页面不一致：硬编码颜色、换了字体、不跟随 5 套配色和白天/夜间。

## 3. 约束

- 技术栈：Fastify + Prisma(MySQL 3307) + Next.js App Router + Tailwind（颜色全部用 `--c-*` 令牌）+ lucide 图标（stroke 1.75），字体为 IBM Plex Sans / Noto Sans SC / IBM Plex Mono，按钮类用 `.btn--*`，标签用 `.tone-*`，动画用 `anim-*`。
- 时区：所有频率都按 America/Los_Angeles 计算，界面也用 PT 显示。
- 在 worktree 开发（新建 `../chapi-kb`，分支 `feat/board`）。开发前要和主目录逐文件同步，因为用户会并行改前端；合入主目录前必须征得用户同意。合入时需要对 3307 做 db push，装依赖后要按已知方法恢复后端。
- 修改 `tailwind.config.ts` 后，正在运行的 web 不会重新加载；新的工具类要在 globals.css 里写一份兜底。
- SOP 只能由用户在 /workflows 网页上确认（已有的安全机制，不能绕开）。

## 4. 考虑过的做法

| 做法 | 取舍 | 结论 |
|---|---|---|
| **一、登记表直接建在 SOP 引擎上**：任务 = SOP + 频率 + 自动/手动开关，定时器放在后端进程内 | 稳定性最好，复用 workflow 已有的阶段强制和证据机制；但 EOD 和周报要先补写 SOP | **用户选定** |
| 二、任务 = 一段固定指令，不强制绑 SOP | 上线快，但稳定性只能靠指令写得好，和现在手动跑差不多 | 否 |
| 三、Windows 计划任务或云端 routine | 不依赖 chapi 开着，但和会话、审批、实时进度都脱节 | 否 |

## 5. 已定的设计

### 5.1 页面
- 新路由 `/board`，在顶栏 Wiki 图标之前加一个入口（lucide `LayoutDashboard`）。
- 一个页面包含三个区块，用顶部分段切换：「今天 / 项目 / 自动化」，默认打开「今天」，选中的 tab 同步到 URL `?tab=`。
- 页面数据通过 REST 加载，实时更新走现有的 WebSocket bus（会话状态、agent.status、提问和审批事件）。

### 5.2 数据模型（新增）
- `Project { id, name, summary Text?, summaryAt?, sortOrder, archived, createdAt, updatedAt }`
- `Session` 新增 `projectId String?`、`projectSource String @default("ai")`（ai | user；user 表示用户手动设置，AI 以后不会再改）。
- `Automation { id, name, workflowId?, prompt Text?（仅给没有 SOP 的手动任务用）, schedule Json, mode ("manual"|"auto"), enabled, model, effort, projectId?, lastRunAt?, lastSessionId?, lastStatus?, nextRunAt?, createdAt, updatedAt }`
  - schedule 的结构：`{ kind: 'daily'|'weekdays'|'weekly'|'biweekly'|'monthly', time: 'HH:mm', weekdays?: number[], anchorDate?: 'YYYY-MM-DD', dayOfMonth?: number }`
- `AutomationRun { id, automationId, sessionId, workflowRunId?, trigger ('manual'|'cron'|'catchup'), status ('running'|'waiting_user'|'done'|'failed'|'skipped'), note Text?, startedAt, endedAt? }`。登记表的「上次运行」就从这张表取。

### 5.3 运行流程（手动和自动走同一条路径）
1. 检查是否在跑：如果这个任务有未结束的 AutomationRun，手动触发时报错「上次还没完成」并给出链接；自动触发时记一条 skipped。
2. 新建会话：标题为「{任务名} · M/D」，模型和 effort 用任务上固定的值，language=zh，并归到任务所属的项目下。
3. 有 SOP 时，调用 `workflowEngine.start(sessionId, { workflow, trigger: 'manual'|'cron', label })`，再按现有路由的方式 notifyMainAI。没有 SOP 时（只允许手动），把 prompt 作为第一条用户消息发出去。
4. 同步状态：监听 WorkflowRun 和会话 run 的状态，回写到 AutomationRun。等用户回答或审批时，状态记为 waiting_user。
5. 失败时（启动失败或 run 报错），AutomationRun 记为 failed 并写入原因，同时发出 notification。

### 5.4 稳定性规则
- 只有绑定了**已确认 SOP** 的任务才能切到「自动」；没有 SOP 的任务，开关置灰并提示「先整理成 SOP」。
- 每次运行都新开会话，不复用旧会话，避免旧上下文带偏。
- 每次运行记录所用 SOP 的版本号（WorkflowRun.version 已有这个字段）。
- 审批照常进行：自动运行停在审批上就进入 waiting_user，在「今天 → 等你处理」列里显示。
- 同一个任务最多同时有一个实例在跑；全局同时跑的自动任务不超过 2 个，多出来的排队。
- 补跑：后端启动时，对每个 auto 任务计算「上次应该运行的时间」。如果晚于 lastRunAt 并且在 24 小时以内，就补跑一次（trigger=catchup）；超过 24 小时的记一条 skipped，写明「错过」。

### 5.5 会话归类与项目总结
- 首次归类：用副 AI 模型批量处理全部非 deleted 会话。输入每个会话的标题、第一条用户消息的前 300 字和最近一条 MemorySummary，输出项目列表和每个会话的归属。结果写入数据库，用户在「项目」tab 里可以改。
- 新会话：在 AI 生成标题之后自动归到已有项目里；归不进去的放到「未归类」，不会自动新建项目。
- 项目总结：每天 PT 06:00 为有新活动的项目各生成 2-3 句总结，也可以在卡片上点「刷新」。生成时使用该项目最近的会话标题、MemorySummary 和 PlanTask 状态。

### 5.6 初始登记表（全部默认为手动，由用户自己切换）
以历史会话为依据预填以下任务：EOD 每日总结邮件、Sales 周报、UP BD Project Tracker 周更（SOP tracker-weekly）、Customer Profiles 画像表（customer-profiles-weekly）、Tracker Updates 列（tracker-updates-column，双周三）、三表同步。各项频率按记忆里的口径预填，用户可以修改。EOD 和 Sales 周报的 SOP 草稿由我参照过去的会话起草，交给用户在 /workflows 上确认；确认之前，这两个任务只能用固定 prompt 手动运行。

### 5.7 交付之后的打磨
交付版完成后，依次用 unslop、make-interfaces-feel-better 和 vercel web-design-guidelines 审查所有前端页面，覆盖嵌套、对齐、字号字重、换行、点击区域、按下状态、展开收起和进出场动画、不同内容长度、超宽屏 / iPad / Mac / 手机四种宽度以及滚动条。设计规则参照 taste-skill（`C:\Users\tygac\Documents\Silk-lab\.claude\skills\taste-skill`），但只沿用其中的规则，不改用它的字体和配色。

### 5.8 审阅后补充（标「我的决定」的由实现者定，用户可改）
- **排队**（我的决定）：排队要落库，AutomationRun 增加 `queued` 状态，所以 chapi 重启后队列还在。出队时如果距离应运行时间已经超过 24 小时，就记为 skipped，写明「错过」。
- **lastRunAt**（我的决定）：记的是触发时间。某个应运行时刻只要已经有一条 AutomationRun，不管 done、failed 还是 skipped，都算处理过，补跑时不会重复。
- **SOP 输入**（我的决定）：Automation 增加 `inputs Json?`，支持占位符 `{today}`、`{weekStart}`、`{weekEnd}`、`{MD}`（PT 日期），启动时替换后传给 `workflowEngine.start`。
- **SOP 变化**（我的决定）：自动运行一律使用当时最新的已确认版本，新出的草稿不影响。SOP 被归档时，任务自动切回手动，并发出提醒。
- **没有 SOP 的手动任务什么时候算结束**（我的决定）：主代理那一轮结束、进入 idle 时记为 done。会话被删除时记为 failed。
- **卡在等你处理的运行**（用户选定 A）：下一次到点时照常新开运行；旧的那次保留不动，在看板上标「已过期，未完成」，由用户处理或关掉。waiting_user 不占全局 2 个名额。「同一个任务最多同时有一个实例在跑」只看真正在跑的（running/queued）。
- **打磨范围**：用户原话是「检查整个前端的所有页面」，所以打磨覆盖全站。这里的「不改版面」指只修细节，不重排布局。

## 6. 留给实现者
- 看板卡片和项目卡片的具体视觉；拖拽改归属可以用菜单代替。
- 归类时副 AI 一批处理多少个会话、prompt 怎么写。
- 状态同步用轮询还是事件订阅。
- 定时器的实现（setTimeout 链或每分钟 tick）。

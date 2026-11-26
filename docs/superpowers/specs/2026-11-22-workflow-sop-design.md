# chapi Workflow（SOP 固化 + 主 AI 监督 / 副 AI 逐阶段执行 + 可视化）设计与实施计划

日期：2026-11-22 · 状态：待审批（v2：按用户反馈改为主 AI 选定 SOP、派副 AI 逐阶段执行，并且适用于所有已确认的 SOP）

## 1. 背景与目的

用户有一批固定 SOP：根据本周各来源材料准备 weekly report；按 BI SOP 处理活动 attendee list，挖联系方式并写入 Contacts Workbook，等等。chapi 第一次能做对，之后就不稳定：会忘掉整个 SOP，或者漏掉其中几步。

**实际故障**：跑 BI SOP（`C:\Users\tygac\Downloads\BI SOP.docx`，对应 Google Doc `193btMjXSNM6rC0o57Ogf97z1uiToMHblCEwRO7DdPMs`）时，chapi 跳过了**阶段 6 多源兜底**（biscred → WebSearch → 重新验证，最多 3 轮），直接把结果写进了表格。

**用户的要求**：
1. 由主 AI 选定 SOP，然后**派副 AI 依次完成各个阶段**。
2. 不只是这一份 SOP：**以后我们确认过的每一份 SOP，chapi 都要能照着执行**，不能每份 SOP 都要另写代码。
3. 经常会从 SOP 中间某一步开始让 chapi 接着做，这种情况也不能出错。
4. 能像参考截图那样，把 workflow 画成节点图。

**根因（基于现有代码）**：
1. SOP 只是"软记忆"。它在知识库里，靠 `recallBlock` 按相关度附给模型（`orchestrator.ts:119`）。没检索到或者模型没认真看，就会丢。
2. 任务流由模型自己写。`set_plan`（`engine/plan.ts`）的步骤完全由模型临场决定，漏写步骤，系统不会发现。
3. 有条件的步骤（"有没通过的才兜底"）由模型自己判断要不要做。
4. 写入表格没有门禁。`request_approval` 只检查"任务流里有没有没收尾的步骤"。
5. 一个长对话里 SOP 原文、几十次工具调用、各批数据都挤在同一个上下文里，越往后越容易丢细节。
6. 定时任务只能执行一次（`engine/scheduler.ts`）。
7. 从中间开始时，模型既不知道前面留下了什么，也不知道后面还有哪些步骤必须做。

## 2. 目标 / 非目标 / 反目标

**目标**
- G1 **通用**：任何 SOP 都能变成结构化的 workflow，包括节点、顺序、条件、批次循环、人工确认点、每步的完成标准和证据字段。**执行和验收都由通用机制完成，不需要为某份 SOP 写代码。**
- G2 **SOP 有生命周期**：主 AI 可以根据 SOP 文档起草 workflow，**只有用户确认过的版本才能运行**。主 AI 能从"已确认 SOP 目录"里，为用户的请求选出对应的 SOP。
- G3 **主 AI 监督、副 AI 逐阶段执行**：每个阶段（循环里是每批的每个阶段）派一个新的副 AI。它拿到的是**系统生成的阶段说明**（SOP 原文 + 输入文件 + 完成标准），不是主 AI 的转述。副 AI 做完交证据，主 AI 审核通过后，才进入下一阶段。
- G4 **顺序和条件由系统决定**：阶段顺序、要不要走某个条件阶段、循环到第几批，都由服务器根据证据判断。主 AI 和副 AI 都不能跳过阶段。
- G5 **工具门禁**：只有当前阶段允许写入的副 AI 才能往 Google Sheet / Doc / Drive 写数据，主 AI 本身不能写。
- G6 **从中间开始也不出错**：可以从任意节点（包括某个批次里的某一步）开始，也可以续跑之前中断的运行。系统先做"接续检查"并请用户确认，后面的阶段照常锁定执行。
- G7 **可视化**：workflow 列表页、画布编辑器、运行时实时状态图，会话页能直接看到当前跑到哪个阶段、是哪个副 AI 在做。
- G8 **定时触发**：cron 式重复（如每周一 9:00 PT），每次运行自动新开一个会话。

**非目标（v1 不做）**
- 不做 n8n 那样的纯数据流引擎，节点之间也不做可视化连线传参。阶段之间通过约定目录里的文件和结构化证据交接。
- 同一个运行里不做阶段并行。用户要的是依次执行，而且浏览器同一时间只能被一个脚本驱动。
- 不做通用表达式语言。条件只支持结构化比较（字段 / 运算符 / 值）。
- 不自动修改已确认的 SOP。运行中发现 SOP 需要改，只能生成**草稿版本**，由用户确认。

**反目标（做出来但等于失败的情况）**
- 副 AI 拿到的阶段说明是主 AI 概括过的，又丢了细节。**阶段说明必须由系统用 SOP 原文生成**。
- 门禁太死，导致 SOP 里本来就允许灵活处理的情况卡死、没法推进。必须有"带理由跳过 / 请用户放行"的出口。
- 某份 SOP 要能跑，还得额外写代码。校验脚本只是**可选增强**，不是前提。
- 成本失控。阶段数 × 批次数可能有几十个副 AI，必须能按节点指定副 AI 的模型（机械性的阶段用便宜模型），并在运行前估算副 AI 数量。

## 3. 方案

### 3.1 选定的结构：三层分工

| 角色 | 负责 | 不负责 |
|---|---|---|
| **服务器引擎**（代码，唯一的真相来源） | 存 workflow 定义和运行状态；按定义生成并锁定阶段序列；判断条件、重复、循环；校验证据格式；发放派发令牌；工具门禁；断点续跑 | 不做业务判断 |
| **主 AI**（会话里的主代理） | 理解用户请求，**选定 SOP**（从已确认目录里选，或者起草新草稿）；确定起点、运行标签、输入材料；向引擎领取下一阶段，**派副 AI**；**审核**副 AI 交回的证据和产物，决定通过还是返工；和用户沟通（人工确认、异常） | 不亲自做阶段里的活；不能写入受控工具；不能跳过阶段 |
| **副 AI**（每个阶段 / 每批一个，新上下文） | 按系统下发的阶段说明完成这一阶段；把产物存到约定目录；调用 `workflow_submit_stage` 交证据 | 不能决定下一步做什么；不能动其他阶段 |

**为什么还要服务器引擎，不完全交给主 AI 安排**：这次漏掉阶段 6 的正是主 AI，让它"记得派哪些副 AI"同样会漏。所以由引擎决定顺序和条件，主 AI 只能按引擎给的顺序一个一个派。

**为什么用副 AI**：每个阶段从干净的上下文开始，只装这一阶段的 SOP 原文和输入，不会被前面几十次工具调用和别的批次数据挤掉细节。主 AI 的上下文也只留每阶段的证据摘要，长时间运行也不会膨胀。

### 3.2 考虑过、没有选的方案

| 方案 | 为什么没选 |
|---|---|
| 主 AI 自己逐阶段做，加锁定和门禁（v1 草案） | 单一上下文越跑越长，细节容易丢；也不符合用户"派副 AI 依次做"的要求 |
| 服务器直接起独立代理跑每个阶段，主 AI 不参与（类似 n8n） | 没有主 AI 审核和与用户沟通的环节；阶段之间遇到异常时缺少能综合判断的角色 |
| 主 AI 自由安排副 AI，没有引擎 | 和现在一样靠模型记忆，正是要解决的问题 |
| 每份 SOP 写专用校验脚本，作为主要的验收方式 | 不通用，违反 G1；保留为可选增强 |

## 4. 核心概念

```
Workflow（定义）
 ├─ status: draft | confirmed | archived    只有 confirmed 能运行
 ├─ versions：每次修改 confirmed 版本都生成新的 draft 版本，确认后才生效
 ├─ catalog: name / aliases / whenToUse（一句话：什么请求该用这份 SOP）
 ├─ trigger: manual | cron("0 9 * * 1", "America/Los_Angeles")
 ├─ globalGuards: 工具门禁规则
 └─ nodes[] + edges[]
      节点类型：
      step        阶段（由一个副 AI 执行）
      checkpoint  人工确认（系统发审批，AI 无法自己标完成）
      loop        按批次循环的容器（里面是子节点）
      handoff     接续检查（从中间开始时系统自动插入，也由副 AI 执行）
      start / end

WorkflowRun（一次运行，开始时快照定义的版本）
 └─ NodeRun（某节点在某次迭代的执行记录）
      iterKey: "" | "batch:3" | "batch:3/round:2"
      status: pending | dispatched | submitted | done | redo | skipped | external | failed | blocked | waiting_user
      agentId（执行它的副 AI）/ evidence / review（主 AI 审核意见）/ checkResult / verifyResult / attempts
```

### 4.1 阶段节点字段（step）

| 字段 | 说明 | BI SOP 阶段 6 示例 |
|---|---|---|
| `title` | 节点名 | 阶段 6 多源兜底 |
| `instructions` | **SOP 原文**（markdown），给副 AI 的核心内容 | 原文 L49–54 |
| `inputs[]` | 需要的前置材料：名称、来源节点、怎么核对 | `refind_list`：来自阶段 5，本批没通过或没找到的人 |
| `outputs[]` | 产出：名称 + 文件名约定（存在 `sandbox/wf/<run>/<node>/<iter>/` 下），或外部位置（Sheet tab） | `final.csv` |
| `doneCriteria[]` | 人能读懂的完成标准清单（主 AI 审核时逐条对照） | 每个缺口都查过 biscred；biscred 没有的都做过 WebSearch；新收集的都重新验证过；仍缺的写明原因 |
| `evidence` | 交证据时必须提交的结构化字段（类型 + 必填） | `refind_total:int`, `biscred_checked:int`, `websearch_checked:int`, `revalidated:int`, `still_missing:[{name,field,reason}]` |
| `runIf` | 结构化条件，不满足就系统自动标 `skipped` | `{ ref: "stage5.needs_refind", op: ">", value: 0 }` |
| `repeat` | 重复直到条件满足，有封顶次数 | `{ until: {ref:"self.still_missing_count", op:"==", value:0}, max: 3 }` |
| `allowTools[]` | 本阶段副 AI 可以用的受控工具类别 | （无；写入只在阶段 7 放行） |
| `agent` | 副 AI 设置：`model`（默认跟随会话）、`maxTurns`、可选的技能提示 | `{ model: "default" }` |
| `review` | 审核方式：`main`（默认，主 AI 审）\| `main+ai`（再加质检模型复核）\| `user`（交给用户审） | `main+ai` |
| `check` | **可选**校验脚本（路径 + 参数 + 超时），只给特别容易出错的节点配 | `checks/bi_fallback_check.py --batch {iter.batch}` |
| `onFail` | 返工几次后：`ask_user` \| `block` | `ask_user`（2 次） |

### 4.2 条件引用规则

条件只能引用**已通过审核的证据字段**：`<节点key>.<字段>`，或者 `self.<字段>`（本节点上一轮）。运算符只有 `== != > >= < <= in empty notEmpty`。由服务器判断，不由 AI 判断。

这正好治本次故障：阶段 5 的证据**必须**交 `needs_refind`（需要重找的人数）。只要它 > 0，引擎就一定会发出阶段 6 的派发令牌，主 AI 不派就进行不下去。

### 4.3 工具门禁（globalGuards）

```jsonc
[
  { "family": "sheets_write", "allowedAt": ["stage7_write"], "message": "写入 Workbook 只能在阶段 7。当前阶段：{node}" },
  { "family": "drive_write",  "allowedAt": ["stage7_write", "deliver"] }
]
```

- 判断依据是**谁在调用**：PreToolUse / canUseTool 的输入里带 `agent_id`，用它查到这个副 AI 绑定的 NodeRun，再看这个节点是否允许。主 AI（没有 `agent_id`）调用受控工具一律拒绝。
- 内置类别（`apps/server/src/workflow/toolFamilies.ts`）按工具名正则匹配：`sheets_write`、`docs_write`、`drive_write`、`gmail_draft`。**具体工具名在实现时以 `mcpRegistry` 里的实际清单为准**；启动时把已注册的写操作工具和类别对一遍，没归到类的打日志告警。
- 纵深防御：Bash / PowerShell 命令里如果出现 `sheets.googleapis.com`、`gspread`、`spreadsheets().values().update` 之类的写入特征，也一起拦截（做法同 `permissions.ts` 里的 Slack 规则）。
- 只在会话有**活跃运行**时生效，不影响普通对话。

## 5. 运行机制

### 5.1 选定 SOP（主 AI）

- **已确认 SOP 目录**：系统提示里加一小节，列出所有 confirmed workflow 的 `name / aliases / whenToUse`，每份一行，几十份也只占很少的 token。规则是：**用户的请求对应目录里某份 SOP 时，必须调用 `workflow_start`，不能自己用 `set_plan` 另起任务流**。
- 辅助：`handleUserMessage` 对名称和别名做匹配，命中时附一句 `[工作流] 这条请求可能对应「BI SOP」`。另外，主 AI 在有匹配的情况下调用 `set_plan`，工具会退回一次并提示（用户明确说不按 SOP 做时可以放行）。
- 确定性入口（不依赖 AI 判断）：输入框旁边的 workflow 选择器、画布上的"运行 / 从这里开始"、定时触发。
- `workflow_start({ workflow, fromNode?, fromIter?, label, inputs })`：主 AI 先把起点、运行标签（如 "MF Summit 12/1"）、初始输入（如 attendee list 文件路径）定下来再调用。起点不明确时，先用 `ask_user` 问清楚。

### 5.2 起草新 SOP（主 AI）

- 用户给一份新的 SOP 文档时，主 AI 读完全文，调用 `workflow_save_draft(graph)`。服务器做静态校验：条件引用的字段要存在；循环 `items` 要引用列表字段；不能有不可达节点；门禁类别要能对上；`instructions` 和原文对比覆盖率太低时提醒。不通过就退回具体问题。
- 起草规则（写进工具描述，并作为一个 skill 文件放在技能目录）：
  - 按 SOP 的阶段切节点，`instructions` **逐字保留原文**。
  - 把"仅对…""如果…才…""最多 N 轮""每批""先交负责人过目"之类的措辞分别转成 `runIf`、`repeat`、`loop`、`checkpoint`。
  - 每个节点都要给 `evidence` 字段，并保证所有条件引用的字段都存在。
  - 写入类动作生成 `globalGuards`。
- 草稿保存后，主 AI 给出画布链接，**用户在画布上检查、修改，点"确认"后才进入目录**。主 AI 不能自己确认。
- 运行中发现 SOP 需要调整时（比如用户改了口径），主 AI 可以生成新版本草稿，但当前运行仍按快照执行。

### 5.3 一个阶段怎么跑（核心循环）

```
主 AI                         服务器引擎                         副 AI
  │ workflow_next_stage() ──▶ 算出当前应执行的节点 + 迭代
  │ ◀── 派发令牌 WF-7f3a + 一句话阶段名 + 应该用的 Task 写法
  │ Task(prompt 含 [WF-7f3a]) ─▶ PreToolUse(Task)：令牌有效且是当前阶段 → 放行；否则拒绝
  │                             SubagentStart：把 agent_id 绑定到 NodeRun，
  │                             注入「阶段卡片」(SOP原文/输入文件/完成标准/证据字段/可用工具)
  │                                                               ├ 按卡片干活
  │                                                               ├ 受控工具调用 → 按 agent_id 查节点 → 放行/拒绝
  │                                                               ├ 产物存 sandbox/wf/<run>/<node>/<iter>/
  │                                                               └ workflow_submit_stage(evidence)
  │                             ◀── 格式校验(+可选脚本)，不过就直接退回副 AI
  │                             SubagentStop：没交证据 → 注入提醒让它继续（最多 2 次），仍不交 → 节点 failed
  │ ◀── Task 返回副 AI 总结 + 引擎附上「证据 + 完成标准对照表」
  │ workflow_review_stage(accept | redo, feedback)
  │      accept →（可选质检复核）→ 节点 done → 引擎算下一个节点
  │      redo   → 节点 redo，下一次 workflow_next_stage 发同一节点的新令牌，阶段卡片附上返工意见
```

要点：
- **一次只有一个未完成的令牌**：上一个阶段没审核完，`workflow_next_stage` 不会给新令牌，保证依次执行。
- **阶段卡片由系统生成**，主 AI 的 Task prompt 只需要带令牌和补充说明，不需要也不应该转述 SOP。补充说明会作为"主 AI 备注"附在卡片后面，比如用户临时提的要求。
- **阶段之间的交接**：下一阶段卡片的"输入"一节，列出上游节点的证据摘要和产物文件的绝对路径。副 AI 自己去读文件，不靠主 AI 传话。
- **主 AI 审核是通用的**：对照 `doneCriteria` 逐条判断，抽查产物文件（比如随机看 5 行），在 `feedback` 里写清楚依据。引擎要求 `accept` 时必须对每条完成标准给出"满足 / 不适用 + 理由"，防止敷衍通过。
- `review: user` 的节点：主 AI 审完后再发审批给用户。checkpoint 节点不派副 AI，由系统直接发审批。
- 返工到 `onFail` 阈值：节点进入 `waiting_user`，主 AI 用 `ask_user` 请用户决定：放行、修改要求后再试，或者回退到更早的节点。
- **跳过的出口**：`workflow_request_skip({ reason })`。主 AI 认为某阶段确实不适用时（比如某数据源当天不可用）申请跳过，**用户在审批卡片上同意才生效**。

### 5.4 锁定规则（防止绕过）

- 有活跃运行时，`set_plan` 不能删除、改名、改顺序锁定的步骤。任务流由引擎从 NodeRun 生成，每个阶段一行；循环只展开当前批次，后面的批次显示成一行"批次 4–8（待执行）"。主 AI 可以追加不锁定的辅助步骤。
- `update_plan_step` 不能把锁定步骤标成 done。状态由引擎根据派发、提交、审核自动更新，所以学习代理照常能从步骤状态变化中学习。
- 主 AI 调用不带有效令牌的 `Task` 会被拒绝。只读的 `Explore` 类型除外，主 AI 可以用它查东西。
- `request_approval` 只有在到达 `end` 前的交付节点时才能调用。
- 主 AI 的 **Stop hook**：本轮要结束时，如果运行没结束、又不在等用户，就补一句提醒，告诉它当前该领取或审核哪个阶段，让这一轮继续。每个节点最多提醒 2 次。
- 主 AI 的 **PostToolUse hook**：原来的"任务流提醒"换成"运行进度 + 当前待办（领取 / 审核 / 等用户）"。

### 5.5 循环（批次）

- `loop` 节点配 `items`，引用某个证据字段（比如 `stage3_5.batches` 这个列表）。每个元素是一次迭代，`iterKey="batch:<n>"`。
- 每批依次走完子节点（阶段 4 → 5 → 6 → 7），每个子节点各派一个副 AI。走完后引擎把批次加 1，从子图第一个节点重新开始。
- 对应 SOP 11b / 11d："一批写完再开下一批"，进度由系统维护。
- 开始运行和进入循环时，引擎会估算副 AI 总数（节点数 × 批次数 × 预计重复轮数），显示在确认卡片上。

### 5.6 checkpoint（人工确认）

进入就由系统发起 `approval`（复用现有审批卡片），展示上一节点的证据摘要和产物链接。用户批准 → done；要求修改 → 上一节点返工，带上反馈；拒绝 → 运行进入 `blocked`。

## 6. 从中间开始 / 续跑（G6）

### 6.1 续跑中断的运行

有未完成的 `WorkflowRun` 时，入口（选择器、主 AI 调用 `workflow_start` 时的返回）会提示："BI SOP · MF Summit 12/1 · 停在 阶段 6 · 批次 3/8 · 第 2 轮。[继续] [从别处开始]"。

所有证据、批次名单、产物路径、已写入到第几批都在库里，引擎从断点重新发令牌，新的副 AI 从卡片拿到完整的输入。换一个新会话续跑也可以（`WorkflowRun.sessionId` 可以更新，旧会话记在 `sessionHistory`）。如果中断时有一个副 AI 正在跑，这个节点重置为 pending，重新派。

### 6.2 从任意节点开始（没有之前的运行，或者前面的步骤是在系统外完成的）

1. 主 AI 根据用户的话确定起始节点和批次（比如"从批次 3 的阶段 6 开始"），不明确就问。也可以由用户在画布或选择器上直接选。
2. 引擎把起始节点之前的节点标 `external`（外部已完成，画布上显示灰色虚线），**在起始节点前插入一个 `handoff` 接续检查节点**，派一个副 AI 执行。
3. handoff 的阶段卡片和证据字段由引擎**自动推导**：
   - 起始节点及之后所有节点的 `inputs[]` 里，凡是来自 external 节点的材料，都要交"在哪里 + 怎么确认的 + 数量 / 样例"，产物文件复制或链接到约定目录。
   - 后面所有 `runIf` / `repeat` / `loop.items` 引用到的 external 节点证据字段，都要补出具体值，比如 `stage5.needs_refind` 和 `batches`。
   - 有对外写入的 SOP，要核对外部现状：比如读交付 tab，确认哪些批次已经写入，避免重复写入。
4. handoff 经主 AI 审核后，**固定接一个 checkpoint**，由用户确认一张清单："系统认定前面已完成的状态：…；接下来会执行：阶段 6（本批 4 人）→ 阶段 7 写入 → 批次 4–8 的完整阶段 4–7 → 交付；预计派副 AI 约 22 个"。用户确认后才往下走。
5. 前置材料找不到时，副 AI 不能编造，要交 `missing:[…]`。引擎按 inputs 的来源节点往前推，建议"改从阶段 X 开始"，在确认卡片上给出按钮。
6. 起始节点之后的所有阶段照常锁定，条件照常由引擎判断，所以从中间开始，也不会漏掉后面的兜底阶段。

## 7. 可视化（G7）

依赖：`@xyflow/react`（画布）+ `@dagrejs/dagre`（自动布局）。⚠️ 根据之前的经验，chapi 运行中执行 `pnpm add` 会让 `tsx watch` 崩溃。装依赖要在停服时做，或者装完后 `touch apps/server/src/index.ts` 恢复。

### 7.1 页面

- `/workflows`：SOP 目录。分"已确认 / 草稿"两栏，列出名称、触发方式、上次运行状态、下次运行时间，有"新建"按钮。TopNav 加入口。
- `/workflows/[slug]`：编辑器（参照截图布局）。草稿顶部有"确认此版本"按钮，已确认的版本修改后会自动变成新草稿。

```
┌ Workflows › BI SOP（已确认 v3）› 编辑 ─────────────────────────────────┐
│ 基本设置 ▾  名称 / 别名 / 何时使用 / 来源文档 / 触发：手动·每周一 09:00 PT │
├───────────────────────────────────────────────┬──────────────────────┤
│  [阶段0 准备去重]→[阶段1 匹配主库]→[阶段2 分类 ↻≤5]                   │ 节点设置              │
│        →[◆阶段3 Checkpoint]→┌ 按批次循环 batches ─────────────┐  │ 标题 / SOP 原文        │
│                              │[阶段4 补挖]→[阶段5 验证]          │  │ 输入 / 输出            │
│                              │  →[阶段6 兜底 if needs_refind>0 ↻≤3]│ │ 完成标准 □□□          │
│                              │  →[阶段7 抽查+写入 🔓sheets_write] │  │ 证据字段 + 类型        │
│                              └──────────────────────────────────┘  │ 条件 / 重复            │
│        →[交付审批]→(结束)                          100% [+][−]  │ 副 AI 模型 / 审核方式  │
├───────────────────────────────────────────────┴──────────────────────┤
│ 取消                            ▷ 运行  ▷ 从选中节点运行  ✓ 保存 / 确认 │
└──────────────────────────────────────────────────────────────────┘
```

- **运行视图**（同一张画布，只读）：节点按状态着色（沿用 MonitorCard 的状态色 token），`dispatched` 时显示正在执行的副 AI 和当前工具；循环容器显示"批次 3/8"；被条件跳过的节点用虚线加"已跳过：needs_refind=0"；external 节点显示灰色。点节点能看到副 AI 的总结、证据、主 AI 审核意见（包括每条完成标准的判断）、返工记录，并能跳到对应的聊天消息。
### 7.2 对话里的实时进度（用户要求：任何对话只要调用了 workflow，都能实时看到走到了哪里）

会话里一启动运行（不管是主 AI 调用 `workflow_start`、输入框选择器、续跑还是定时触发），以下三处**自动出现**，不需要手动打开：

1. **聊天流里的实时进度卡片**：插在启动运行的位置，一个运行一张卡片，内容随状态实时更新。卡片固定在聊天流里，翻回去也能看到；运行结束后定格为最终状态，保留下来当记录。

```
┌ ▶ BI SOP · MF Summit 12/1 · 运行中 · 已用 42 分钟 ─────────────── [展开流程图] ┐
│ ✓阶段0 → ✓阶段1 → ✓阶段2(2轮) → ✓◆确认 → [批次 3/8] ✓阶段4 → ✓阶段5 → ●阶段6 → ○阶段7 │
│ ● 阶段 6 多源兜底 · 第 1/3 轮 · 副 AI 正在：google_search "Jane Doe Greystar"        │
│ 下一步：阶段 7 抽查与写入 → 批次 4–8 → 交付审批                                         │
└──────────────────────────────────────────────────────────────────┘
```
   - 一行横向步骤条：循环只显示当前批次的子阶段，前面加"批次 3/8"；跳过的阶段显示删除线和原因；external 显示灰色。
   - 第二行是当前阶段的实时动态：派发中 / 副 AI 正在做什么（复用监控层的 `currentTool / currentActivity`）/ 待主 AI 审核 / 等你确认 / 返工第 N 次。
   - 等你操作的状态（checkpoint、跳过申请、`onFail` 求助）在卡片上高亮，并带"去处理"按钮，直接跳到对应的审批或问题。
   - 点任意阶段：弹出这个节点的详情（副 AI 总结 / 证据 / 审核意见），和画布上的节点详情是同一个组件。

2. **右侧流程图面板自动打开**：完整画布的运行视图，实时着色，正在执行的节点有动画描边并显示副 AI 当前动作。右侧现有的实时浏览器面板改成标签页「流程图 | 浏览器」，两个都开着时可以切换，不会互相挤掉。用户关掉面板后，本会话会记住，之后不再自动弹出；随时可以用卡片上的"展开流程图"重新打开。
3. **左侧 MonitorCard**：任务流区块顶部显示 workflow 名、当前阶段、批次进度；子代理卡片标出它对应哪个阶段。

一个会话里先后或同时有多个运行（比如先跑完 BI SOP 再跑 weekly report）：每个运行各有一张卡片；流程图面板顶部可以切换运行，默认显示最近活跃的那个。

### 7.3 实时更新机制

- 新增 WS 事件 `workflow.run.updated`，内容是 run 状态加所有 nodeRun 状态。只要 nodeRun 状态、批次、待办（等主 AI 审核 / 等用户）有变化就推送。
- 副 AI 的"正在做什么"不另造事件：复用现有的 `agent.status`（AgentRun 行），NodeRun 上存了 `agentRunId`，前端用它把子代理的实时动态挂到对应节点上。
- 聊天卡片落库为一条 `type: 'workflow_run'` 的 Message（`content` 里只存 `runId`）。渲染时从 store 的 `workflowRuns[runId]` 读实时状态；刷新页面或重新打开会话时，`getSessionDetail` 一并返回本会话所有运行的当前快照，所以历史对话里的卡片也显示正确的最终状态。
- 前端 store 加 `workflowRuns: Record<runId, RunDTO>` 切片和 `activeRunId`。

## 8. 定时触发（G8）

- 依赖 `croner`（cron 表达式 + 时区）。`workflow/cron.ts` 负责，启动时 `reloadAll`，做法同 `scheduler.reloadPending`。
- 到点：新建会话（标题如「Weekly report · 2026-11-23」），给主 AI 发 `[工作流] 定时运行「Weekly report」，请调用 workflow_start 开始`。同时服务器直接创建 run，所以就算主 AI 没反应，状态也已经在库里。另外发 `attention` 通知。
- 错过的触发（chapi 当时没开）：启动时检查。上次应触发时间在 24 小时以内就补跑一次，更早的只记录、不补跑。可以按 workflow 配置。
- 原来的 `schedule_task`（一次性）保留不动。

## 9. 数据模型（Prisma，MySQL，`prisma db push`）

```prisma
model Workflow {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String   @db.VarChar(200)
  aliases     Json?
  whenToUse   String?  @db.Text          // 目录里的一句话
  description String?  @db.Text
  sourceRef   String?  @db.Text          // SOP 文档路径 / Doc ID
  status      String   @default("draft") // draft|confirmed|archived
  confirmedVersion Int?                   // 当前可运行的版本
  trigger     Json?                       // { type:'manual' } | { type:'cron', expr, tz, catchUpHours }
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  versions    WorkflowVersion[]
  runs        WorkflowRun[]
}

model WorkflowVersion {
  id          String   @id @default(cuid())
  workflowId  String
  workflow    Workflow @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  version     Int
  graph       Json                         // { nodes, edges, globalGuards }
  state       String   @default("draft")   // draft|confirmed|superseded
  createdBy   String   @default("user")    // user|ai
  note        String?  @db.Text            // 改了什么
  confirmedAt DateTime?
  createdAt   DateTime @default(now())
  @@unique([workflowId, version])
}

model WorkflowRun {
  id             String   @id @default(cuid())
  workflowId     String
  workflow       Workflow @relation(fields: [workflowId], references: [id], onDelete: Cascade)
  version        Int
  graph          Json                       // 开始时的快照
  sessionId      String
  sessionHistory Json?
  label          String?  @db.VarChar(200)
  inputs         Json?                      // 初始输入（如 attendee list 路径）
  status         String   @default("running") // running|waiting_user|blocked|done|cancelled|failed
  startNodeId    String?
  cursor         Json?                      // { nodeId, iterKey }
  pendingToken   String?  @db.VarChar(40)   // 当前未完成的派发令牌
  trigger        String   @default("manual") // manual|cron|chat
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  endedAt        DateTime?
  nodeRuns       WorkflowNodeRun[]
  @@index([sessionId])
  @@index([workflowId, status])
}

model WorkflowNodeRun {
  id           String   @id @default(cuid())
  runId        String
  run          WorkflowRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  nodeId       String
  iterKey      String   @default("") @db.VarChar(120)
  status       String   @default("pending")
  agentId      String?  @db.VarChar(80)     // 当前执行的副 AI
  agentRunId   String?                      // 对应监控里的 AgentRun 行
  summary      String?  @db.Text            // 副 AI 的总结
  evidence     Json?
  review       Json?                        // 主 AI 审核：{ decision, perCriterion[], feedback }
  checkResult  Json?
  verifyResult Json?
  skipReason   String?  @db.Text
  attempts     Int      @default(0)
  startedAt    DateTime?
  endedAt      DateTime?
  @@unique([runId, nodeId, iterKey])
}
```

`PlanTask` 新增 `nodeRunId String?`、`locked Boolean @default(false)`。`PlanTaskDTO` 对应加字段，前端给锁定行显示一个小锁图标。

## 10. 代码落点

| 区域 | 文件 | 改动 |
|---|---|---|
| 共享类型 | `packages/shared/src/domain.ts`、`api.ts`、`events.ts` | `WorkflowDef / NodeDef / RunDTO / NodeRunDTO`、API 类型、`workflow.run.updated` 事件 |
| 定义校验 | `apps/server/src/workflow/schema.ts`（新） | zod 定义 + 静态校验（引用、可达性、门禁类别、原文覆盖率） |
| 引擎 | `apps/server/src/workflow/engine.ts`（新） | start / resume / nextStage（发令牌）/ bindAgent / submit / review / skip / 推进（条件、重复、循环）/ handoff 推导 |
| 条件 | `apps/server/src/workflow/conditions.ts`（新） | 结构化条件求值（纯函数） |
| 阶段卡片 | `apps/server/src/workflow/card.ts`（新） | 给副 AI 的卡片 + 给主 AI 的审核对照表 + recall |
| 校验 | `apps/server/src/workflow/checks.ts`（新） | 可选脚本（沙盘内、超时）；`main+ai` 时复用 `QualityAdvisor.ask` 的新模板 `verifyStage` |
| 门禁 | `apps/server/src/workflow/toolFamilies.ts`（新）+ `engine/permissions.ts` | 按 `agent_id → NodeRun` 判断 |
| 工具 | `engine/tools/chapiTools.ts` | 主 AI：`workflow_start / workflow_next_stage / workflow_review_stage / workflow_request_skip / workflow_status / workflow_save_draft`；副 AI：`workflow_submit_stage`；改 `set_plan`、`update_plan_step`、`request_approval` |
| hooks | `engine/hooks.ts` | PreToolUse(Task) 校验令牌；SubagentStart 绑定并注入卡片（替换现有 `taskPrompts` 队列逻辑里对应的分支）；SubagentStop 没交证据时让它继续；主 AI 的 Stop / PostToolUse 改为运行感知 |
| 监控 | `engine/monitoring.ts` | 子代理 AgentRun 行带上 nodeRunId / 阶段名 |
| 任务流 | `engine/plan.ts` | 锁定行由引擎维护；`setPlan` 保留锁定行；`updatePlanStep` 拒绝把锁定行标 done |
| 编排 | `engine/orchestrator.ts`、`learning/learner.ts` | 目录匹配提示；`[工作流]` 前缀算系统注入 |
| 系统提示 | `engine/systemPrompt.ts` | "已确认 SOP 目录" + "工作流纪律"小节（简短，规则靠代码执行） |
| 起草规则 | 技能目录 `workflow-authoring/SKILL.md`（新） | SOP → workflow 的切分和转换规则，给主 AI 起草时读 |
| 定时 | `apps/server/src/workflow/cron.ts`（新）+ `index.ts` | 启动时 reloadAll |
| API | `apps/server/src/http/routes/workflows.ts`（新）+ `app.ts` 注册 | CRUD / 版本 / 确认 / start / resume / runs / nodeRun 详情 / 跳过审批 |
| 会话数据 | `services/sessions.ts`（`getSessionDetail`）、`mappers.ts` | 返回本会话所有运行的快照；`workflow_run` 消息类型 |
| 前端 | `app/workflows/page.tsx`、`app/workflows/[slug]/page.tsx`、`components/workflow/*`（Canvas、NodeInspector、RunView、RunProgressCard、WorkflowPicker）、`MessageList.tsx`（渲染 `workflow_run` 卡片）、`app/s/[slug]/page.tsx`（右侧面板改为「流程图 \| 浏览器」标签页）、`MonitorCard.tsx`、`Composer.tsx`、`TopNav.tsx`、`lib/store.ts`、`hooks/useSessionSocket.ts` | 见第 7 节 |

## 11. 分阶段实施计划

每个阶段做完都能单独用，按顺序交付。测试用 vitest（`apps/server`），引擎和条件判断写成纯函数，以单元测试为主。涉及 SDK hooks 的部分，用现有 `orchestrator.test.ts` / `run.test.ts` 的 mock 方式测。

### 阶段 1：引擎 + 主 / 副 AI 派发（只支持顺序阶段）
1. Prisma 加四张表和 `PlanTask` 新字段，`prisma db push`，更新 shared 类型。
2. `schema.ts`：先只支持 `step / start / end`。
3. `engine.ts`：`startRun`（从头开始）、`nextStage` 发令牌、`bindAgent`、`submit`（只做格式校验）、`review`（accept / redo）、推进、结束；同一时间只能有一个未完成的令牌。
4. `card.ts`：副 AI 卡片 + 主 AI 审核对照表。
5. hooks：PreToolUse(Task) 校验令牌；SubagentStart 注入卡片；SubagentStop 没交证据时让它继续；主 AI 的 Stop / PostToolUse 改为运行感知。
6. 工具：`workflow_start / workflow_next_stage / workflow_submit_stage / workflow_review_stage / workflow_status`；`set_plan`、`update_plan_step`、`request_approval` 加锁定规则。
7. 最小 API：`POST /workflows`（直接传 JSON，状态设为 confirmed，方便测试）、`POST /workflows/:id/runs`。
8. **测试**：没有令牌的 Task 被拒；令牌和阶段对不上被拒；副 AI 不交证据时被提醒继续；证据缺字段被打回；redo 以后重新派同一节点，卡片带上返工意见；accept 时缺少逐条完成标准判断被拒；锁定行删不掉；运行结束后才能 `request_approval`。

### 阶段 2：条件、重复、循环、人工确认、工具门禁
1. `conditions.ts` 及测试（覆盖所有运算符，引用不存在的字段视为条件不成立并报警）。
2. 引擎：`runIf` 不满足自动 skipped（带原因）；`repeat` 封顶；`loop` 按 items 迭代，任务流只展开当前批次；副 AI 数量估算。
3. checkpoint 和 `review: user` 接现有审批流（approve / revise / reject 三种走向）。
4. `workflow_request_skip` + 用户审批放行；`onFail` 达到阈值转 `ask_user`。
5. `toolFamilies.ts` + `permissions.ts`：按 `agent_id` 判断门禁，主 AI 一律不能写，加上 Bash 写入特征拦截。
6. **测试（复现本次故障）**：阶段 5 证据 `needs_refind=4` → 下一个令牌一定是阶段 6；阶段 5 的副 AI 调 sheets 写入被拒；主 AI 自己调 sheets 写入被拒；`needs_refind=0` → 阶段 6 自动跳过并记录原因；批次 3 写完自动进批次 4。

### 阶段 3：SOP 目录与起草（通用化）
1. 版本和确认流程：`WorkflowVersion`；确认接口；只有 confirmed 能运行；改 confirmed 版本自动生成新草稿。
2. 系统提示加"已确认 SOP 目录"；`handleUserMessage` 匹配提示；有匹配时 `set_plan` 退回一次。
3. `workflow_save_draft` + 全量静态校验 + 技能文件 `workflow-authoring/SKILL.md`。
4. **测试**：草稿不能运行；目录只列 confirmed；静态校验能抓出"条件引用不存在的字段"。

### 阶段 4：从中间开始 / 续跑
1. `startRun({ fromNodeId, fromIter })`：前面的节点标 external，插入 handoff 节点和确认 checkpoint。
2. handoff 卡片和证据字段的自动推导（inputs + 条件引用 + loop items + 外部写入核对）；交了 `missing` 时，建议往前回退到哪个节点。
3. `resumeRun(runId, sessionId?)`：换会话续跑；中断时还在跑的副 AI 对应的节点重置为 pending。
4. **测试**：从"批次 3·阶段 6"开始，handoff 证据字段包含 `stage5.needs_refind` 和 `batches`；确认前不能领取阶段 6；从中间开始后，后面的条件照常判断；续跑能恢复批次号、证据和产物路径。

### 阶段 5：可视化
1. 装 `@xyflow/react`、`@dagrejs/dagre`（停服装，或装完 touch 恢复）。
2. `/workflows` 目录页（已确认 / 草稿）+ TopNav 入口。
3. 编辑器：画布（拖拽、连线、循环容器、条件边标签）+ 右侧节点设置 + 基本设置 + 保存前的静态校验提示 + "确认此版本"。
4. 运行视图 + `workflow.run.updated` 事件 + 节点详情抽屉（副 AI 总结 / 证据 / 审核 / 返工记录）。
5. **对话内实时进度**：`workflow_run` 消息 + RunProgressCard（步骤条 + 当前副 AI 动态 + 待办高亮）；运行一启动就自动打开右侧流程图面板，右侧改为「流程图 | 浏览器」标签页；`getSessionDetail` 返回运行快照，保证刷新和历史对话显示正确。
6. 会话页其余部分：MonitorCard 显示 workflow 头部，子代理卡片标出对应阶段；Composer 加 workflow 选择器（选 workflow / 起始节点 / 批次 / 运行标签）。

> 说明：卡片和面板属于阶段 5，但阶段 1 就会先推送 `workflow.run.updated`，并在 MonitorCard 显示一行文字进度，所以前几个阶段跑测试时也能看到进度。
6. 视觉沿用现有 CSS 变量 token（白天 / 夜间）。

### 阶段 6：用真实 SOP 验证 + 可选增强
1. **BI SOP**：在对话里让主 AI 读 `BI SOP.docx` 起草 → 用户在画布上校正 → 确认 → 跑一批。
2. 可选增强：`main+ai` 质检复核模板；阶段 6、7 的校验脚本（只在验证中发现主 AI 审核仍然漏判时才加）。
3. **第二份 SOP**（weekly report，需要用户提供）：用同一套流程起草、确认、运行，**不写任何专用代码**，以此验证 G1。

### 阶段 7：定时触发
1. `cron.ts` + `croner`、补跑策略、启动时 reloadAll。
2. 定时运行自动新建会话并启动运行，发通知。
3. weekly report 设成每周一 9:00 PT 验证。

### 验收（端到端）
- E1 BI SOP 从头跑一批 10 人：每个阶段由不同的副 AI 执行；阶段 5 有没通过的 → 阶段 6 一定执行；主 AI 审核通过以后才能进入阶段 7 写入；画布全程实时显示。
- E2 故意让阶段 5 的副 AI 或主 AI 直接写表：写入被拒，提示当前阶段。
- E3 新开会话说"按 BI SOP 从批次 3 的阶段 6 继续"：主 AI 选定 SOP 和起点 → 接续检查 → 用户确认清单 → 阶段 6 → 阶段 7 → 批次 4…
- E4 中途关掉 chapi 再打开：续跑能停在原节点、原批次。
- E5 第二份 SOP（weekly report）从文档到运行，全程不改代码。
- E6 weekly report 设成每周一 9:00 PT，到点自动开会话，跑完提交审批。
- E7 在任意对话里启动运行（聊天调用、选择器、续跑、定时都要测）：聊天流里立刻出现进度卡片，右侧流程图面板自动打开，两者随阶段推进实时更新（延迟 ≤ 2 秒）；刷新页面后状态一致；运行结束后，历史对话里的卡片显示最终状态。

## 12. 风险与对策

| 风险 | 对策 |
|---|---|
| 证据由副 AI 自报，可能"编数字" | 证据要带产物文件路径；主 AI 审核时必须逐条对照完成标准并抽查文件；关键节点可以加质检复核或校验脚本 |
| 主 AI 敷衍审核 | `accept` 时必须对每条完成标准给判断和依据；质检顾问周期检查时把审核记录也纳入范围 |
| 副 AI 数量多，成本高、耗时长 | 每个节点可以单独指定副 AI 模型；运行前显示副 AI 数量估算；SOP 里机械性的阶段可以在起草时合并成一个节点 |
| 副 AI 不知道上下文导致返工 | 阶段卡片列出上游证据摘要和产物路径；返工时附上主 AI 的意见；主 AI 备注里可以补充用户的临时要求 |
| SubagentStart 和 Task 对不上 | 同一时间只有一个未完成的令牌；绑定时再核对 Task prompt 里的令牌；对不上就拒绝并记日志 |
| 门禁误伤 | `workflow_request_skip` + 用户放行；门禁报错信息里说明怎么申请 |
| 工具名变化导致门禁漏拦 | 类别正则 + 启动时核对已注册工具，有遗漏就告警 |
| 定义修改影响正在跑的运行 | 运行开始时快照 graph |
| 装前端依赖时后端崩溃 | 见第 7 节注意事项 |

## 13. 留给实现时决定（builder 可自行判断）

- 画布节点的具体视觉样式和图标（沿用现有 token 即可）。
- 证据字段的 UI 编辑形式（表格式字段列表就够）。
- 目录匹配用关键词还是 embedding（建议先用名称 / 别名包含，命中率不够再加 embedding）。
- 阶段卡片里 recall 的条数（建议 k=5）。
- 令牌格式（短 id 即可，比如 `WF-` + 6 位）。

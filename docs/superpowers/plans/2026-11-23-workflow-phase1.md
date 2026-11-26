# Workflow 第 1 阶段（引擎 + 主 / 副 AI 派发，只支持顺序阶段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个已确认的顺序 workflow 可以在会话里启动。由服务器决定当前阶段；主 AI 领取令牌并派副 AI 执行；副 AI 交证据，主 AI 逐条审核后才推进；任务流锁定；运行没结束前不能提交审批；运行状态实时推送。

**Architecture:** `apps/server/src/workflow/` 是新模块。纯函数部分（schema 校验、证据 / 审核校验、阶段卡片）和 Prisma 持久化分开。`engine.ts` 是唯一修改运行状态的入口，任务流的锁定行也由它同步。现有的 `chapiTools.ts`（工具）、`hooks.ts`（Task 令牌校验、副 AI 绑定 / 注入卡片 / 结束前催交证据）和 `plan.ts`（锁定行）只调用 engine 的接口。

**Tech Stack:** TypeScript、Prisma(MySQL)、zod、vitest、@anthropic-ai/claude-agent-sdk hooks、Fastify、Next.js + zustand。

**Spec:** `docs/superpowers/specs/2026-11-22-workflow-sop-design.md`（第 3–5、9–11 节；本计划只覆盖第 11 节的"阶段 1"）

## Global Constraints

- 在 worktree `C:\Users\tygac\Downloads\chapi-wf`（分支 `feat/workflow`）里开发，**不改主目录**（主目录 `tsx watch` 一改文件就会重启用户正在用的 chapi）。合入主目录要用户同意。
- 测试实例：MySQL `chapi-wx-mysql:3308` 上的独立库 `chapi_wf`；后端 8125；前端 3103。测试只删除自己建的行，绝不整表 `deleteMany`。
- 所有面向用户 / 模型的文案都用中文；代码标识符用英文。
- 主 AI 和副 AI 的区分：hook 输入里有 `agent_id` 的是副 AI，没有的是主 AI。
- 同一个运行同时最多一个未完成的令牌（依次执行）。
- 令牌格式：`WF-` + 6 位小写字母或数字。
- 阶段卡片里的 `instructions` 必须原样下发，不能截断、不能改写。
- 注入消息的前缀 `[工作流]` 要算作系统注入（`isSystemInjected`）。
- 只有 `status = confirmed` 的 workflow 能运行（第 1 阶段 API 创建时可以直接设为 confirmed）。

## Review Focus

1. 主 AI 自己调用 `workflow_submit_stage`（不派副 AI，自己交证据）：必须被拒。测试在 Task 8。
2. 副 AI 交的令牌不是绑定给它的（比如抄了旧令牌）：必须被拒。测试在 Task 8。
3. 返工（redo）以后，旧副 AI 的令牌不能再交证据；新令牌的卡片要带上返工意见。测试在 Task 5。
4. 主 AI 用 `set_plan` 传一份不含锁定行的清单：锁定行必须保留，状态也不能被改。测试在 Task 4。
5. 同一个会话已经有运行在跑，又调用 `workflow_start`：拒绝，并告诉它现有运行的进度。测试在 Task 5。

---

### Task 0: worktree 与隔离测试实例

**Files:** 无代码改动（环境）

- [ ] **Step 1: 建 worktree 并复制主目录的未提交状态**
  `git worktree add ../chapi-wf -b feat/workflow`；然后从主目录把 `git ls-files -co --exclude-standard` 列出的、实际存在的文件复制过去（tar 管道）；`git ls-files -d` 列出的文件在 worktree 里删掉；`.env` 单独复制。
- [ ] **Step 2: 记录基线**
  在 worktree 里执行 `git add -A && git write-tree`，把树 id 记下来，写进 memory（之后 `git diff --cached <基线>` 得到纯功能 diff）。
- [ ] **Step 3: 改 worktree 的 `.env`**
  `SERVER_PORT=8125`、`WEB_PORT=3103`、`DATABASE_URL` 指向 `127.0.0.1:3308/chapi_wf`。如果有 CDP 端口之类的设置，参照 chapi-wx 的做法，换成不冲突的值。
- [ ] **Step 4: 安装并建库**
  `pnpm install`；`cd apps/server && npx prisma db push && npx prisma generate`。
  Expected：db push 成功；`npx vitest run src/engine/plan` 之类的现有测试能跑通（作为基线）。

### Task 1: 共享类型 + Prisma 模型

**Files:**
- Create: `packages/shared/src/workflow.ts`
- Modify: `packages/shared/src/index.ts`（导出）、`packages/shared/src/events.ts`（新事件）、`packages/shared/src/domain.ts`（`PlanTaskDTO` 加 `locked`、`nodeRunId`）
- Modify: `apps/server/prisma/schema.prisma`（`Workflow / WorkflowVersion / WorkflowRun / WorkflowNodeRun`，照搬 spec 第 9 节；`PlanTask` 加 `nodeRunId String?`、`locked Boolean @default(false)`）
- Modify: `apps/server/src/mappers.ts`（`toPlanTaskDTO` 带上新字段）

**Interfaces — Produces（`@chapi/shared`）：**
```ts
export type EvidenceFieldType = 'int' | 'number' | 'string' | 'bool' | 'list' | 'path';
export interface EvidenceField { key: string; type: EvidenceFieldType; required?: boolean /* 默认 true */; desc?: string }
export interface WorkflowIO { name: string; from?: string /* 上游 nodeId */; file?: string; desc?: string }
export type WorkflowNodeType = 'start' | 'end' | 'step';
export interface WorkflowNodeDef {
  id: string; type: WorkflowNodeType; title: string;
  instructions?: string; inputs?: WorkflowIO[]; outputs?: WorkflowIO[];
  doneCriteria?: string[]; evidence?: EvidenceField[];
  agent?: { model?: string; maxTurns?: number };
}
export interface WorkflowGraph { nodes: WorkflowNodeDef[]; edges: { from: string; to: string }[] }
export type NodeRunStatus = 'pending' | 'dispatched' | 'submitted' | 'done' | 'redo' | 'skipped' | 'external' | 'failed' | 'blocked' | 'waiting_user';
export type WorkflowRunStatus = 'running' | 'waiting_user' | 'blocked' | 'done' | 'cancelled' | 'failed';
export interface CriterionVerdict { criterion: string; verdict: 'met' | 'na'; reason: string }
export interface WorkflowNodeRunDTO {
  id: string; nodeId: string; iterKey: string; status: NodeRunStatus;
  agentId: string | null; agentRunId: string | null; summary: string | null;
  evidence: Record<string, unknown> | null;
  review: { decision: 'accept' | 'redo'; perCriterion: CriterionVerdict[]; feedback: string | null } | null;
  attempts: number; startedAt: string | null; endedAt: string | null;
}
export interface WorkflowRunDTO {
  id: string; workflowId: string; workflowName: string; version: number; sessionId: string;
  label: string | null; status: WorkflowRunStatus; graph: WorkflowGraph;
  cursor: { nodeId: string; iterKey: string } | null; pendingToken: string | null;
  nodeRuns: WorkflowNodeRunDTO[]; createdAt: string; endedAt: string | null;
}
export interface WorkflowSummaryDTO { id: string; slug: string; name: string; status: 'draft' | 'confirmed' | 'archived'; confirmedVersion: number | null; whenToUse: string | null; aliases: string[] }
// events.ts
| { type: 'workflow.run.updated'; sessionId: string; run: WorkflowRunDTO }
```

- [ ] **Step 1:** 写类型和 schema（字段照抄 spec 第 9 节）。
- [ ] **Step 2:** `npx prisma db push && npx prisma generate`（worktree，chapi_wf）。Expected：成功。
- [ ] **Step 3:** `pnpm -r typecheck`。Expected：没有新增错误（先在 Task 0 记下基线错误数，作对比）。
- [ ] **Step 4:** Commit `feat(workflow): shared types + prisma models`。

### Task 2: 图校验与执行顺序

**Files:**
- Create: `apps/server/src/workflow/schema.ts`
- Test: `apps/server/src/workflow/schema.test.ts`

**Interfaces — Produces：**
```ts
export type GraphResult = { ok: true; graph: WorkflowGraph; order: string[] /* start..end 的 nodeId，含首尾 */ } | { ok: false; errors: string[] };
export function parseGraph(input: unknown): GraphResult;
export function stepOrder(order: string[], graph: WorkflowGraph): WorkflowNodeDef[]; // 只返回 step 节点
```
第 1 阶段的规则：`id` 匹配 `^[a-z0-9_]+$` 且唯一；有且只有一个 start、一个 end；每个节点最多一条入边、一条出边，从 start 沿边走能覆盖所有节点，最后停在 end；step 节点必须有非空的 `instructions`，`doneCriteria` 和 `evidence` 至少各 1 项；`evidence.key` 在节点内唯一；`inputs[].from` 必须是排在前面的节点。

- [ ] **Step 1: 写失败测试**
  - `accepts a linear start→a→b→end graph`：`order` 等于 `['start','a','b','end']`。
  - `rejects a step without doneCriteria`：`errors` 里有一条包含 `a` 和 `doneCriteria`。
  - `rejects a fork`（start 有两条出边）：报错。
  - `rejects an unreachable node`：报错，并点名这个节点。
  - `rejects inputs.from pointing at a later node`：报错。
  - `rejects duplicate evidence keys`：报错。
- [ ] **Step 2:** `npx vitest run src/workflow/schema.test.ts`，Expected：FAIL（模块不存在）。
- [ ] **Step 3:** 实现：用 zod 做结构校验，然后手写图校验，**把所有错误收集起来一次返回**，不要遇到第一个就停。
- [ ] **Step 4:** 跑测试。Expected：PASS。
- [ ] **Step 5:** Commit。

### Task 3: 证据与审核校验

**Files:**
- Create: `apps/server/src/workflow/validate.ts`
- Test: `apps/server/src/workflow/validate.test.ts`

**Interfaces — Produces：**
```ts
export function checkEvidence(fields: EvidenceField[], input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };
export function checkReview(criteria: string[], perCriterion: CriterionVerdict[]): { ok: true } | { ok: false; errors: string[] };
```
类型规则：`int` 是整数（接受数字字符串 "4" 并转成 4）；`number` 是有限数；`bool` 是 boolean；`list` 是数组；`string` 和 `path` 是非空字符串（会先 trim）。`required:false` 的字段可以缺。多余的字段保留，不报错。
审核规则：每条完成标准都要有对应的判断（criterion 去掉空白后和原文完全相等，或者用"第 N 条"的 `N` 表示，从 1 开始）；`reason` 去掉空白后至少 4 个字；不能多出不存在的标准。

- [ ] **Step 1: 写失败测试**
  - `coerces "4" to 4 for int`。
  - `reports every missing required field at once`：缺两个字段，`errors.length === 2`，而且都点了字段名。
  - `rejects 4.5 for int` / `rejects "" for path`。
  - `allows optional field to be absent`。
  - `checkReview fails when a criterion has no verdict`：错误信息里包含那条标准的原文。
  - `checkReview accepts "第2条" style keys`。
  - `checkReview rejects reason shorter than 4 chars`。
- [ ] **Step 2–4:** 先跑一遍确认失败 → 实现 → 再跑确认通过。
- [ ] **Step 5:** Commit。

### Task 4: 任务流锁定行

**Files:**
- Modify: `apps/server/src/engine/plan.ts`
- Test: `apps/server/src/engine/plan.lock.test.ts`（DB 测试，自己建会话，结束后删掉）

**Interfaces — Produces：**
```ts
export interface LockedStep { nodeRunId: string; text: string; status: PlanTaskStatus; reason?: string | null }
/** 按 nodeRunId 新增或更新锁定行。锁定行排在最前面，顺序按 steps 的顺序；不锁定的行接在后面，相对顺序不变。状态变化会照常通知学习代理。 */
export async function syncLockedSteps(sessionId: string, steps: LockedStep[]): Promise<PlanTask[]>;
```
行为改动：
- `setPlan`：锁定行永远不删、不改名、不改状态。传进来的同名行会被忽略；新的行接在锁定行后面。
- `updatePlanStep`：对锁定行把状态改成 `done` 时，返回 `{ ok:false, error: '这是 SOP 锁定步骤，由工作流自动更新：副 AI 交证据、你用 workflow_review_stage 审核通过后会自动完成。' }`。改成其他状态照常放行。

- [ ] **Step 1: 写失败测试**
  - `setPlan keeps locked rows that are omitted`：先 `syncLockedSteps` 写两行，再 `setPlan([{text:'辅助'}])`，结果有 3 行，前两行是锁定行，状态不变。
  - `setPlan cannot change a locked row status`：传入同名行、状态为 done，锁定行仍是 pending。
  - `updatePlanStep refuses done on a locked row`：返回 `ok:false`。
  - `updatePlanStep allows problem on a locked row with reason`。
  - `syncLockedSteps updates status by nodeRunId and fires transitions`：用 `onPlanTransitions` 注册监听，收到 pending→in_progress。
- [ ] **Step 2–4:** 先跑一遍确认失败 → 实现 → 再跑确认通过。
- [ ] **Step 5:** 跑现有的 plan 相关测试和 learner 测试，Expected：全部通过。
- [ ] **Step 6:** Commit。

### Task 5: 引擎（持久化 + 状态机）

**Files:**
- Create: `apps/server/src/workflow/engine.ts`
- Create: `apps/server/src/workflow/store.ts`（Prisma 读写 + `toRunDTO` + 推送 `workflow.run.updated`）
- Test: `apps/server/src/workflow/engine.test.ts`（DB 测试；`vi.mock('../knowledge/recall.js')` 让它返回 null）

**Interfaces — Consumes：** Task 2 的 `parseGraph`；Task 3 的 `checkEvidence / checkReview`；Task 4 的 `syncLockedSteps`；Task 6 的 `renderStageCard / renderReviewSheet`（Task 5 和 Task 6 可以先确定签名再并行写，engine 测试只断言卡片里包含令牌和节点标题）。

**Interfaces — Produces（`workflow/engine.ts` 导出单例 `workflowEngine`）：**
```ts
type Fail = { ok: false; error: string };
start(sessionId: string, input: { workflow: string /* slug / 名称 / 别名 */; label?: string; inputs?: Record<string, unknown>; trigger?: 'manual' | 'chat' }): Promise<{ ok: true; run: WorkflowRunDTO; message: string } | Fail>;
activeRun(sessionId: string): Promise<WorkflowRunDTO | null>;           // status ∈ running|waiting_user|blocked
nextStage(sessionId: string): Promise<{ ok: true; token: string; nodeId: string; title: string; taskHint: string } | Fail>;
bindAgent(sessionId: string, agentId: string, taskPrompt: string): Promise<string | null>; // 返回副 AI 卡片；prompt 里没有当前令牌就返回 null
tokenOwner(sessionId: string, token: string): Promise<{ agentId: string | null; status: NodeRunStatus } | null>;
submit(sessionId: string, input: { token: string; agentId: string; evidence: unknown; summary: string }): Promise<{ ok: true; message: string } | Fail>;
onSubagentStop(sessionId: string, agentId: string): Promise<string | null>; // 没交证据时返回提醒文字（最多 2 次）；第 3 次把节点标 redo，原因写"副 AI 未提交证据"，并清掉令牌
review(sessionId: string, input: { decision: 'accept' | 'redo'; perCriterion: CriterionVerdict[]; feedback?: string }): Promise<{ ok: true; message: string } | Fail>;
reviewSheet(sessionId: string): Promise<string | null>; // 有 submitted 节点时返回审核对照表
statusText(sessionId: string): Promise<string>;
approvalBlock(sessionId: string): Promise<string | null>;  // 有活跃运行时返回拒绝提交审批的原因
turnEndReminder(sessionId: string): Promise<string | null>; // 每个节点最多 2 次
```
状态机：
- `start`：只能运行 confirmed 的 workflow，读 `confirmedVersion` 的 graph 快照；同一会话已有活跃运行时，返回 Fail 并附上它的进度；为每个 step 建一个 NodeRun（`iterKey=''`）；把 cursor 设为第一个 step；同步锁定行（文本为 `【SOP】<title>`）；推送事件。
- `nextStage`：已有 `pendingToken` 时返回 Fail（写明"先等副 AI 交证据 / 先审核"）；cursor 节点状态是 `pending` 或 `redo` 时生成令牌，节点改成 `dispatched`、`attempts += 1`；`taskHint` 是一段可以照抄的 Task 调用说明，prompt 第一行必须是 `[<token>] <title>`。
- `submit`：令牌必须是 `pendingToken`，节点状态是 `dispatched`，`agentId` 和绑定的一致；证据校验不通过就返回 Fail，列出所有错误（副 AI 看到后会修正再交）；通过以后保存 evidence 和 summary，节点改成 `submitted`。
- `review`：节点必须是 `submitted`；`accept` 时要先通过 `checkReview`，然后节点改成 done，清掉令牌，cursor 移到下一个 step，没有下一个就把运行标为 done；`redo` 时 `feedback` 必填，节点改成 `redo`，清掉令牌。
- 返工后重新派发的卡片要附上上一次的 feedback。
- 节点状态对应的锁定行状态：`pending`→pending，`dispatched|submitted|redo`→in_progress，`done`→done，`failed`→failed。
- 每次状态变化都要推送 `workflow.run.updated`。

- [ ] **Step 1: 写失败测试**（每个测试自己建 session、workflow，`afterEach` 只删这些行）
  - `start refuses a draft workflow`。
  - `start refuses when the session already has an active run`（Review Focus 5）：错误信息里有现有运行的名字和当前阶段。
  - `happy path a→b`：nextStage → bindAgent（prompt 含令牌）→ submit → review accept → nextStage 拿到 b → … → 运行 done；`approvalBlock` 在运行 done 之前不为空，done 以后为空。
  - `nextStage refuses while a token is outstanding`。
  - `submit rejects a token bound to another agent`（Review Focus 2）。
  - `submit returns all evidence errors`。
  - `accept without verdicts for every criterion fails`。
  - `redo invalidates the old token and the next card carries feedback`（Review Focus 3）：旧令牌再 submit 返回 Fail；新令牌 `bindAgent` 返回的卡片包含 feedback 原文。
  - `onSubagentStop reminds twice then marks redo`。
  - `locked plan rows mirror node statuses`。
- [ ] **Step 2–4:** 先跑一遍确认失败 → 实现 → 再跑确认通过。
- [ ] **Step 5:** Commit。

### Task 6: 阶段卡片 / 审核对照表 / 进度文字

**Files:**
- Create: `apps/server/src/workflow/card.ts`
- Test: `apps/server/src/workflow/card.test.ts`

**Interfaces — Produces：**
```ts
export function stageOutputDir(sessionId: string, runId: string, nodeId: string, iterKey: string): string; // <sandbox>/wf/<runId>/<nodeId>/<iterKey||'_'>
export function renderStageCard(a: { run: WorkflowRunDTO; node: WorkflowNodeDef; nodeRun: WorkflowNodeRunDTO; token: string; outputDir: string; upstream: { node: WorkflowNodeDef; nodeRun: WorkflowNodeRunDTO; outputDir: string }[]; lastFeedback?: string | null; mainNote?: string | null; recall?: string | null }): string;
export function renderReviewSheet(node: WorkflowNodeDef, nodeRun: WorkflowNodeRunDTO): string;
export function renderProgress(run: WorkflowRunDTO): string; // 一行：「BI SOP · 阶段 2/5「…」· 待审核」
```
卡片的段落顺序照 spec 5.2 / 5.3：标题行（`[工作流] <workflow> · 阶段 i/n「title」· 令牌 <token>`）→ `── SOP 原文 ──` + instructions 原文 → `── 输入 ──`（上游 evidence 的 JSON 摘要，每个最多 1500 字，加上上游产出目录的绝对路径）→ `── 产出目录 ──` → `── 完成标准 ──`（编号）→ `── 完成时调用 mcp__chapi__workflow_submit_stage ──`（token + 证据字段表：key / 类型 / 是否必填 / 说明）→ 有返工意见时加 `── 上次返工意见 ──` → 有主 AI 备注时加 `── 主 AI 备注 ──` → 有 recall 时附上 → 结尾一句纪律："只做本阶段；做完必须提交证据；不要做后续阶段的事"。
审核对照表：副 AI summary + 证据 JSON + 编号的完成标准 + 一段 `workflow_review_stage` 调用格式说明。

- [ ] **Step 1: 写失败测试**
  - `card contains instructions verbatim`：用一段 2000 字、带换行和 markdown 的 instructions，断言卡片里完整包含它。
  - `card lists upstream output dirs and evidence`。
  - `card includes feedback section only when given`。
  - `review sheet numbers every criterion`。
- [ ] **Step 2–4:** 先跑一遍确认失败 → 实现 → 再跑确认通过。
- [ ] **Step 5:** Commit。

### Task 7: 模型工具 + 审批门禁 + 系统提示

**Files:**
- Modify: `apps/server/src/engine/tools/chapiTools.ts`（加 5 个工具，名字加进 `CHAPI_TOOL_NAMES`；`request_approval` 先查 `workflowEngine.approvalBlock`）
- Modify: `apps/server/src/engine/systemPrompt.ts`（加一节"工作流（SOP）"，不超过 8 行：已确认 SOP 目录从参数传入；纪律是领取 → 派副 AI → 审核 → 再领取，不要自己做阶段里的活，不要转述 SOP 原文）
- Modify: `apps/server/src/engine/run.ts`（调用 `buildSystemPrompt` 前先查出已确认的目录，传进去）
- Modify: `apps/server/src/learning/learner.ts`（`isSystemInjected` 的正则加上 `工作流`）
- Test: `apps/server/src/learning/learner.test.ts`（加一条：`[工作流] x` 算系统注入）

**工具（handler 都只是转调 engine）：**
| 工具 | 参数 | 返回 |
|---|---|---|
| `workflow_start` | `workflow: string, label?: string, inputs?: record` | message，或者错误信息加上可用的 SOP 目录 |
| `workflow_next_stage` | 无 | 令牌 + taskHint |
| `workflow_submit_stage` | `token: string, evidence: record, summary: string` | 成功 / 错误清单（agentId 由 hook 用 `updatedInput` 注入一个隐藏字段 `_agentId`，见 Task 8） |
| `workflow_review_stage` | `decision: 'accept'|'redo', perCriterion: CriterionVerdict[], feedback?: string` | 结果加下一步提示 |
| `workflow_status` | 无 | `statusText` + 有待审核时附上 `reviewSheet` |

- [ ] **Step 1:** 写 learner 的失败测试，然后实现。
- [ ] **Step 2:** 加工具、改 `request_approval`、改系统提示。
- [ ] **Step 3:** `pnpm --filter @chapi/server typecheck` + `npx vitest run`。Expected：没有新增失败。
- [ ] **Step 4:** Commit。

### Task 8: Hooks（令牌校验、副 AI 绑定、催交、主 AI 提醒）

**Files:**
- Create: `apps/server/src/workflow/guards.ts`（纯判断，好测）
- Modify: `apps/server/src/engine/hooks.ts`
- Test: `apps/server/src/workflow/guards.test.ts`

**Interfaces — Produces（guards.ts）：**
```ts
export const TOKEN_RE = /\[(WF-[a-z0-9]{6})\]/;
export function extractToken(text: string): string | null;
/** 主 AI 调 Task/Agent 时：有活跃运行就要求 prompt 带 pendingToken；subagent_type 是 'Explore' 的放行。返回拒绝原因或 null。 */
export function decideTask(a: { run: WorkflowRunDTO | null; prompt: string; subagentType?: string }): string | null;
/** workflow_submit_stage：agentId 为空（主 AI）就拒绝；令牌不属于这个 agent 也拒绝。 */
export function decideSubmit(a: { agentId?: string; token: string; owner: { agentId: string | null; status: NodeRunStatus } | null }): string | null;
```
hooks.ts 接线：
- PreToolUse：
  - `Task` / `Agent` 且没有 `agent_id`：调 `decideTask`，有拒绝原因就返回 `{ hookSpecificOutput: { hookEventName:'PreToolUse', permissionDecision:'deny', permissionDecisionReason } }`。
  - `mcp__chapi__workflow_submit_stage`：调 `decideSubmit`；放行时用 `updatedInput` 把 `_agentId: agent_id` 加到参数里。
- SubagentStart：沿用现有的 `taskPrompts.shift()`，先调 `workflowEngine.bindAgent(sessionId, agent_id, task)`。返回了卡片就把卡片作为 `additionalContext`（卡片已经包含 recall，不再另外 recall）；否则走原来的 recall 逻辑。
- SubagentStop：先调 `workflowEngine.onSubagentStop`，有提醒文字就返回 `{ hookSpecificOutput: { hookEventName:'SubagentStop', additionalContext } }`（`stop_hook_active` 为 true 时也照样处理，次数由 engine 控制）。
- PostToolUse（主 AI，`Task`/`Agent`）：`reviewSheet` 不为空时，追加到 `additionalContext`。
- PostToolUse 每 15 次工具调用的提醒：有活跃运行时，换成 `renderProgress` 加上当前待办。
- Stop：有活跃运行时，先用 `turnEndReminder`，没有提醒再走原来的"进行中步骤"逻辑。

- [ ] **Step 1: 写失败测试（guards）**
  - `decideTask denies a Task without token when a run is active`，原因里包含"workflow_next_stage"。
  - `decideTask allows Explore`。
  - `decideTask allows anything when no run`。
  - `decideTask denies a stale token`。
  - `decideSubmit denies main agent`（Review Focus 1）。
  - `decideSubmit denies token owned by another agent`。
- [ ] **Step 2–4:** 先跑一遍确认失败 → 实现 → 再跑确认通过。
- [ ] **Step 5:** 接到 hooks.ts；`typecheck` + 全量 `vitest run`。
- [ ] **Step 6:** Commit。

### Task 9: API + 实时推送 + 左侧进度行

**Files:**
- Create: `apps/server/src/http/routes/workflows.ts`；Modify: `apps/server/src/http/app.ts`（注册）
- Modify: `apps/server/src/services/sessions.ts`（`getSessionDetail` 带上 `workflowRuns: WorkflowRunDTO[]`）、`packages/shared/src/api.ts`（对应类型）
- Modify: `apps/web/src/lib/store.ts`（`workflowRuns` 切片 + 处理 `workflow.run.updated`）、`apps/web/src/hooks/useSessionSocket.ts`（如果事件分发在这里）、`apps/web/src/components/MonitorCard.tsx`（任务流标题下面加一行进度：workflow 名 · 阶段 i/n「title」· 状态）
- Test: `apps/server/src/http/routes/workflows.test.ts`（Fastify `inject`）

**路由：**
- `GET /api/workflows` → `WorkflowSummaryDTO[]`
- `POST /api/workflows` body `{ name, slug?, aliases?, whenToUse?, graph, confirm?: boolean }`：用 `parseGraph` 校验，不通过返回 400 和 `errors`；`confirm:true` 时直接建 v1 并设为 confirmed。
- `GET /api/workflows/:idOrSlug` → 定义 + 版本
- `POST /api/sessions/:id/workflow-runs` body `{ workflow, label? }`：调用 `workflowEngine.start`，成功后往会话里推一条 `[工作流] 已启动「…」，请调用 workflow_next_stage 领取第一个阶段` 消息（走 `orchestrator.handleUserMessage`，算系统注入）。
- `GET /api/sessions/:id/workflow-runs` → `WorkflowRunDTO[]`

- [ ] **Step 1: 写失败测试**：POST 一个非法图返回 400，`errors` 不为空；POST 合法图且 `confirm:true` 后，GET 列表里能看到它，状态是 confirmed。
- [ ] **Step 2–4:** 先跑一遍确认失败 → 实现 → 再跑确认通过。
- [ ] **Step 5:** 前端改动 + `pnpm -r typecheck`。
- [ ] **Step 6:** Commit。

### Task 10: 测试实例端到端验证

**Files:** `apps/server/scripts/seed-demo-workflow.ts`（新，建一个 3 阶段的演示 workflow：统计沙盘某个文件的行数 → 写一句摘要 → 检查摘要，每个阶段都有证据字段）

- [ ] **Step 1:** 启动测试实例：后端 8125，前端 3103（`NEXT_PUBLIC_SERVER_URL=http://127.0.0.1:8125`）。健康检查：`curl 127.0.0.1:8125/api/health` 返回 `{"ok":true,"db":true}`。
- [ ] **Step 2:** 跑 seed；在测试前端新建会话，发"按演示 SOP 跑一遍"。
- [ ] **Step 3:** 核对：主 AI 调用了 `workflow_start` → `workflow_next_stage`；Task prompt 带令牌；副 AI 收到了卡片，并调用了 `workflow_submit_stage`；主 AI 调用 `workflow_review_stage` 时逐条给了判断；任务流锁定行依次完成；左侧显示进度；运行结束后 `request_approval` 才成功。
- [ ] **Step 4:** 故意测试：让主 AI"直接自己做完"（Task 被拒或 submit 被拒）；中途让主 AI 先 `request_approval`（被拒）。
- [ ] **Step 5:** 把结果和问题写进 plan 末尾的"验证记录"，Commit。

## 验证记录（2026-11-23，测试实例 8125 / chapi_wf，真模型）

- **E2E-1**：从聊天启动 → 领令牌 → 派副 AI → 副 AI 交证据 → 主 AI 逐条审核，各环节都正常；返工意见能带进新的阶段卡片。**发现**：Claude Code 不允许副 AI 用 Write 写 `.md` 报告文件，阶段 3 卡住了。主 AI 没有假装通过，结束前的提醒最多 2 次。
  → 用户选了方案 1：证据字段加 `saveAs`，由服务器写文件（提交 `feat(workflow): saveAs evidence fields`）。不绕开 Claude Code 的限制。
- **E2E-2**：3 个阶段 68 秒跑完，`summary.md` 由系统存好，主 AI 打开文件核对后才 `request_approval`，审批通过。
- **E2E-3（故意违规）**：要求主 AI 自己做阶段 1、自己提交、做完阶段 1 就交付。实际结果：`workflow_submit_stage` 被拒（只有副 AI 能提交）；`request_approval` 被拒（运行没走完）。之后主 AI 改为派副 AI 跑完全部阶段，再交付。
- 自动测试：server 全量 `vitest run` 全绿；`pnpm -r typecheck` 0 错误。
- **独立审查**：0 个严重问题，6 个重要问题（副 AI 绑错 prompt、同一令牌重复派发、无法取消、并发竞争、后台运行阶段、合入前要先迁移数据库），已全部修复并补测试；另有 17 个次要问题，修了 4 个，其余记录为后续再做。
- **E2E-4（修复后回归）**：3 个阶段 58 秒跑完，没有出现绑定失败，审批通过。
- 自动测试：server 194/194；`pnpm -r typecheck` 0 错误。
- **第二轮修复（4 项）**：(1) 没有阶段的 SOP 在校验时就被拒绝；(2) 同一会话开新运行时，旧运行的【SOP】步骤保留在前面；(3) SOP 只能由用户在 /workflows 页面确认（新建一律是草稿；确认接口只接受网页来源；主 AI 的命令行和脚本调确认接口、改数据库都会被拦）；(4) 副 AI 没交证据就想结束时被拦下继续干，已在真机上确认。
- **E2E-5**：让主 AI 自己用 curl 确认草稿 → 主 AI 直接拒绝，说必须由用户确认（命令行拦截这一层由单元测试覆盖）。
- **E2E-6**：让阶段 1 的副 AI "生成文件后直接结束、不要提交" → 服务器日志里出现两次 `nudged sub-agent`，第二次比第一次晚 7 秒，说明副 AI 被拦下后确实又跑了一轮；它仍然坚持不提交，被拦满 2 次后，系统自动把这个阶段标成返工；主 AI 用新令牌重新派副 AI，正常提交并完成全部阶段，审批通过。
- **页面确认**：测试网页 3103 → /workflows → 展开草稿 → 点"确认 v1" → 变成"已确认 v1"，显示 3 个阶段。
- 自动测试：server 203/203；typecheck 0 错误。
- **第四轮（子步骤、进度、请求匹配、对话改 SOP、SOP 页面细化）**：
  - E2E-7：发「帮我做一下名单统计」（没提 SOP 二字），主 AI 直接调用 workflow_start；副 AI 共标记子步骤 6 次；左侧面板显示工作流名、整体百分比、阶段进度色块、缩进的子步骤；72 秒完成并提交审批。
  - E2E-8：在对话里要求给阶段 3 加子步骤并把记忆改为纯工具 → 依次调用 workflow_get、workflow_edit、workflow_request_confirm → 聊天里弹出确认卡片（列出改动）→ 同意后 v3 生效。核对结果：SOP 原文和其他阶段与 v2 完全相同。
  - SOP 页面：每个阶段都显示记忆模式、子步骤、完成标准、证据字段、输入输出和 SOP 原文。
  - 自动测试：server 全绿；typecheck 0。
- **第五轮（可视化流程图、聊天运行卡片、阶段详情、左侧精简）**：同一对话连跑 3 次（E2E-9/10/11），流程图把 3 次运行串成一条链；节点用 App 图标（Sheets 等）显示进度环和百分比，连线实时填充，当前阶段有流动的小圆点；视图以当前阶段为中心（缩放不低于 80- **第五轮（可视化流程图 / 聊天运行卡片 / 阶段详情 / 左侧精简）**：同一对话连跑 3 次（E2E-9/10/11），流程图把 3 次运行串成一条链；节点用 App 图标（Sheets 等）显示进度环和百分比，连线实时填充，当前阶段有流动的小圆点；视图以当前阶段为中心（缩放不低于 80 percent）；点节点打开阶段详情（子步骤及备注、总结、证据、逐条审核）；聊天运行卡片的“查看流程”能跳到对应运行；白天、夜间模式都截图检查过。server 232/232，typecheck 0。新依赖：@xyflow/react 12.12.1（web）。

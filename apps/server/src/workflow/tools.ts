import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { emitAttention } from '../engine/attention.js';
import { hitl } from '../engine/hitl.js';
import type { WorkflowGraph } from '@chapi/shared';
import { applyOps, confirmLatestDraft, createDraftWorkflow, draftChanges, findWorkflowRef, saveDraft, workingVersion, type StageOp } from './drafts.js';
import { workflowEngine } from './engine.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/** Tool names the workflow adds to the chapi MCP server. */
export const WORKFLOW_TOOL_NAMES = [
  'mcp__chapi__workflow_start',
  'mcp__chapi__workflow_next_stage',
  'mcp__chapi__workflow_submit_stage',
  'mcp__chapi__workflow_review_stage',
  'mcp__chapi__workflow_status',
  'mcp__chapi__workflow_substep',
  'mcp__chapi__workflow_get',
  'mcp__chapi__workflow_edit',
  'mcp__chapi__workflow_create',
  'mcp__chapi__workflow_request_confirm',
];
export const SUBMIT_TOOL = 'mcp__chapi__workflow_submit_stage';
export const SUBSTEP_TOOL = 'mcp__chapi__workflow_substep';

/** Workflow tools for one session (closure-bound like the rest of chapiTools). */
export function buildWorkflowTools(sessionId: string) {
  const start = tool(
    'workflow_start',
    '按一份**已确认的 SOP** 启动工作流运行（系统提示里的「已确认 SOP 目录」）。用户的请求对应某份 SOP 时必须用它，不要自己 set_plan。启动后任务流由系统按 SOP 生成并锁定。',
    {
      workflow: z.string().describe('SOP 的 workflow 标识（目录里的 workflow="…"）、名称或别名'),
      label: z.string().optional().describe('这次运行的标签，如 "MF Summit 12/1"'),
      inputs: z.record(z.unknown()).optional().describe('初始输入，如 { attendee_list: "沙盘绝对路径或 Sheet 链接" }'),
    },
    async (args) => {
      const r = await workflowEngine.start(sessionId, { workflow: args.workflow, label: args.label, inputs: args.inputs, trigger: 'chat' });
      return text(r.ok ? r.message : r.error);
    },
  );

  const nextStage = tool(
    'workflow_next_stage',
    '领取工作流的下一个阶段：返回派发令牌和 Task 写法。拿到后**立刻**用 Task 派副 AI（prompt 第一行原样写令牌）。同一时间只有一个阶段在执行。',
    {
      force: z.boolean().optional().describe('仅当已派发的副 AI 异常结束、不会再提交时用 true：作废旧令牌重新派发'),
    },
    async (args) => {
      const r = await workflowEngine.nextStage(sessionId, { force: args.force });
      return text(r.ok ? `令牌：${r.token}\n阶段：${r.title}\n${r.taskHint}` : r.error);
    },
  );

  const submitStage = tool(
    'workflow_submit_stage',
    '【只给执行阶段的副 AI 用】提交本阶段的证据。字段见阶段卡片。证据不完整会被退回，按错误修正后重新提交。',
    {
      token: z.string().describe('阶段卡片里的令牌，如 WF-ab12cd'),
      evidence: z.record(z.unknown()).describe('证据字段 → 值（按阶段卡片的字段表）'),
      summary: z.string().describe('一段话：做了什么、结果、异常'),
      _agentId: z.string().optional().describe('系统自动填写，不要填'),
    },
    async (args) => {
      const r = await workflowEngine.submit(sessionId, {
        token: args.token.trim(),
        agentId: args._agentId ?? '',
        evidence: args.evidence,
        summary: args.summary,
      });
      return text(r.ok ? r.message : r.error);
    },
  );

  const reviewStage = tool(
    'workflow_review_stage',
    '审核副 AI 刚提交的阶段：对照完成标准**逐条**判断（必要时先打开产出目录抽查文件）。通过 → 进入下一阶段；返工 → 写清 feedback 后重新派发。',
    {
      decision: z.enum(['accept', 'redo']),
      perCriterion: z
        .array(
          z.object({
            criterion: z.string().describe('完成标准原文或 "第N条"'),
            verdict: z.enum(['met', 'na']).describe('met=满足；na=本次不适用'),
            reason: z.string().describe('判断依据（看了哪个证据/文件）'),
          }),
        )
        .optional()
        .describe('accept 时必须覆盖每一条完成标准；redo 时可省略'),
      feedback: z.string().optional().describe('redo 时必填：哪里不达标、要怎么补'),
    },
    async (args) => {
      const r = await workflowEngine.review(sessionId, { decision: args.decision, perCriterion: args.perCriterion, feedback: args.feedback });
      return text(r.ok ? r.message : r.error);
    },
  );

  const status = tool(
    'workflow_status',
    '查看本会话工作流运行的进度；有待审核的阶段时附上审核对照表（证据 + 完成标准）。',
    {},
    async () => {
      const [s, sheet] = await Promise.all([workflowEngine.statusText(sessionId), workflowEngine.reviewSheet(sessionId)]);
      return text(sheet ? `${s}\n\n${sheet}` : s);
    },
  );

  const substep = tool(
    'workflow_substep',
    '【只给执行阶段的副 AI 用】标记本阶段的一个子步骤：做完一步立刻标 done；确实不适用的标 na 并写原因。全部子步骤标记后才能提交证据。',
    {
      token: z.string().describe('阶段卡片里的令牌'),
      substep: z.string().describe('子步骤 id（卡片里方括号中的，如 s1）'),
      status: z.enum(['done', 'na']),
      note: z.string().optional().describe('na 时必填：为什么不适用；done 时可写一句结果'),
      _agentId: z.string().optional().describe('系统自动填写，不要填'),
    },
    async (args) => {
      const r = await workflowEngine.substep(sessionId, {
        token: args.token.trim(),
        agentId: args._agentId ?? '',
        substep: args.substep.trim(),
        status: args.status,
        note: args.note,
      });
      return text(r.ok ? r.message : r.error);
    },
  );

  const get = tool(
    'workflow_get',
    '读取一份 SOP 的定义（默认读正在编辑的版本：有草稿读草稿，否则读已确认版本）。不传 stage 返回每个阶段的概要；传 stage 返回该阶段的完整内容（含 SOP 原文）。修改 SOP 前先读。',
    {
      workflow: z.string().describe('SOP 的 workflow 标识、名称或别名'),
      stage: z.string().optional().describe('阶段 id，取该阶段完整内容'),
    },
    async (args) => {
      const w = await findWorkflowRef(args.workflow);
      if (!w) return text(`找不到 SOP「${args.workflow}」。`);
      const v = workingVersion(w);
      if (!v) return text('这份 SOP 没有任何版本。');
      const g = v.graph as unknown as WorkflowGraph;
      const steps = g.nodes.filter((n) => n.type === 'step');
      if (args.stage) {
        const n = steps.find((s) => s.id === args.stage);
        return text(n ? JSON.stringify(n, null, 2) : `没有阶段「${args.stage}」。阶段：${steps.map((s) => s.id).join('、')}`);
      }
      const head = `「${w.name}」(workflow="${w.slug}") · 正在编辑 v${v.version}（${v.state}）· 已确认 v${w.confirmedVersion ?? '无'}`;
      const outline = steps.map(
        (n, i) =>
          `${i + 1}. [${n.id}] ${n.title} · 记忆=${n.memory ?? 'skills'}
` +
          `   子步骤：${(n.substeps ?? []).map((s) => `${s.id} ${s.title}`).join('；') || '无'}
` +
          `   完成标准：${(n.doneCriteria ?? []).join('；')}
` +
          `   证据：${(n.evidence ?? []).map((f) => `${f.key}(${f.type})`).join('、')}
` +
          `   原文开头：${(n.instructions ?? '').split('【本阶段】').pop()!.trim().slice(0, 160).replace(/\s+/g, ' ')}…`,
      );
      return text([head, `别名：${((w.aliases as string[] | null) ?? []).join(' / ') || '无'}`, `何时用：${w.whenToUse ?? ''}`, ...outline].join('\n'));
    },
  );

  const edit = tool(
    'workflow_edit',
    '按用户的要求修改一份 SOP，结果存为草稿（已确认的 SOP 会生成新的草稿版本，确认前仍按旧版本运行）。改完调用 workflow_request_confirm 请用户确认。' +
      'ops 每项是：{op:"update_stage", stage:"阶段id", set:{title|instructions|substeps|doneCriteria|evidence|memory|inputs|outputs 中要改的字段}}，' +
      '或 {op:"insert_stage", after:"阶段id 或 start", stage:{完整阶段定义}}，或 {op:"remove_stage", stage:"阶段id"}。instructions 要保留 SOP 原文，只改用户要求改的部分。',
    {
      workflow: z.string(),
      ops: z.array(z.record(z.unknown())).optional().describe('阶段级修改，按顺序执行'),
      aliases: z.array(z.string()).optional(),
      whenToUse: z.string().optional(),
      note: z.string().describe('这次改了什么（一句话，给用户确认时看）'),
    },
    async (args) => {
      const w = await findWorkflowRef(args.workflow);
      if (!w) return text(`找不到 SOP「${args.workflow}」。`);
      const v = workingVersion(w);
      if (!v) return text('这份 SOP 没有任何版本。');
      let graph = v.graph as unknown as WorkflowGraph;
      if (args.ops?.length) {
        const r = applyOps(graph, args.ops as unknown as StageOp[]);
        if (!r.ok) return text(`修改没有保存，请修正：\n${r.errors.map((e) => `- ${e}`).join('\n')}`);
        graph = r.graph;
      }
      const saved = await saveDraft(w.slug, graph, { note: args.note, aliases: args.aliases, whenToUse: args.whenToUse }, 'ai');
      if (!saved.ok) return text(`修改没有保存：${saved.errors.join('；')}`);
      const fresh = await findWorkflowRef(w.slug);
      const changes = fresh ? draftChanges(fresh) : null;
      return text(
        `已存为「${w.name}」草稿 v${saved.version}。相对已确认版本的改动：\n${(changes ?? []).map((c) => `- ${c}`).join('\n') || '- （无阶段级改动）'}\n` +
          '现在调用 workflow_request_confirm 请用户确认；用户确认前，运行仍按已确认版本。',
      );
    },
  );

  const create = tool(
    'workflow_create',
    '把一份新的 SOP 建成 workflow 草稿（用户确认后才能运行）。每个阶段的 instructions 必须是 SOP 原文；每个阶段要有完成标准、证据字段，动作较多的阶段拆出 substeps，判断/分类/核对类阶段 memory 设为 none。',
    {
      name: z.string(),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
      aliases: z.array(z.string()).optional(),
      whenToUse: z.string(),
      sourceRef: z.string().optional().describe('SOP 文档路径或链接'),
      graph: z.record(z.unknown()).describe('{nodes:[start, 阶段…, end], edges:[顺序连线]}'),
    },
    async (args) => {
      const r = await createDraftWorkflow({ ...args, graph: args.graph });
      return text(r.ok ? `已建草稿「${args.name}」(workflow="${r.slug}")。现在调用 workflow_request_confirm 请用户确认。` : `没有建成，请修正：\n${r.errors.map((e) => `- ${e}`).join('\n')}`);
    },
  );

  const requestConfirm = tool(
    'workflow_request_confirm',
    '请用户确认一份 SOP 的草稿：在对话里弹出确认卡片（列出改动），用户点同意后草稿生效。只有用户能确认，你不能代为确认。',
    {
      workflow: z.string(),
      summary: z.string().describe('一两句话说明这次改了什么、为什么'),
    },
    async (args) => {
      const w = await findWorkflowRef(args.workflow);
      if (!w) return text(`找不到 SOP「${args.workflow}」。`);
      const changes = draftChanges(w);
      if (!changes) return text('这份 SOP 没有待确认的草稿。');
      const draftV = Math.max(...w.versions.filter((v) => v.state === 'draft').map((v) => v.version));
      const summary = [
        `确认 SOP「${w.name}」v${draftV}${w.confirmedVersion ? `（替换 v${w.confirmedVersion}）` : '（首次确认）'}`,
        args.summary.trim(),
        '改动：',
        ...changes.map((c) => `- ${c}`),
      ].join('\n');
      const artifacts = [{ id: `wf-${w.slug}`, sessionId, kind: 'doc' as const, title: `在 SOP 页面查看「${w.name}」`, pathOrUrl: `http://127.0.0.1:${config.webPort}/workflows`, createdAt: new Date().toISOString() }];
      const approval = await prisma.approval.create({ data: { sessionId, summary, artifacts: artifacts as unknown as object, status: 'open' } });
      bus.emit({
        type: 'approval.request',
        sessionId,
        approval: { id: approval.id, sessionId, summary, artifacts, status: 'open', feedback: null, createdAt: approval.createdAt.toISOString() },
      });
      void emitAttention(sessionId, 'approval', `确认 SOP「${w.name}」`);
      const decision = await hitl.waitForApproval(approval.id, sessionId);
      if (decision.decision !== 'approve') return text(`用户没有确认（${decision.decision}）：${decision.feedback?.trim() || '没有留言'}。按用户意见继续修改，或保持草稿。`);
      const r = await confirmLatestDraft(w.slug);
      return text(r.ok ? `用户已确认，「${w.name}」v${draftV} 生效。之后按它运行。` : `确认失败：${r.errors.join('；')}`);
    },
  );

  return [start, nextStage, submitStage, reviewStage, status, substep, get, edit, create, requestConfirm];
}

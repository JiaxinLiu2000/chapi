import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { KNOWLEDGE_KIND_LABEL, KNOWLEDGE_SECTION_LABEL, type ArtifactDTO, type ArtifactKind, type EmailVerifyResult, type PlanTaskStatus } from '@chapi/shared';
import { sessionPaths } from '../../config.js';
import { prisma } from '../../db/client.js';
import { bus } from '../../gateway/bus.js';
import { toArtifactDTO, toPendingQuestionDTO, toPlanTaskDTO } from '../../mappers.js';
import { readWikiEntry, searchKnowledge, writeWikiEntry } from '../../rag/wiki.js';
import { formatPoint } from '../../knowledge/recall.js';
import { scoreDataSources } from '../../learning/learner.js';
import { pdfEdit } from '../../tools/pdf.js';
import { emailVerifier } from '../../tools/emailVerify.js';
import { siteRecon } from '../../tools/siteRecon.js';
import { formatScoredClaim, scoreClaim, type ClaimInput } from '../../tools/confidence.js';
import { hitl } from '../hitl.js';
import { scheduler } from '../scheduler.js';
import { qualityAdvisor, setQualityCadence } from '../quality.js';
import { formatPlan, openSteps, setPlan as writePlan, updatePlanStep as writePlanStep, type PlanInput } from '../plan.js';
import { recallBlock } from '../../knowledge/recall.js';
import { emitAttention } from '../attention.js';
import { WORKFLOW_TOOL_NAMES, buildWorkflowTools } from '../../workflow/tools.js';
import { BOARD_TOOL_NAMES, buildBoardTools } from '../../board/tools.js';
import { workflowEngine } from '../../workflow/engine.js';
import { setPlanBounce } from '../../workflow/routing.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/** Plan steps that are the hand-over itself (submitting for approval / delivering). */
const APPROVAL_STEP = /审批|提交|交付|approval|review|deliver|submit/i;

/** One line per address: verdict + only the flags that explain it. */
function formatEmailResult(r: EmailVerifyResult): string {
  const flags = [
    !r.syntaxValid && '语法无效',
    r.suggestion && `疑似拼写错误→${r.suggestion}`,
    r.mxAcceptsMail === false && '域名不存在/无MX',
    r.deliverable === true && '可投递',
    r.deliverable === false && r.canConnectSmtp && '收件箱不存在',
    r.catchAll && 'catch-all(全收,无法确认)',
    r.fullInbox && '收件箱已满',
    r.disabled && '账号已停用',
    r.disposable && '一次性/仿冒拼写域名',
    r.roleAccount && '角色邮箱(info@/sales@等)',
    r.free && '免费邮箱',
    r.error && `SMTP未验证: ${r.error.slice(0, 120)}`,
  ].filter(Boolean);
  return `${r.email} → ${r.status}${flags.length ? `（${flags.join('；')}）` : ''}`;
}

/** Tool names exposed to the model (server name "chapi"). */
export const CHAPI_TOOL_NAMES = [
  'mcp__chapi__ask_user',
  'mcp__chapi__request_approval',
  'mcp__chapi__notify_user',
  'mcp__chapi__save_artifact',
  'mcp__chapi__wiki_search',
  'mcp__chapi__wiki_write',
  'mcp__chapi__pdf_edit',
  'mcp__chapi__set_plan',
  'mcp__chapi__update_plan_step',
  'mcp__chapi__schedule_task',
  'mcp__chapi__schedule_quality_review',
  'mcp__chapi__get_current_time',
  'mcp__chapi__verify_email',
  'mcp__chapi__site_recon',
  'mcp__chapi__rate_sources',
  'mcp__chapi__wiki_read',
  ...WORKFLOW_TOOL_NAMES,
  ...BOARD_TOOL_NAMES,
];

/**
 * Build the in-process MCP server for one session. Tools are closure-bound to
 * the sessionId so each Run gets its own instance.
 */
export function buildChapiToolServer(sessionId: string) {
  const askUser = tool(
    'ask_user',
    '向用户提问并阻塞等待回答。遇到任何不确定/需要决策的问题时调用。返回用户的回答文本。',
    {
      question: z.string().describe('要问用户的问题（清晰、具体）'),
      options: z.array(z.string()).optional().describe('可选项；提供时用户从中选择'),
    },
    async (args) => {
      const q = await prisma.pendingQuestion.create({
        data: {
          sessionId,
          question: args.question,
          options: args.options ? (args.options as unknown as object) : undefined,
          status: 'open',
        },
      });
      bus.emit({ type: 'question.open', sessionId, question: toPendingQuestionDTO(q) });
      bus.emit({
        type: 'notification',
        sessionId,
        level: 'question',
        title: 'AI 需要你的输入',
        body: args.question,
      });
      void emitAttention(sessionId, 'question', args.question);
      const answer = await hitl.waitForQuestion(q.id, sessionId);
      return text(answer);
    },
  );

  const requestApproval = tool(
    'request_approval',
    '把完成的成果提交给用户审批。返回用户的决定(approve/revise/reject)与反馈。收到 revise/reject 时应按反馈继续修改后再次提交。',
    {
      summary: z.string().describe('成果摘要'),
      artifacts: z
        .array(
          z.object({
            kind: z.string().describe('file|drive|sheet|doc|draft|pdf'),
            title: z.string(),
            pathOrUrl: z.string().describe('Google Drive 链接或沙盘内绝对路径'),
          }),
        )
        .optional(),
    },
    async (args) => {
      // A running SOP must reach its end (every stage reviewed) before delivery.
      const wfBlock = await workflowEngine.approvalBlock(sessionId).catch(() => null);
      if (wfBlock) return text(wfBlock);
      // The task flow must reflect reality before anything is handed over.
      // The hand-over step itself ("提交审批", "交付…") can only finish by submitting — don't block on it.
      const handOver = (t: { text: string }) => APPROVAL_STEP.test(t.text);
      const open = (await openSteps(sessionId)).filter((t) => !handOver(t));
      if (open.length) {
        return text(
          `还不能提交审批：任务流里还有 ${open.length} 个步骤没有收尾——\n${open.map((t) => `- [${t.status}] ${t.text}`).join('\n')}\n请先用 update_plan_step 把每一步标成 done / failed / blocked / replaced（后三种写 reason），再调用 request_approval。`,
        );
      }
      // Pre-delivery gate: an independent 质检 look before the user sees anything.
      const gate = await qualityAdvisor.gate(
        sessionId,
        args.summary,
        (args.artifacts ?? []).map((a) => `- ${a.kind}「${a.title}」${a.pathOrUrl}`),
      );
      if (gate.block) return text(gate.agentText ?? '交付前质检未通过，请修正后再提交。');
      const summary = gate.userNote ? `${args.summary}\n\n${gate.userNote}` : args.summary;
      const artifacts: ArtifactDTO[] = (args.artifacts ?? []).map((a) => ({
        id: randomUUID(),
        sessionId,
        kind: a.kind as ArtifactKind,
        title: a.title,
        pathOrUrl: a.pathOrUrl,
        createdAt: new Date().toISOString(),
      }));
      const approval = await prisma.approval.create({
        data: {
          sessionId,
          summary,
          artifacts: artifacts as unknown as object,
          status: 'open',
        },
      });
      bus.emit({
        type: 'approval.request',
        sessionId,
        approval: {
          id: approval.id,
          sessionId,
          summary,
          artifacts,
          status: 'open',
          feedback: null,
          createdAt: approval.createdAt.toISOString(),
        },
      });
      bus.emit({
        type: 'notification',
        sessionId,
        level: 'success',
        title: '成果待审批',
        body: args.summary,
      });
      void emitAttention(sessionId, 'approval', args.summary);
      const decision = await hitl.waitForApproval(approval.id, sessionId);
      if (decision.decision === 'approve') {
        // Approved → the open hand-over steps are done.
        for (const t of (await openSteps(sessionId)).filter(handOver)) {
          await writePlanStep(sessionId, { step: t.text, status: 'done' }).catch(() => undefined);
        }
      }
      return text(
        `decision=${decision.decision}; feedback=${decision.feedback?.trim() || '(none)'}`,
      );
    },
  );

  const notifyUser = tool(
    'notify_user',
    '向用户推送一条通知（不阻塞）。用于进度提醒或完成提示。',
    {
      title: z.string(),
      body: z.string(),
      level: z.enum(['info', 'success', 'error']).optional(),
    },
    async (args) => {
      bus.emit({
        type: 'notification',
        sessionId,
        level: args.level ?? 'info',
        title: args.title,
        body: args.body,
      });
      void emitAttention(sessionId, 'notify', `${args.title}: ${args.body}`);
      return text('ok');
    },
  );

  const saveArtifact = tool(
    'save_artifact',
    '登记一个交付物（文件/Drive 链接/Sheet/Doc/草稿/PDF），会展示给用户。优先使用 Google Drive 链接。',
    {
      kind: z.string().describe('file|drive|sheet|doc|draft|pdf'),
      title: z.string(),
      pathOrUrl: z.string(),
    },
    async (args) => {
      const row = await prisma.artifact.create({
        data: {
          sessionId,
          kind: args.kind,
          title: args.title,
          pathOrUrl: args.pathOrUrl,
        },
      });
      bus.emit({ type: 'artifact.ready', sessionId, artifact: toArtifactDTO(row) });
      return text(`saved artifact ${row.id}`);
    },
  );

  const KIND = z.enum(['data', 'skill', 'preference']);

  const wikiSearch = tool(
    'wiki_search',
    '检索知识图谱（Obsidian 知识库）。知识点分三类：data(数据，带置信度/来源/时间)、skill(技能/工具用法，带权重)、preference(用户偏好，带权重和正负)。返回**相关**的知识点，按权重/置信度从高到低。规划前、开始陌生子任务前、遇到问题时、交付前（查偏好）都应先查。',
    {
      query: z.string(),
      kind: KIND.optional().describe('只查某一类'),
      k: z.number().int().min(1).max(20).optional(),
    },
    async (args) => {
      const hits = await searchKnowledge(args.query, { kind: args.kind, k: args.k ?? 8 });
      if (hits.length === 0) return text('（知识图谱中暂无相关知识点）');
      return text(`${hits.map((h) => formatPoint(h.entry, 400)).join('\n')}\n\n需要全文、来源或相关条目时用 wiki_read(标题)。`);
    },
  );

  const wikiRead = tool(
    'wiki_read',
    '读取一个知识点全文（按标题/别名/id）：类型、权重/置信度、前提与方案、来源、变更历史、链接与反向链接，便于顺着 `[[双链]]` 看相关知识。不传 key（或传 "目录"）返回按类型列出的全部知识点（按权重排序）。',
    {
      key: z.string().optional().describe('知识点标题、别名或 id；留空 = 目录'),
    },
    async (args) => {
      const key = (args.key ?? '').trim();
      if (!key || key === '目录' || key.toLowerCase() === 'index') {
        // By content category first (the primary grouping), then kind; strongest first.
        const rows = await prisma.wikiEntry.findMany({ orderBy: { score: 'desc' } });
        const groups = new Map<string, typeof rows>();
        for (const r of rows) {
          const t = ((r.topics as string[] | null) ?? [])[0] || '未分类';
          groups.set(t, [...(groups.get(t) ?? []), r]);
        }
        const out = [...groups.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .map(
            ([t, list]) =>
              `## ${t}（${list.length}）\n${list
                .map((r) => `- [${KNOWLEDGE_KIND_LABEL[(r.kind as 'skill') ?? 'skill']}·${r.kind === 'data' ? '置信度' : '权重'}${r.score}] ${r.title}`)
                .join('\n')}`,
          );
        return text(out.join('\n\n') || '（知识图谱为空）');
      }
      const r = await readWikiEntry(key);
      if (!r) return text(`没有找到知识点「${key}」。可先 wiki_search，或不带 key 调用查看目录。`);
      const e = r.entry;
      const [l1, l2] = KNOWLEDGE_SECTION_LABEL[e.kind];
      return text(
        [
          `# ${e.title}`,
          `分类：${e.topics.join('、') || '未分类'} · 类型：${KNOWLEDGE_KIND_LABEL[e.kind]} · ${e.kind === 'data' ? '置信度' : '权重'} ${e.score}${e.kind === 'preference' ? ` · ${e.polarity === 'negative' ? '负面（避免）' : '正面（期望）'}` : ''}${e.observedAt ? ` · 数据时间 ${e.observedAt.slice(0, 10)}` : ''} · 标签：${e.tags.join(', ') || '(无)'}`,
          e.aliases.length ? `别名/问法：${e.aliases.join(' | ')}` : '',
          `## ${l1}\n${e.situation || '(未填写)'}`,
          `## ${l2}\n${e.solution || '(未填写)'}`,
          e.bodyMd ? `## 备注\n${e.bodyMd}` : '',
          `来源：\n${e.sourceRefs.map((x) => `- ${x.kind}: ${x.ref}${x.date ? ` (${x.date})` : ''}${typeof x.confidence === 'number' ? ` 置信度${x.confidence}` : ''}${x.note ? ` — ${x.note}` : ''}`).join('\n') || '(无)'}`,
          e.history.length ? `变更历史：\n${e.history.slice(-6).map((h) => `- ${h.at.slice(0, 10)} ${h.op}${h.delta ? ` ${h.delta > 0 ? '+' : ''}${h.delta}` : ''}${h.note ? `：${h.note}` : ''}`).join('\n')}` : '',
          `链接到：${r.links.join('；') || '(无)'}`,
          `被以下知识点引用（backlinks）：${r.backlinks.join('；') || '(无)'}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  );

  const wikiWrite = tool(
    'wiki_write',
    '主动记录一个**原子**知识点到知识图谱（平时学习代理会自动学习；只有你明确知道某条值得记时才手动写）。一次只写一件事；同标题会更新已有知识点（skill/preference 权重 +1）。data 必须给 sources（URL/文件路径/"user"），系统按来源可靠度和新鲜度算置信度。',
    {
      kind: KIND,
      title: z.string().describe('简洁具体，不要用 \\ / : * ? " < > | # ^ [ ]'),
      categories: z
        .array(z.string())
        .min(1)
        .max(3)
        .describe('内容分类 1~3 个（哪个网站/项目/客户/工具/领域），最重要的放第一个；优先用已有分类（wiki_read() 目录里能看到）'),
      situation: z.string().describe('情况/前提（data：数据对象与口径）'),
      solution: z.string().describe('方案（data：数据内容；preference：期望/避免的做法）'),
      tags: z.array(z.string()).optional().describe('skill=工具标签；preference=场景标签；data=主题标签'),
      polarity: z.enum(['positive', 'negative']).optional().describe('preference：希望这样(positive)/不要这样(negative)'),
      sources: z
        .array(z.object({ url: z.string(), title: z.string().optional(), publishedAt: z.string().optional(), tier: z.string().optional() }))
        .optional(),
      volatility: z.enum(['fast', 'medium', 'slow']).optional().describe('data：变化速度（决定新鲜度半衰期）'),
      observedAt: z.string().optional().describe('data：数据时间 YYYY-MM-DD'),
      links: z.array(z.string()).optional().describe('相关的已有知识点标题（写成 [[双链]]）'),
      notes: z.string().optional().describe('补充细节/示例（Markdown）'),
    },
    async (args) => {
      const existing = await prisma.wikiEntry.findFirst({ where: { title: args.title } });
      const common = {
        title: args.title,
        kind: args.kind,
        topics: args.categories,
        situation: args.situation,
        solution: args.solution,
        tags: args.tags,
        links: args.links,
        ...(args.notes !== undefined ? { body: args.notes } : {}),
      };
      let entry;
      if (args.kind === 'data') {
        const { refs, score } = scoreDataSources(args.sources?.length ? args.sources : [{ url: 'user' }], args.volatility);
        entry = await writeWikiEntry({
          ...common,
          sourceRefs: refs,
          score,
          observedAt: args.observedAt && !Number.isNaN(Date.parse(args.observedAt)) ? new Date(args.observedAt) : new Date(),
          history: { op: existing ? 'update' : 'create', note: '主代理手动记录', sessionId },
        });
      } else {
        entry = await writeWikiEntry({
          ...common,
          polarity: args.kind === 'preference' ? (args.polarity ?? 'positive') : '',
          score: existing ? Math.min(100, existing.score + 1) : 50,
          history: { op: existing ? 'reinforce' : 'create', ...(existing ? { delta: 1 } : {}), note: '主代理手动记录', sessionId },
        });
      }
      return text(`已记录 ${KNOWLEDGE_KIND_LABEL[entry.kind]}知识点「${entry.title}」（${entry.kind === 'data' ? '置信度' : '权重'} ${entry.score}）→ ${entry.relPath}`);
    },
  );

  const pdfEditTool = tool(
    'pdf_edit',
    '本地编辑现有 PDF（在沙盘内）。op=info 查看字段/文本；op=replace-text 用 data 做{原文:新文}文字替换；op=fill-form 填 AcroForm 表单字段。路径相对会话沙盘。',
    {
      op: z.enum(['info', 'replace-text', 'fill-form']),
      input: z.string().describe('输入 PDF 路径（相对沙盘）'),
      output: z.string().optional().describe('输出 PDF 路径（replace-text/fill-form 用）'),
      data: z
        .record(z.string())
        .optional()
        .describe('replace-text: {原文:新文}; fill-form: {字段名:值}'),
    },
    async (args) => {
      const r = await pdfEdit(sessionId, args);
      return text(r.ok ? r.stdout.trim() || 'ok' : `PDF 工具失败: ${r.stderr.trim()}`);
    },
  );

  const STATUS = z.enum(['pending', 'in_progress', 'done', 'failed', 'problem', 'replaced', 'blocked']);

  const setPlan = tool(
    'set_plan',
    '创建/重排整个任务流（前端左侧实时展示）。**无论任务大小都先建一个清单**（哪怕 2-3 步）；用户开始新任务时整体重建。同文本的步骤会保留其状态与计时。**推进中改单个步骤的状态请用 `update_plan_step`**（更省、不易写错）。状态: pending|in_progress|done|problem|failed|replaced|blocked；problem/failed/blocked/replaced 要写 reason；新步骤替换旧步骤时写 replaces=旧步骤原文。',
    {
      tasks: z
        .array(
          z.object({
            text: z.string(),
            status: STATUS.optional(),
            reason: z.string().optional().describe('problem/failed/blocked/replaced 的原因'),
            replaces: z.string().optional().describe('此步骤替换的旧步骤原文（换方案时）'),
          }),
        )
        .describe('完整、有序的任务列表（含要划线保留的 replaced 步骤）'),
    },
    async (args) => {
      const bounce = await setPlanBounce(sessionId).catch(() => null);
      if (bounce) return text(bounce);
      const { plan } = await writePlan(sessionId, args.tasks as PlanInput[]);
      const recall = await recallBlock(plan.map((t) => t.text).join('\n'), {
        heading: '[知识图谱·与这些步骤相关的经验/偏好/数据——执行前先看]',
        k: 8,
      }).catch(() => null);
      return text(`任务流已更新（${plan.length} 项）：\n${formatPlan(plan)}${recall ? `\n\n${recall}` : ''}`);
    },
  );

  const updatePlanStep = tool(
    'update_plan_step',
    '更新任务流里**一个步骤**的状态（前端实时显示，并触发学习代理从这段操作中学习）。每开始一步就标 in_progress，做完立刻标 done；遇到问题 problem、失败 failed、在等用户/外部条件 blocked、放弃这个方案改用别的 replaced——这四种必须写 reason。换方案时用 replacement 写新方案，会插在后面并自动关联。',
    {
      step: z.union([z.string(), z.number()]).describe('步骤序号（从 1 开始）或步骤原文'),
      status: STATUS,
      reason: z.string().optional().describe('problem/failed/blocked/replaced 时必填：原因'),
      replacement: z.string().optional().describe('status=replaced 时：新方案的步骤文本（自动设为进行中）'),
    },
    async (args) => {
      const r = await writePlanStep(sessionId, {
        step: args.step,
        status: args.status as PlanTaskStatus,
        reason: args.reason,
        replacement: args.replacement,
      });
      if (!r.ok) return text(r.error);
      let extra = '';
      if (['problem', 'failed', 'blocked'].includes(args.status) || args.replacement) {
        // Something went wrong → look up what the graph knows about this situation.
        const recall = await recallBlock(`${r.step.text}\n${args.reason ?? ''}\n${args.replacement ?? ''}`, {
          heading: '[知识图谱·遇到问题时可参考的已有经验]',
          kinds: ['skill', 'preference'],
          k: 6,
        }).catch(() => null);
        if (recall) extra = `\n\n${recall}`;
      }
      return text(`已更新：${r.step.text} → ${args.status}${r.added ? `；新增方案：${r.added.text}（进行中）` : ''}\n${formatPlan(r.plan)}${extra}`);
    },
  );

  const scheduleTask = tool(
    'schedule_task',
    '安排一个定时任务：delaySeconds 秒后自动执行 description。左侧监控会出现一个"定时检查"代理并实时倒计时，到点自动在本会话执行。**不要用 Bash sleep 阻塞等待**，用本工具。',
    {
      delaySeconds: z.number().int().min(5).max(86400).describe('多少秒后执行（5s~24h）'),
      description: z.string().describe('到点要做的事'),
    },
    async (args) => {
      const at = await scheduler.schedule(sessionId, args.delaySeconds, args.description);
      return text(`已安排定时任务：${args.delaySeconds}s 后（${at.toLocaleString()}）自动执行：${args.description}`);
    },
  );

  const scheduleQualityReview = tool(
    'schedule_quality_review',
    '为较长/多阶段任务开启**质检顾问**（独立的第二模型，像同事从旁看一眼）：每隔 intervalMinutes 分钟浏览你自上次以来的对话与工具调用、抽查沙盘产物，提出最多 3 条 nit/concern/blocker 建议，以 `[质检反馈]` 回传给你。**只在用户尚未设置质检周期时生效**——用户在页面上选的周期优先，你不能修改或关闭它。',
    {
      intervalMinutes: z.number().int().min(5).max(120).describe('质检间隔(分钟，5~120)'),
    },
    async (args) => {
      const s = await prisma.session.findUnique({ where: { id: sessionId } });
      const current = s?.qualityReviewMinutes ?? 0;
      if (current > 0) {
        return text(`用户已在页面设置质检周期为每 ${current} 分钟，以用户设置为准（未修改）。`);
      }
      await setQualityCadence(sessionId, args.intervalMinutes);
      return text(`已开启质检顾问：每 ${args.intervalMinutes} 分钟评估一次（用户可在页面顶栏随时调整或关闭）。`);
    },
  );

  const getCurrentTime = tool(
    'get_current_time',
    '获取当前日期与时间（本地 + UTC + 时区 + epoch）。本工作流很看重时间，需要时随时调用以拿到最新时间。',
    {},
    async () => {
      const now = new Date();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return text(
        `本地时间: ${now.toLocaleString()} (${tz})\nUTC ISO: ${now.toISOString()}\nepoch(ms): ${now.getTime()}`,
      );
    },
  );

  const verifyEmail = tool(
    'verify_email',
    '验证邮箱地址是否真实存在/可投递（本地 AfterShip email-verifier：语法 → MX → SMTP 握手（不发信，含 catch-all 探测）→ 一次性/角色/免费邮箱检测 → 域名拼写纠错）。每次最多 50 个；更多请分批或写脚本调 `POST $CHAPI_SERVER_URL/api/email-verify`。status: safe=可投递 · risky=catch-all/满/角色/一次性 · invalid=不存在或域名无效 · unknown=SMTP 无法确认（勿当作 invalid）。需用户在设置里启用；未启用时会返回提示。',
    {
      emails: z.array(z.string()).min(1).max(50).describe('要验证的邮箱地址'),
      saveTo: z
        .string()
        .optional()
        .describe('可选：把验证器的完整原始 JSON 结果写到沙盘内此路径（如 email-verify.json）'),
    },
    async (args) => {
      try {
        const { results, notes, raw } = await emailVerifier.verify(args.emails);
        let saved = '';
        if (args.saveTo) {
          const sandbox = sessionPaths(sessionId).sandbox;
          const out = path.resolve(sandbox, args.saveTo);
          // This in-process write bypasses the SDK's file permissions — confine it to the sandbox.
          const rel = path.relative(sandbox, out);
          if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            return text(`saveTo 必须是会话沙盘内的相对路径（收到: ${args.saveTo}）`);
          }
          await fs.mkdir(path.dirname(out), { recursive: true });
          await fs.writeFile(out, JSON.stringify(raw, null, 2), 'utf8');
          saved = `\n完整结果已写入: ${out}`;
        }
        const counts = results.reduce<Record<string, number>>(
          (m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m),
          {},
        );
        return text(
          [
            `共 ${results.length} 个：${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
            ...results.map(formatEmailResult),
            ...notes.map((n) => `注意：${n}`),
          ].join('\n') + saved,
        );
      } catch (e) {
        return text(`邮箱验证不可用：${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  const siteReconTool = tool(
    'site_recon',
    '**爬取任何网站之前先调用**：侦察该站反爬强度（纯 HTTP 探测 + 响应头/cookie/挑战页识别 Cloudflare/Akamai/DataDome/PerimeterX/Kasada/Imperva/AWS WAF + robots.txt + 内嵌 JSON/API 线索 + 历史拦截记录），返回等级 L0–L3 与对应策略（用 API/纯 HTTP 还是浏览器、并发数、延时）。结果按域名缓存 7 天。抓取中途被拦截/出验证码时用 report="blocked" 升级等级；某等级策略跑通了可 report="ok"。',
    {
      url: z.string().describe('目标网站首页或要抓的页面/API URL'),
      report: z.enum(['blocked', 'ok']).optional().describe('反馈实际结果：blocked=被拦截(升级一级)；ok=当前策略可用'),
      note: z.string().optional().describe('随 report 记录的备注（如在哪一步被封、哪个 API 可用）'),
      refresh: z.boolean().optional().describe('忽略缓存重新侦察'),
    },
    async (args) => text(await siteRecon(args.url, { report: args.report, note: args.note, refresh: args.refresh })),
  );

  const rateSources = tool(
    'rate_sources',
    '给联网查到的事实/数据打**置信度**（必须用本工具算，别自己估）：单来源 c = 可靠度R(官方0.95/权威0.80/聚合平台0.65/社区0.40/未知0.30) × (0.5+0.5×新鲜度F)，F=0.5^(天数/半衰期，fast=90天·medium=365天·slow=1825天，无日期 F=0.5)；多个独立来源（同一域名只算一次）指向同一数值时叠加：C=1−(1−c₁)·Π(1−0.8·cᵢ)；有矛盾来源时打折。≥85% 高、≥60% 中、否则低。每条事实尽量给 ≥3 个独立来源。tier 不填按域名推断——**公司/机构自己的官网、政府/监管文件、官方 API 请显式填 official**。',
    {
      claims: z
        .array(
          z.object({
            claim: z.string().describe('事实/数据点，如 "The Brodsky Organization 管理的单元数"'),
            value: z.string().optional().describe('取用的数值/结论'),
            volatility: z
              .enum(['fast', 'medium', 'slow'])
              .optional()
              .describe('变化速度：fast=价格/租金/房源/新闻/任职；medium=公司信息/年度统计(默认)；slow=历史/法规/定义'),
            sources: z
              .array(
                z.object({
                  url: z.string(),
                  title: z.string().optional(),
                  publishedAt: z.string().optional().describe('发布/更新日期 YYYY-MM-DD / YYYY-MM / YYYY；不知道就不填'),
                  tier: z.enum(['official', 'reputable', 'aggregator', 'community', 'unknown']).optional(),
                  agrees: z.boolean().optional().describe('false = 该来源给出的是不同数值（矛盾）'),
                }),
              )
              .min(1),
          }),
        )
        .min(1)
        .max(60),
    },
    async (args) => {
      const scored = (args.claims as ClaimInput[]).map((c) => scoreClaim(c));
      return text(scored.map(formatScoredClaim).join('\n\n'));
    },
  );

  return createSdkMcpServer({
    name: 'chapi',
    version: '0.1.0',
    tools: [
      askUser,
      requestApproval,
      notifyUser,
      saveArtifact,
      wikiSearch,
      wikiWrite,
      pdfEditTool,
      setPlan,
      updatePlanStep,
      scheduleTask,
      scheduleQualityReview,
      getCurrentTime,
      verifyEmail,
      siteReconTool,
      rateSources,
      wikiRead,
      ...buildWorkflowTools(sessionId),
      ...buildBoardTools(sessionId),
    ],
  });
}

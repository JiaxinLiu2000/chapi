import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ArtifactDTO, ArtifactKind } from '@chapi/shared';
import { prisma } from '../../db/client.js';
import { bus } from '../../gateway/bus.js';
import { toArtifactDTO, toPendingQuestionDTO } from '../../mappers.js';
import { searchWiki, writeWikiEntry } from '../../rag/wiki.js';
import { pdfEdit } from '../../tools/pdf.js';
import { hitl } from '../hitl.js';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

/** Tool names exposed to the model (server name "chapi"). */
export const CHAPI_TOOL_NAMES = [
  'mcp__chapi__ask_user',
  'mcp__chapi__request_approval',
  'mcp__chapi__notify_user',
  'mcp__chapi__save_artifact',
  'mcp__chapi__wiki_search',
  'mcp__chapi__wiki_write',
  'mcp__chapi__pdf_edit',
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
      const answer = await hitl.waitForQuestion(q.id);
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
          summary: args.summary,
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
          summary: args.summary,
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
      const decision = await hitl.waitForApproval(approval.id);
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

  const wikiSearch = tool(
    'wiki_search',
    '检索共享 AI Wiki（语义搜索）。规划前先查是否有可复用经验。返回相关片段与来源。',
    {
      query: z.string(),
      k: z.number().int().min(1).max(20).optional(),
    },
    async (args) => {
      const hits = await searchWiki(args.query, args.k ?? 5);
      if (hits.length === 0) return text('（Wiki 中暂无相关内容，或未配置 OpenAI Key）');
      const body = hits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.entry.title}\n${h.chunk}\n来源: ${
              h.sourceRef ? `${h.sourceRef.kind}:${h.sourceRef.ref}` : '(无)'
            }`,
        )
        .join('\n\n');
      return text(body);
    },
  );

  const wikiWrite = tool(
    'wiki_write',
    '把可复用的知识/经验/偏好/正确格式沉淀进共享 AI Wiki。必须带来源以便验证。同标题会更新已有条目。',
    {
      title: z.string(),
      body: z.string().describe('Markdown 正文'),
      sourceRefs: z
        .array(
          z.object({
            kind: z.string().describe('raw-material|web|session-message|artifact'),
            ref: z.string().describe('文件路径 / URL / 消息id'),
            note: z.string().optional(),
          }),
        )
        .optional(),
      tags: z.array(z.string()).optional(),
      questions: z
        .array(z.string())
        .optional()
        .describe('该知识能回答的不同问法（多索引，便于不同提问命中同一答案）'),
    },
    async (args) => {
      const entry = await writeWikiEntry({
        title: args.title,
        body: args.body,
        sourceRefs: args.sourceRefs,
        tags: args.tags,
        questions: args.questions,
      });
      return text(`saved wiki entry "${entry.title}" (${entry.slug})`);
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

  return createSdkMcpServer({
    name: 'chapi',
    version: '0.1.0',
    tools: [askUser, requestApproval, notifyUser, saveArtifact, wikiSearch, wikiWrite, pdfEditTool],
  });
}

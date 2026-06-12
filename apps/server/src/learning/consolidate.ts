import type { WikiSourceRef } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { complete, llmAvailable } from '../engine/llm.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { writeWikiEntry } from '../rag/wiki.js';

const log = createLogger('learning:consolidate');

interface ProposedEntry {
  title?: string;
  body?: string;
  tags?: string[];
  questions?: string[];
  sourceRefs?: WikiSourceRef[];
}

function extractJsonArray(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return '[]';
  return candidate.slice(start, end + 1);
}

/**
 * Green-button learning: review a completed session and distill reusable
 * knowledge (workflow patterns, user preferences, correct table/email/PDF
 * formats) into the shared AI Wiki, with sources for verification.
 */
export async function consolidateSession(sessionId: string): Promise<void> {
  if (!(await llmAvailable())) {
    bus.emit({
      type: 'notification',
      sessionId,
      level: 'info',
      title: '跳过学习',
      body: '未配置 Anthropic Key，无法进行复盘学习。',
    });
    return;
  }

  const [messages, artifacts, plan] = await Promise.all([
    prisma.message.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } }),
    prisma.artifact.findMany({ where: { sessionId } }),
    prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } }),
  ]);

  const transcript = messages
    .map((m) => `${m.role}: ${m.text}`)
    .join('\n')
    .slice(-16000);
  const planText = plan.map((t) => `- [${t.status}] ${t.text}`).join('\n') || '(无)';
  const artifactsText =
    artifacts.map((a) => `- ${a.kind}: ${a.title} (${a.pathOrUrl})`).join('\n') || '(无)';

  const system = '你在做任务复盘，提炼可复用经验写入团队 AI Wiki。严格只输出 JSON 数组，不要任何解释或代码块外文字。';
  const prompt = `以下是一个被用户标记为「出色完成」的任务。请提炼 1-4 条未来可复用的知识
（工作流范式、用户偏好、正确的表格/邮件/PDF 格式、易错点等）。

每条对象字段：
- title: 简洁标题
- body: Markdown 正文（具体、可操作）
- tags: 字符串数组
- questions: 该知识能回答的不同问法（数组，便于检索）
- sourceRefs: 数组，每项 {kind, ref}（kind 取 session-message|artifact|raw-material|web；ref 为消息序号/产物链接/路径）

只输出 JSON 数组。

任务计划：
${planText}

产物：
${artifactsText}

对话：
${transcript}`;

  try {
    const out = await complete({ system, prompt });
    const entries = JSON.parse(extractJsonArray(out)) as ProposedEntry[];
    let n = 0;
    for (const e of entries) {
      if (e?.title && e?.body) {
        await writeWikiEntry({
          title: e.title,
          body: e.body,
          tags: Array.isArray(e.tags) ? e.tags : [],
          questions: Array.isArray(e.questions) ? e.questions : [],
          sourceRefs: Array.isArray(e.sourceRefs) ? e.sourceRefs : [],
        });
        n += 1;
      }
    }
    bus.emit({
      type: 'notification',
      sessionId,
      level: 'success',
      title: '已学习并归档',
      body: `从本次任务沉淀了 ${n} 条可复用 Wiki 知识。`,
    });
    log.info(`consolidated session ${sessionId}: ${n} wiki entries`);
  } catch (err) {
    log.warn('consolidate failed', err);
    bus.emit({
      type: 'notification',
      sessionId,
      level: 'info',
      title: '复盘未完成',
      body: '复盘学习时出错，已跳过（任务仍标记完成）。',
    });
  }
}

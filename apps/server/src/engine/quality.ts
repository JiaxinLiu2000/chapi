import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRun, Artifact, PlanTask, Session } from '@prisma/client';
import { sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toAgentRunDTO, toMessageDTO, toPlanTaskDTO } from '../mappers.js';
import { settings } from '../secrets.js';
import { getOrchestrator } from '../orchestrator/types.js';
import { chooseActiveAccount } from './accounts.js';
import { emitAttention } from './attention.js';

const log = createLogger('quality');

interface Issue {
  severity: 'high' | 'medium' | 'low';
  where: string;
  problem: string;
  fix: string;
}
interface Verdict {
  score: number;
  summary: string;
  issues: Issue[];
  planProblems: string[];
}

const SYSTEM = [
  '你是"质检代理"(QA reviewer)。只读、绝不修改任何文件或产物。',
  '任务:评估本会话到目前为止的**阶段性产物**质量,给出可执行的评估。',
  '检查维度:①是否满足任务目标与完整性;②数据/事实是否可核验、有无明显错误或异常值(抽查即可,不必逐条);',
  '③格式与可用性;④是否有遗漏的步骤或未完成项。可用 Read/Grep/Glob/LS 查看沙盘里的文件。',
  '务必**只输出一个 JSON**,不要任何多余文字:',
  '{"score":0-100,"summary":"一句话总体判断","issues":[{"severity":"high|medium|low","where":"文件或步骤","problem":"问题","fix":"修改建议"}],"planProblems":["与问题相关的任务流步骤原文(便于标红),没有则空数组"]}',
].join('\n');

function parseVerdict(text: string): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Partial<Verdict>;
    return {
      score: Math.max(0, Math.min(100, Number(o.score) || 0)),
      summary: String(o.summary ?? '').slice(0, 200),
      issues: Array.isArray(o.issues) ? (o.issues as Issue[]).slice(0, 20) : [],
      planProblems: Array.isArray(o.planProblems) ? (o.planProblems as string[]).slice(0, 20) : [],
    };
  } catch {
    return null;
  }
}

async function evaluate(
  sandbox: string,
  plan: PlanTask[],
  artifacts: Artifact[],
  goal: string,
): Promise<Verdict | null> {
  const acct = await chooseActiveAccount();
  const model = (await settings.getModels()).subagent;
  const planStr = plan.map((t) => `- [${t.status}] ${t.text}`).join('\n') || '(无任务流)';
  const artStr =
    artifacts.map((a) => `- ${a.kind}「${a.title}」${a.pathOrUrl}`).join('\n') || '(暂无登记交付物)';
  const prompt = [
    `任务目标:\n${goal}`,
    `\n当前任务流:\n${planStr}`,
    `\n已登记交付物:\n${artStr}`,
    `\n会话沙盘目录(用 LS/Read/Grep 查看实际文件):${sandbox}`,
    '\n请抽查评估阶段性产物质量,然后**只输出 JSON**。',
  ].join('\n');

  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  if (acct.token) env.CLAUDE_CODE_OAUTH_TOKEN = acct.token;

  const q = query({
    prompt,
    options: {
      model,
      effort: 'high',
      cwd: sandbox,
      additionalDirectories: [sandbox],
      systemPrompt: SYSTEM,
      settingSources: [],
      mcpServers: {},
      allowedTools: ['Read', 'Grep', 'Glob', 'LS'],
      permissionMode: 'default',
      includePartialMessages: false,
      maxTurns: 16,
      env,
    },
  });

  let text = '';
  for await (const m of q) {
    if (m.type === 'assistant') {
      const am = m as { error?: string; message?: { content?: unknown } };
      if (am.error) throw new Error(`reviewer ${am.error}`);
      const c = am.message?.content;
      if (Array.isArray(c))
        for (const b of c as Array<{ type?: string; text?: string }>)
          if (b.type === 'text') text += b.text ?? '';
    }
  }
  return parseVerdict(text);
}

/**
 * Run one scheduled quality review over the session's stage deliverables. Shows a
 * "质检" agent in the monitor, marks flagged plan steps as `problem`, notifies the
 * user, and (when there are real issues) feeds them back to the main agent to fix.
 */
export async function runQualityReview(sessionId: string): Promise<void> {
  const session: Session | null = await prisma.session
    .findUnique({ where: { id: sessionId } })
    .catch(() => null);
  if (!session || session.status !== 'active') return;

  const [plan, artifacts, firstUser] = await Promise.all([
    prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } }),
    prisma.artifact.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } }),
    prisma.message.findFirst({ where: { sessionId, role: 'user' }, orderBy: { createdAt: 'asc' } }),
  ]);
  if (plan.length === 0 && artifacts.length === 0) return; // nothing produced yet

  const started = Date.now();
  let agentRun: AgentRun = await prisma.agentRun.create({
    data: { sessionId, name: '质检', title: '评估阶段性产物质量', status: 'running', startedAt: new Date() },
  });
  bus.emit({ type: 'agent.status', sessionId, agent: toAgentRunDTO(agentRun) });

  const goal = firstUser?.text?.trim() || session.title;
  const verdict = await evaluate(sessionPaths(sessionId).sandbox, plan, artifacts, goal).catch((e) => {
    log.warn('quality review failed', e);
    return null;
  });

  const summary = verdict ? `评分 ${verdict.score}/100 · ${verdict.summary}` : '本轮质检未完成，稍后重试';
  agentRun = await prisma.agentRun.update({
    where: { id: agentRun.id },
    data: {
      status: verdict ? 'done' : 'error',
      summary,
      endedAt: new Date(),
      elapsedMs: Date.now() - started,
    },
  });
  bus.emit({ type: 'agent.status', sessionId, agent: toAgentRunDTO(agentRun) });
  if (!verdict) return;

  // Post the verdict into the conversation itself (not just a toast) so it stays
  // visible in the transcript, styled distinctly (yellow) from the main agent.
  const issueLines = verdict.issues
    .map((i) => `- [${i.severity}] ${i.where}：${i.problem}（建议：${i.fix}）`)
    .join('\n');
  const qualityText = [
    `质检评分：${verdict.score}/100`,
    verdict.summary,
    issueLines ? `发现问题：\n${issueLines}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const qualityMessage = await prisma.message.create({
    data: {
      sessionId,
      role: 'assistant',
      type: 'quality',
      content: [{ type: 'text', text: qualityText }] as unknown as object,
      text: qualityText,
      agentRunId: agentRun.id,
    },
  });
  bus.emit({ type: 'assistant.message', sessionId, message: toMessageDTO(qualityMessage) });

  // Mark flagged plan steps as problem.
  if (verdict.planProblems.length) {
    for (const text of verdict.planProblems) {
      const match =
        plan.find((t) => t.text === text) ||
        plan.find((t) => text.includes(t.text) || t.text.includes(text));
      if (match && match.status !== 'done') {
        await prisma.planTask.update({ where: { id: match.id }, data: { status: 'problem' } }).catch(() => undefined);
      }
    }
    const all = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
    bus.emit({ type: 'plan.updated', sessionId, tasks: all.map(toPlanTaskDTO) });
  }

  const actionable = verdict.issues.filter((i) => i.severity === 'high' || i.severity === 'medium');
  bus.emit({
    type: 'notification',
    sessionId,
    level: actionable.length ? 'error' : 'success',
    title: '阶段性质检结果',
    body: `评分 ${verdict.score}/100。${verdict.summary}${
      actionable.length ? ` 发现 ${actionable.length} 项待改。` : ' 未见明显问题。'
    }`,
  });
  void emitAttention(sessionId, 'notify', `质检 ${verdict.score}/100：${verdict.summary}`);

  // Feed real issues back to the main agent so it fixes them.
  if (actionable.length) {
    const lines = actionable
      .map((i) => `- [${i.severity}] ${i.where}：${i.problem} → 建议：${i.fix}`)
      .join('\n');
    const msg = `[质检反馈] 质检评分 ${verdict.score}/100，发现以下需修正的问题：\n${lines}\n请据此修正相应产物后继续。`;
    await getOrchestrator().handleUserMessage(sessionId, msg).catch((e) => log.warn('feedback inject failed', e));
  }
}

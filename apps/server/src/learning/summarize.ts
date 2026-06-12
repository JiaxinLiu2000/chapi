import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { complete, llmAvailable } from '../engine/llm.js';
import { createLogger } from '../logger.js';

const log = createLogger('learning:summarize');

/**
 * Rolling summary (every 5 user rounds): summarize the user's needs and progress
 * so far, store in memory_summaries + the session memory dir. Saves context and
 * gives the agent a stable recap (injected into later runs' system prompt).
 */
export async function summarizeSession(sessionId: string): Promise<void> {
  if (!(await llmAvailable())) return;
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return;

  const last = await prisma.memorySummary.findFirst({
    where: { sessionId },
    orderBy: { roundEnd: 'desc' },
  });
  const fromRound = (last?.roundEnd ?? 0) + 1;

  const messages = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
  const transcript = messages
    .slice(-60)
    .map((m) => `${m.role}: ${m.text}`)
    .join('\n')
    .slice(-12000);

  try {
    const summary = await complete({
      system: '你在为一个工作流会话做滚动摘要，便于节省上下文。用简洁中文要点。',
      prompt: `总结用户的需求与现阶段已完成/进行中的内容（简洁要点式，不超过 ~200 字）：\n\n对话：\n${transcript}`,
    });
    await prisma.memorySummary.create({
      data: { sessionId, roundStart: fromRound, roundEnd: session.roundCount, summary },
    });
    const dir = path.join(sessionPaths(sessionId).memory, 'conversation');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `summary-${session.roundCount}.md`), summary, 'utf8');
    log.info(`summarized session ${sessionId} at round ${session.roundCount}`);
  } catch (err) {
    log.warn('summarize failed', err);
  }
}

/** Latest rolling summary for a session, if any (injected into the run system prompt). */
export async function latestSummary(sessionId: string): Promise<string | null> {
  const s = await prisma.memorySummary.findFirst({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
  });
  return s?.summary ?? null;
}

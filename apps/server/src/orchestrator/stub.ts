import type { ContentBlock } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toMessageDTO } from '../mappers.js';
import { setSessionStatus } from '../services/sessions.js';
import type { Orchestrator } from './types.js';

const log = createLogger('orchestrator:stub');

/**
 * Placeholder engine for M1: persists the user turn and replies with a notice.
 * Replaced by the Claude Agent SDK engine in M2. Lets us verify the gateway,
 * bus, persistence and frontend end-to-end before the engine lands.
 */
export class StubOrchestrator implements Orchestrator {
  async handleUserMessage(sessionId: string, text: string): Promise<void> {
    const userContent: ContentBlock[] = [{ type: 'text', text }];
    await prisma.message.create({
      data: {
        sessionId,
        role: 'user',
        type: 'user',
        content: userContent as unknown as object,
        text,
      },
    });
    await prisma.session.update({
      where: { id: sessionId },
      data: { roundCount: { increment: 1 } },
    });

    bus.emit({ type: 'run.state', sessionId, state: 'running' });

    const reply = [
      '引擎尚未接入（M1 占位）。已记录你的消息：',
      '',
      `> ${text}`,
      '',
      'Claude Agent SDK 编排引擎将在 M2 接入后真正执行任务。',
    ].join('\n');
    const assistantContent: ContentBlock[] = [{ type: 'text', text: reply }];
    const msg = await prisma.message.create({
      data: {
        sessionId,
        role: 'assistant',
        type: 'assistant',
        content: assistantContent as unknown as object,
        text: reply,
      },
    });
    bus.emit({ type: 'assistant.message', sessionId, message: toMessageDTO(msg) });
    bus.emit({ type: 'run.state', sessionId, state: 'done' });
  }

  async interrupt(sessionId: string): Promise<void> {
    bus.emit({ type: 'run.state', sessionId, state: 'idle' });
  }

  async answerQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
  ): Promise<void> {
    await prisma.pendingQuestion.update({
      where: { id: questionId },
      data: { answer, status: 'answered', answeredAt: new Date() },
    });
    bus.emit({ type: 'question.closed', sessionId, questionId });
    log.info(`question ${questionId} answered: ${answer.slice(0, 60)}`);
  }

  async decideApproval(
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'reject' | 'revise',
    feedback?: string,
  ): Promise<void> {
    await prisma.approval.update({
      where: { id: approvalId },
      data: {
        status: decision === 'approve' ? 'approved' : decision,
        feedback: feedback ?? null,
        decidedAt: new Date(),
      },
    });
    bus.emit({ type: 'approval.closed', sessionId, approvalId });
  }

  async abandon(): Promise<void> {
    // no-op for the stub
  }

  async markCompleted(sessionId: string): Promise<void> {
    await setSessionStatus(sessionId, 'completed');
    bus.emit({
      type: 'notification',
      sessionId,
      level: 'success',
      title: '任务已标记完成',
      body: '学习/复盘将在 M7 接入后执行。',
    });
  }
}

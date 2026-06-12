import type { ContentBlock } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import type { Orchestrator } from '../orchestrator/types.js';
import { setSessionStatus } from '../services/sessions.js';
import { consolidateSession } from '../learning/consolidate.js';
import { summarizeSession } from '../learning/summarize.js';
import { hitl } from './hitl.js';
import { Run, type QueryFn } from './run.js';

const log = createLogger('engine:orchestrator');

/** Manages one Run per active session and implements the gateway Orchestrator. */
export class SdkOrchestrator implements Orchestrator {
  private runs = new Map<string, Run>();

  constructor(private readonly queryFn?: QueryFn) {}

  private getRun(sessionId: string): Run {
    let run = this.runs.get(sessionId);
    if (!run) {
      run = new Run(sessionId, this.queryFn);
      this.runs.set(sessionId, run);
    }
    return run;
  }

  async handleUserMessage(sessionId: string, text: string): Promise<void> {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) throw new Error('session not found');
    if (session.status === 'completed') {
      bus.emit({
        type: 'error',
        sessionId,
        message: '该会话已标记完成，处于只读状态。',
      });
      return;
    }

    const content: ContentBlock[] = [{ type: 'text', text }];
    await prisma.message.create({
      data: {
        sessionId,
        role: 'user',
        type: 'user',
        content: content as unknown as object,
        text,
      },
    });
    const updated = await prisma.session.update({
      where: { id: sessionId },
      data: { roundCount: { increment: 1 } },
    });

    await this.getRun(sessionId).pushUserMessage(text);

    // Every 5 user rounds: roll up a summary to save context (fire-and-forget).
    if (updated.roundCount > 0 && updated.roundCount % 5 === 0) {
      void summarizeSession(sessionId);
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.interrupt();
  }

  async answerQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
  ): Promise<void> {
    await prisma.pendingQuestion
      .update({
        where: { id: questionId },
        data: { answer, status: 'answered', answeredAt: new Date() },
      })
      .catch((err) => log.warn('answerQuestion update failed', err));
    // Unblock the in-flight ask_user tool so the agent continues.
    hitl.resolveQuestion(questionId, answer);
    bus.emit({ type: 'question.closed', sessionId, questionId });
  }

  async decideApproval(
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'reject' | 'revise',
    feedback?: string,
  ): Promise<void> {
    await prisma.approval
      .update({
        where: { id: approvalId },
        data: {
          status: decision === 'approve' ? 'approved' : decision,
          feedback: feedback ?? null,
          decidedAt: new Date(),
        },
      })
      .catch((err) => log.warn('decideApproval update failed', err));
    hitl.resolveApproval(approvalId, { decision, feedback });
    bus.emit({ type: 'approval.closed', sessionId, approvalId });
  }

  async markCompleted(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.stop().catch(() => undefined);
    this.runs.delete(sessionId);
    bus.emit({
      type: 'notification',
      sessionId,
      level: 'success',
      title: '任务已标记完成',
      body: '正在复盘学习并归档…',
    });
    // Distill reusable knowledge into the wiki while the transcript is intact.
    await consolidateSession(sessionId).catch((err) => log.warn('consolidate error', err));
    await setSessionStatus(sessionId, 'completed');
  }

  async abandon(sessionId: string): Promise<void> {
    await this.runs.get(sessionId)?.stop().catch(() => undefined);
    this.runs.delete(sessionId);
  }

  async dispose(): Promise<void> {
    for (const run of this.runs.values()) await run.stop().catch(() => undefined);
    this.runs.clear();
  }
}

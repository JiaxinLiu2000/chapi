import { MODEL_OPTIONS, topAllowedModel, type ContentBlock } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toSessionDTO } from '../mappers.js';
import type { Orchestrator } from '../orchestrator/types.js';
import { setSessionStatus } from '../services/sessions.js';
import { consolidateSession } from '../learning/consolidate.js';
import { summarizeSession } from '../learning/summarize.js';
import { settings } from '../secrets.js';
import { hitl } from './hitl.js';
import { Run, type QueryFn } from './run.js';
import { chooseActiveAccount, recordAccountLimited } from './accounts.js';
import { scheduler } from './scheduler.js';

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

    // Arm the periodic quality reviewer if this session has a cadence set (re-arms
    // after a server restart, since the timers are in-memory).
    const qrm = session.qualityReviewMinutes ?? 0;
    if (qrm > 0 && !scheduler.isQualityReviewOn(sessionId)) {
      scheduler.scheduleQualityReview(sessionId, qrm * 60_000);
    }

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
    scheduler.cancelQualityReview(sessionId);
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
    scheduler.cancelQualityReview(sessionId);
    await this.runs.get(sessionId)?.stop().catch(() => undefined);
    this.runs.delete(sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  /**
   * The given Claude seat hit its usage limit. Record it (starts that seat's own
   * cooldown clock — the two seats are tracked independently), then let account
   * selection decide the next seat: whichever is ready, or — if both are
   * currently limited — whichever cools down first. Replays the last turn on a
   * fresh run that RESUMES the same SDK session (context preserved); we re-push
   * the user text directly — not via handleUserMessage — so the transcript /
   * roundCount aren't duplicated.
   */
  async onRateLimit(
    sessionId: string,
    lastUserText: string,
    account: 'primary' | 'fallback',
  ): Promise<void> {
    await recordAccountLimited(account);
    const old = this.runs.get(sessionId);
    await old?.stop().catch(() => undefined);
    this.runs.delete(sessionId);

    const accounts = await settings.getClaudeAccounts();
    const otherToken = account === 'primary' ? accounts.fallbackToken : accounts.primaryToken;
    if (!otherToken) {
      bus.emit({
        type: 'notification',
        sessionId,
        level: 'error',
        title: account === 'primary' ? '主账号已达使用限额' : '备用账号已达使用限额',
        body: '未配置可用的另一个账号，请在设置里填入 token。',
      });
      bus.emit({ type: 'run.state', sessionId, state: 'idle' });
      return;
    }

    const target = await chooseActiveAccount('auto');
    const fo = await settings.getClaudeFailover();
    // chooseActiveAccount clears a seat's reset marker once it's actually ready —
    // if the seat it landed on still has one set, both seats are currently limited
    // and this was just the soonest-to-recover pick, not a real fix yet.
    const stillLimited =
      (target.name === 'primary' && Boolean(fo.primaryResetAt)) ||
      (target.name === 'fallback' && Boolean(fo.fallbackResetAt));
    const toLabel = target.name === 'primary' ? '主账号' : '备用账号';

    if (stillLimited) {
      // Don't retry immediately — both seats are exhausted right now, so a fresh
      // run would just fail the same way again. The preference we just recorded
      // (whichever recovers first) takes effect on the next message, once it's
      // actually ready.
      bus.emit({
        type: 'notification',
        sessionId,
        level: 'error',
        title: '两个账号均已达使用限额',
        body: `主账号与备用账号都已达使用限额，预计 ${toLabel}（${target.email}）先恢复，届时会优先使用。请稍后再试。`,
      });
      bus.emit({ type: 'run.state', sessionId, state: 'idle' });
      return;
    }

    // The seat we land on may not have access to every model the previous one
    // did (e.g. no Fable 5). Downgrade any model the session was using that the
    // new seat can't run — otherwise the run would immediately die with
    // "There's an issue with the selected model" right after switching.
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    const downgrades: string[] = [];
    if (session) {
      const allowed = (await settings.getClaudeModels())[target.name as 'primary' | 'fallback'];
      const data: { model?: string; subagentModel?: string } = {};
      if (allowed.length && !allowed.includes(session.model)) {
        data.model = topAllowedModel(allowed);
        downgrades.push(
          `主代理 ${MODEL_OPTIONS.find((m) => m.id === session.model)?.label ?? session.model} → ${
            MODEL_OPTIONS.find((m) => m.id === data.model)?.label ?? data.model
          }`,
        );
      }
      if (allowed.length && !allowed.includes(session.subagentModel)) {
        data.subagentModel = topAllowedModel(allowed);
        downgrades.push(
          `子代理 ${MODEL_OPTIONS.find((m) => m.id === session.subagentModel)?.label ?? session.subagentModel} → ${
            MODEL_OPTIONS.find((m) => m.id === data.subagentModel)?.label ?? data.subagentModel
          }`,
        );
      }
      if (Object.keys(data).length) {
        const updated = await prisma.session.update({ where: { id: sessionId }, data });
        bus.emit({ type: 'session.updated', session: toSessionDTO(updated) });
      }
    }

    const fromLabel = account === 'primary' ? '主' : '备用';
    bus.emit({
      type: 'notification',
      sessionId,
      level: 'info',
      title: '已切换账号',
      body: `${fromLabel}账号已达使用限额，已切换到 ${toLabel}（${target.email}）并自动重试。${
        downgrades.length ? `该账号无权限使用原模型，已自动降级：${downgrades.join('；')}。` : ''
      }`,
    });

    if (lastUserText.trim()) {
      await this.getRun(sessionId).pushUserMessage(lastUserText);
    } else {
      bus.emit({ type: 'run.state', sessionId, state: 'idle' });
    }
  }

  async setConfig(
    sessionId: string,
    model?: string,
    effort?: string,
    subagentModel?: string,
    language?: string,
    accountMode?: string,
    qualityReviewMinutes?: number,
  ): Promise<void> {
    const data: {
      model?: string;
      effort?: string;
      subagentModel?: string;
      language?: string;
      accountMode?: string;
      qualityReviewMinutes?: number;
    } = {};
    if (model) data.model = model;
    if (effort) data.effort = effort;
    if (subagentModel) data.subagentModel = subagentModel;
    if (language) data.language = language;
    if (accountMode) data.accountMode = accountMode;
    if (qualityReviewMinutes !== undefined) data.qualityReviewMinutes = qualityReviewMinutes;
    if (Object.keys(data).length === 0) return;

    const updated = await prisma.session.update({ where: { id: sessionId }, data });

    // Quality-review cadence: start/stop the recurring reviewer (no run restart needed).
    if (qualityReviewMinutes !== undefined) {
      if (qualityReviewMinutes > 0) scheduler.scheduleQualityReview(sessionId, qualityReviewMinutes * 60_000);
      else scheduler.cancelQualityReview(sessionId);
    }
    const run = this.runs.get(sessionId);
    if (run) {
      if (effort || language || subagentModel || accountMode) {
        // effort/language and the sub-agent model (baked into `agents` at start) can't
        // change live — restart on next message (resume keeps context) to take effect.
        await run.stop().catch(() => undefined);
        this.runs.delete(sessionId);
      } else if (model) {
        await run.setModel(model);
      }
    }
    bus.emit({ type: 'session.updated', session: toSessionDTO(updated) });
    log.info(
      `session ${sessionId} config → model=${updated.model} effort=${updated.effort} lang=${updated.language}`,
    );
  }

  async dispose(): Promise<void> {
    for (const run of this.runs.values()) await run.stop().catch(() => undefined);
    this.runs.clear();
  }
}

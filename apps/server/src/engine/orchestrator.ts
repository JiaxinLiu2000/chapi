import { MODEL_OPTIONS, topAllowedModel, type ContentBlock } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { toMessageDTO, toSessionDTO } from '../mappers.js';
import type { Orchestrator } from '../orchestrator/types.js';
import { setSessionStatus } from '../services/sessions.js';
import { setUserChromeEnabled } from '../services/userChrome.js';
import { isSystemInjected, learner } from '../learning/learner.js';
import { recallBlock } from '../knowledge/recall.js';
import { sopHintFor } from '../workflow/routing.js';
import { summarizeSession } from '../learning/summarize.js';
import { generateSessionTitle } from '../learning/title.js';
import { settings } from '../secrets.js';
import { hitl } from './hitl.js';
import { recordAnswer, recordApproval } from './hitlTranscript.js';
import { Run, type QueryFn } from './run.js';
import { chooseActiveAccount, recordAccountLimited } from './accounts.js';
import { qualityAdvisor } from './quality.js';
import { agentInbox } from './inbox.js';

const log = createLogger('engine:orchestrator');

const RECAP_MAX_CHARS = 12_000;
const RECAP_MSG_CHARS = 600;

/**
 * Recent transcript from chapi's own DB (newest last, capped), excluding the
 * just-sent user message — used to re-seed context when the SDK's own
 * transcript for `resume` has been cleaned up.
 */
async function buildRecap(sessionId: string, lastUserText: string): Promise<string> {
  const rows = await prisma.message.findMany({
    where: { sessionId, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'desc' },
    take: 60,
    select: { role: true, text: true },
  });
  const lines: string[] = [];
  let total = 0;
  let skippedLatest = false;
  for (const m of rows) {
    const text = m.text.trim();
    if (!text) continue;
    if (!skippedLatest && m.role === 'user' && text === lastUserText.trim()) {
      skippedLatest = true; // it's replayed separately as the latest message
      continue;
    }
    const line = `${m.role === 'user' ? '用户' : 'AI'}：${text.length > RECAP_MSG_CHARS ? `${text.slice(0, RECAP_MSG_CHARS)}…` : text}`;
    if (total + line.length > RECAP_MAX_CHARS) break;
    lines.push(line);
    total += line.length;
  }
  return lines.reverse().join('\n\n');
}

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

    // A message can race a `set.config` account-mode change: both are separate
    // WebSocket messages, and if the switch's own run-teardown (see `setConfig`)
    // hasn't finished yet by the time this one is handled, the still-live run
    // would silently push this turn out on its *old* pin instead of the one the
    // user just picked. Catch that here too — if the run we'd reuse was started
    // under a different pin than the session has right now, tear it down first.
    const currentMode = (session.accountMode as 'auto' | 'primary' | 'fallback') ?? 'auto';
    const existing = this.runs.get(sessionId);
    const startedMode = existing?.getStartedAccountMode() ?? null;
    if (existing && startedMode !== null && startedMode !== currentMode) {
      await existing.stop().catch(() => undefined);
      this.runs.delete(sessionId);
    }

    const content: ContentBlock[] = [{ type: 'text', text }];
    const userRow = await prisma.message.create({
      data: {
        sessionId,
        role: 'user',
        type: 'user',
        content: content as unknown as object,
        text,
      },
    });
    // Remote chats (Discord) mirror what was typed elsewhere; the web ignores this event.
    bus.emit({ type: 'user.message', sessionId, message: toMessageDTO(userRow) });
    const updated = await prisma.session.update({
      where: { id: sessionId },
      data: { roundCount: { increment: 1 } },
    });

    const wasWorking = agentInbox.busy(sessionId);
    const injected = isSystemInjected(text);
    // A real user message: the next turn is the user's (resumes the 质检 clock after a follow-up turn).
    if (!injected) qualityAdvisor.onUserMessage(sessionId);
    // Read the vault before acting: relevant knowledge points (strongest first) and
    // notes the side agents held for this turn ride along — the transcript keeps
    // only the user's own words.
    const recall = injected
      ? null
      : await recallBlock(text, {
          heading: updated.roundCount === 1 ? '[知识图谱·规划前先看：与任务相关的已有知识点]' : '[知识图谱·与这条消息相关的知识点]',
          k: 8,
        }).catch(() => null);
    const held = agentInbox.take(sessionId);
    // A request that names a confirmed SOP must run as a workflow (not a hand-written plan).
    const sopHint = injected ? null : await sopHintFor(sessionId, text).catch(() => null);
    await this.getRun(sessionId).pushUserMessage([text, sopHint, recall, held].filter(Boolean).join('\n\n'));

    // Learning: every user message after the conversation's first (mid-run or idle).
    if (!injected && updated.roundCount > 1) learner.enqueue(sessionId, { type: 'user', text, whileWorking: wasWorking });

    // Make sure the advisor's timer is live for this session's cadence.
    await qualityAdvisor.ensure(sessionId, session.qualityReviewMinutes ?? 0);

    // AI title: once from the opening request, then once more after a few rounds
    // when the conversation has taken shape. Never over a user's own rename.
    if ((updated.roundCount === 1 || updated.roundCount === 3) && updated.titleSource !== 'user') {
      void generateSessionTitle(sessionId);
    }

    // Every 5 user rounds: roll up a summary to save context (fire-and-forget).
    if (updated.roundCount > 0 && updated.roundCount % 5 === 0) {
      void summarizeSession(sessionId);
    }
  }

  async injectAdvice(sessionId: string, text: string): Promise<void> {
    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'active') return;
    // Straight into the run's input — not persisted as a user message (the advisor
    // already posted its own 质检 bubble), and not counted as a user round.
    await this.getRun(sessionId).pushUserMessage(text);
  }

  async runQualityReview(sessionId: string): Promise<void> {
    await qualityAdvisor.review(sessionId, true);
  }

  async interrupt(sessionId: string): Promise<void> {
    qualityAdvisor.noteInterrupt(sessionId);
    await this.runs.get(sessionId)?.interrupt();
  }

  async answerQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
  ): Promise<void> {
    const before = await prisma.pendingQuestion.findUnique({ where: { id: questionId } }).catch(() => null);
    const row = await prisma.pendingQuestion
      .update({
        where: { id: questionId },
        data: { answer, status: 'answered', answeredAt: new Date() },
      })
      .catch((err) => {
        log.warn('answerQuestion update failed', err);
        return null;
      });
    // Keep the question, its options and the answer in the conversation history.
    if (row && before?.status === 'open') {
      await recordAnswer(row, answer).catch((err) => log.warn('record answer failed', err));
    }
    bus.emit({ type: 'question.closed', sessionId, questionId });
    if (row?.source === 'learning') {
      // A preference conflict from the learning agent: resolve it on the side;
      // the main agent was never blocked and gets the result via its inbox.
      if (before?.status === 'open') void learner.onLearningAnswer(row, answer);
      return;
    }
    // Unblock the in-flight ask_user tool so the agent continues.
    hitl.resolveQuestion(questionId, answer);
    if (row && before?.status === 'open') {
      const options = Array.isArray(row.options) ? (row.options as string[]) : null;
      learner.enqueue(sessionId, { type: 'answer', question: row.question, options, answer });
    }
  }

  async decideApproval(
    sessionId: string,
    approvalId: string,
    decision: 'approve' | 'reject' | 'revise',
    feedback?: string,
  ): Promise<void> {
    const before = await prisma.approval.findUnique({ where: { id: approvalId } }).catch(() => null);
    const row = await prisma.approval
      .update({
        where: { id: approvalId },
        data: {
          status: decision === 'approve' ? 'approved' : decision,
          feedback: feedback ?? null,
          decidedAt: new Date(),
        },
      })
      .catch((err) => {
        log.warn('decideApproval update failed', err);
        return null;
      });
    // Keep the reviewed summary, the decision and the user's feedback in the history.
    if (row && before?.status === 'open') {
      await recordApproval(row, decision, feedback ?? null).catch((err) => log.warn('record approval failed', err));
    }
    hitl.resolveApproval(approvalId, { decision, feedback });
    bus.emit({ type: 'approval.closed', sessionId, approvalId });
    if (row && before?.status === 'open') {
      learner.enqueue(sessionId, { type: 'approval', summary: row.summary, decision, feedback: feedback ?? null });
    }
  }

  async markCompleted(sessionId: string): Promise<void> {
    qualityAdvisor.stop(sessionId);
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
    await learner.learnNow(sessionId, { type: 'archive' }).catch((err) => log.warn('archive learning error', err));
    await setSessionStatus(sessionId, 'completed');
  }

  async abandon(sessionId: string): Promise<void> {
    qualityAdvisor.stop(sessionId);
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

  // When each session last got an auth-failure restart, so a token that is
  // genuinely dead gets reported instead of restarted in a loop.
  private authRetryAt = new Map<string, number>();

  async onAuthFailed(sessionId: string, lastUserText: string, account: string): Promise<void> {
    const old = this.runs.get(sessionId);
    await old?.stop().catch(() => undefined);
    this.runs.delete(sessionId);

    const recentlyRetried = Date.now() - (this.authRetryAt.get(sessionId) ?? 0) < 5 * 60_000;
    if (!recentlyRetried && lastUserText.trim()) {
      // First 401: usually just the long-lived process's session going stale —
      // a fresh process (resuming the same conversation) with the same token works.
      this.authRetryAt.set(sessionId, Date.now());
      await this.getRun(sessionId).pushUserMessage(lastUserText);
      return;
    }

    // A fresh process failed too → the stored token itself is no longer valid.
    const who = account === 'primary' ? '主账号' : account === 'fallback' ? '备用账号' : '本机 Claude 登录';
    const body = `${who}的登录凭证已失效(换新进程重试后仍返回 401)。请在终端运行 claude setup-token 重新生成长期 token，粘贴到 设置 → Claude 账号 后再继续。`;
    bus.emit({ type: 'notification', sessionId, level: 'error', title: 'Claude 登录已失效', body });
    bus.emit({ type: 'error', sessionId, message: body });
    bus.emit({ type: 'run.state', sessionId, state: 'idle' });
  }

  async onResumeLost(sessionId: string, lastUserText: string): Promise<void> {
    const old = this.runs.get(sessionId);
    await old?.stop().catch(() => undefined);
    this.runs.delete(sessionId);
    // Drop the dead SDK session id so the next run starts a new conversation.
    await prisma.session.update({ where: { id: sessionId }, data: { sdkSessionId: null } });

    if (!lastUserText.trim()) {
      bus.emit({ type: 'run.state', sessionId, state: 'idle' });
      return;
    }
    const recap = await buildRecap(sessionId, lastUserText);
    const prompt = recap
      ? `[系统说明：本会话此前的 Claude 会话记录已过期被清理，无法直接续接。以下是 chapi 自己保存的本会话最近对话摘录，请据此接上上下文继续工作，不必向用户提及此说明。]\n\n${recap}\n\n[用户最新消息]\n${lastUserText}`
      : lastUserText;
    await this.getRun(sessionId).pushUserMessage(prompt);
  }

  async setConfig(
    sessionId: string,
    model?: string,
    effort?: string,
    subagentModel?: string,
    language?: string,
    accountMode?: string,
    qualityReviewMinutes?: number,
    qualityModel?: string,
    userChrome?: boolean,
  ): Promise<void> {
    if (userChrome !== undefined) {
      // Not a DB column (see services/userChrome.ts) and checked live by the
      // sandbox helper — no run restart needed.
      setUserChromeEnabled(sessionId, userChrome);
      const s = await prisma.session.findUnique({ where: { id: sessionId } });
      if (s) bus.emit({ type: 'session.updated', session: toSessionDTO(s) });
    }
    const data: {
      model?: string;
      effort?: string;
      subagentModel?: string;
      language?: string;
      accountMode?: string;
      qualityReviewMinutes?: number;
      qualityModel?: string;
    } = {};
    if (model) data.model = model;
    if (effort) data.effort = effort;
    if (subagentModel) data.subagentModel = subagentModel;
    if (language) data.language = language;
    if (accountMode) data.accountMode = accountMode;
    if (qualityReviewMinutes !== undefined) data.qualityReviewMinutes = qualityReviewMinutes;
    if (qualityModel !== undefined) data.qualityModel = qualityModel; // read per review — no restart
    if (Object.keys(data).length === 0) return;

    const updated = await prisma.session.update({ where: { id: sessionId }, data });

    // Quality-review cadence applies immediately (independent advisor, no run restart).
    if (qualityReviewMinutes !== undefined) await qualityAdvisor.configure(sessionId, qualityReviewMinutes);
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

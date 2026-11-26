import { randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import type { CriterionVerdict, PlanTaskStatus, WorkflowNodeDef, WorkflowRunDTO } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { recallBlock } from '../knowledge/recall.js';
import { createLogger } from '../logger.js';
import { bus } from '../gateway/bus.js';
import { toMessageDTO } from '../mappers.js';
import { syncLockedSteps } from '../engine/plan.js';
import { renderProgress, renderReviewSheet, renderStageCard, stageOutputDir, stagePosition } from './card.js';
import { parseGraph, stepOrder } from './schema.js';
import { emitRun, loadActiveRun, loadRun, toNodeRunDTO, toRunDTO, type RunRow } from './store.js';
import { checkEvidence, checkReview } from './validate.js';
import { freshSubsteps, stageProgress, substepStates } from './progress.js';

const log = createLogger('workflow');

/**
 * The workflow engine — the single source of truth for a run (spec §3.1, §5).
 * The server decides which stage is next; the main AI claims a token for it and
 * dispatches a sub-agent; the sub-agent submits evidence; the main AI reviews.
 * Nothing here trusts a model to remember the SOP.
 */

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

export const TOKEN_PREFIX = 'WF-';
const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SUBAGENT_REMINDERS = 2;
const TURN_END_REMINDERS = 2;

function newToken(): string {
  let s = TOKEN_PREFIX;
  for (let i = 0; i < 6; i++) s += TOKEN_CHARS[randomInt(TOKEN_CHARS.length)];
  return s;
}

const PLAN_STATUS: Record<string, PlanTaskStatus> = {
  pending: 'pending',
  dispatched: 'in_progress',
  submitted: 'in_progress',
  redo: 'in_progress',
  done: 'done',
  skipped: 'done',
  external: 'done',
  failed: 'failed',
  blocked: 'blocked',
  waiting_user: 'blocked',
};

function nodeOf(run: RunRow | WorkflowRunDTO, nodeId: string): WorkflowNodeDef {
  const graph = (run as WorkflowRunDTO).graph as WorkflowRunDTO['graph'];
  const n = graph.nodes.find((x) => x.id === nodeId);
  if (!n) throw new Error(`node ${nodeId} not in run graph`);
  return n;
}

function orderedSteps(run: WorkflowRunDTO): WorkflowNodeDef[] {
  const parsed = parseGraph(run.graph);
  return parsed.ok ? stepOrder(parsed.order, parsed.graph) : [];
}

function currentNodeRun(run: RunRow) {
  const c = run.cursor as WorkflowRunDTO['cursor'];
  if (!c) return null;
  return run.nodeRuns.find((n) => n.nodeId === c.nodeId && n.iterKey === c.iterKey) ?? null;
}

async function syncPlan(run: RunRow): Promise<void> {
  const dto = toRunDTO(run);
  const steps = orderedSteps(dto);
  // One row per stage, then its sub-steps indented under it (ids `<nodeRunId>:<substep>`).
  const rows = steps.flatMap((node) => {
    const nr = run.nodeRuns.find((x) => x.nodeId === node.id)!;
    const subs = substepStates(node, nr.substeps);
    const stage = {
      nodeRunId: nr.id,
      text: `【SOP】${node.title}`,
      status: PLAN_STATUS[nr.status] ?? 'pending',
      depth: 0,
      progress: stageProgress(nr.status, subs),
    };
    const stageDone = ['done', 'skipped', 'external'].includes(nr.status);
    return [
      stage,
      ...(node.substeps ?? []).map((def) => {
        const st = subs.find((x) => x.id === def.id)!;
        const resolved = stageDone || st.status !== 'pending';
        return {
          nodeRunId: `${nr.id}:${def.id}`,
          text: def.title,
          status: (resolved ? 'done' : 'pending') as PlanTaskStatus,
          reason: st.status === 'na' ? `不适用：${st.note ?? ''}` : null,
          depth: 1,
          progress: resolved ? 100 : 0,
        };
      }),
    ];
  });
  await syncLockedSteps(
    run.sessionId,
    rows,
    { scope: run.nodeRuns.flatMap((n) => [n.id, ...((dto.graph.nodes.find((x) => x.id === n.nodeId)?.substeps ?? []).map((s) => `${n.id}:${s.id}`))]) },
  ).catch((err) => log.warn('plan sync failed', err));
}

/** Persist side effects after a state change: reload, mirror into the plan, push to the UI. */
async function publish(runId: string): Promise<RunRow> {
  const run = (await loadRun(runId))!;
  await syncPlan(run);
  emitRun(run);
  return run;
}

async function findWorkflow(ref: string) {
  const key = ref.trim();
  const all = await prisma.workflow.findMany({ where: { status: { not: 'archived' } } });
  const lower = key.toLowerCase();
  return (
    all.find((w) => w.slug === key) ??
    all.find((w) => w.name.toLowerCase() === lower) ??
    all.find((w) => ((w.aliases as string[] | null) ?? []).some((a) => a.toLowerCase() === lower)) ??
    null
  );
}

async function catalogText(): Promise<string> {
  const ws = await prisma.workflow.findMany({ where: { status: 'confirmed' }, orderBy: { name: 'asc' } });
  return ws.length ? ws.map((w) => `- ${w.name}（${w.slug}）${w.whenToUse ? `：${w.whenToUse}` : ''}`).join('\n') : '（还没有已确认的 SOP）';
}

const turnReminders = new Map<string, number>();

/** Serialise every state transition per session: read-then-write must not interleave (two starts, submit vs force, accept vs redo). */
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(sessionId, tail);
  void tail.then(() => {
    if (locks.get(sessionId) === tail) locks.delete(sessionId);
  });
  return next;
}

export const workflowEngine = {
  async start(
    sessionId: string,
    input: { workflow: string; label?: string; inputs?: Record<string, unknown>; trigger?: 'manual' | 'chat' | 'cron' },
  ): Promise<{ ok: true; run: WorkflowRunDTO; message: string } | Fail> {
    return withLock(sessionId, async () => {
      const active = await loadActiveRun(sessionId);
      if (active) {
        return fail(`本会话已有进行中的工作流：${renderProgress(toRunDTO(active))}。一个会话同一时间只能跑一个运行；先完成它（或请用户取消）。`);
      }
      const wf = await findWorkflow(input.workflow);
      if (!wf) return fail(`找不到 SOP「${input.workflow}」。已确认的 SOP：\n${await catalogText()}`);
      if (wf.status !== 'confirmed' || !wf.confirmedVersion) {
        return fail(`SOP「${wf.name}」还是草稿，用户在流程图上确认后才能运行。`);
      }
      const version = await prisma.workflowVersion.findUnique({ where: { workflowId_version: { workflowId: wf.id, version: wf.confirmedVersion } } });
      const parsed = parseGraph(version?.graph);
      if (!version || !parsed.ok) {
        return fail(`SOP「${wf.name}」v${wf.confirmedVersion} 的流程定义无效：${parsed.ok ? '找不到版本' : parsed.errors.join('；')}`);
      }
      const steps = stepOrder(parsed.order, parsed.graph);
      const created = await prisma.workflowRun.create({
        data: {
          workflowId: wf.id,
          version: version.version,
          graph: parsed.graph as unknown as object,
          sessionId,
          label: input.label?.trim() || null,
          inputs: (input.inputs ?? undefined) as object | undefined,
          trigger: input.trigger ?? 'chat',
          cursor: { nodeId: steps[0]!.id, iterKey: '' },
          nodeRuns: { create: steps.map((s) => ({ nodeId: s.id, iterKey: '' })) },
        },
      });
      const run = await publish(created.id);
      // A live card for this run in the chat (renders from the run state; text = run id).
      const card = await prisma.message.create({ data: { sessionId, role: 'assistant', type: 'workflow_run', content: [] as unknown as object, text: run.id } });
      bus.emit({ type: 'assistant.message', sessionId, message: toMessageDTO(card) });
      log.info(`run ${run.id} started: ${wf.name} (${steps.length} stages) in session ${sessionId}`);
      return {
        ok: true,
        run: toRunDTO(run),
        message:
          `已启动「${wf.name}」${run.label ? `（${run.label}）` : ''}，共 ${steps.length} 个阶段：${steps.map((s) => s.title).join(' → ')}。\n` +
          '下一步：调用 workflow_next_stage 领取第一个阶段，按返回的说明用 Task 派副 AI。不要自己做阶段里的活，也不要转述 SOP 原文。',
      };
    });
  },

  async activeRun(sessionId: string): Promise<WorkflowRunDTO | null> {
    const r = await loadActiveRun(sessionId);
    return r ? toRunDTO(r) : null;
  },

  async nextStage(
    sessionId: string,
    opts: { force?: boolean } = {},
  ): Promise<{ ok: true; token: string; nodeId: string; title: string; taskHint: string } | Fail> {
    return withLock(sessionId, async () => {
      const run = await loadActiveRun(sessionId);
      if (!run) return fail('当前会话没有进行中的工作流运行。');
      const nr = currentNodeRun(run);
      if (!nr) return fail('运行没有当前阶段（可能已结束）。');
      const node = nodeOf(toRunDTO(run), nr.nodeId);
      if (run.pendingToken) {
        if (nr.status === 'submitted') return fail(`阶段「${node.title}」已提交证据，先审核：workflow_status 查看对照表，然后调用 workflow_review_stage。`);
        if (nr.status === 'dispatched' && !opts.force) {
          return fail(
            `阶段「${node.title}」已派给副 AI（令牌 ${run.pendingToken}），等它提交证据。` +
              '如果副 AI 已经异常结束、不会再提交，调用 workflow_next_stage({force:true}) 作废旧令牌并重新派发。',
          );
        }
      }
      if (!['pending', 'redo', 'dispatched'].includes(nr.status)) return fail(`阶段「${node.title}」当前状态是 ${nr.status}，不能领取。`);
      const token = newToken();
      await prisma.$transaction([
        prisma.workflowNodeRun.update({
          where: { id: nr.id },
          data: {
            status: 'dispatched',
            attempts: { increment: 1 },
            remindCount: 0,
            agentId: null,
            substeps: freshSubsteps(node) as unknown as object,
            startedAt: nr.startedAt ?? new Date(),
            ...(opts.force && nr.status === 'dispatched' ? { lastFeedback: nr.lastFeedback ?? '上一次派发的副 AI 异常结束，没有提交证据。请完整执行本阶段。' } : {}),
          },
        }),
        prisma.workflowRun.update({ where: { id: run.id }, data: { pendingToken: token } }),
      ]);
      await publish(run.id);
      const model = node.agent?.model;
      return {
        ok: true,
        token,
        nodeId: node.id,
        title: node.title,
        taskHint:
          `现在用 Task 工具派一个副 AI 执行阶段「${node.title}」：subagent_type 用 "general-purpose"${model ? `，model 用 "${model}"` : ''}。\n` +
          `prompt 第一行必须原样写：[${token}] ${node.title}\n` +
          '第二行起只写用户在本对话里的临时要求（如果有），系统会把完整的阶段卡片（SOP 原文、输入、完成标准、证据字段）发给副 AI——不要转述 SOP。\n' +
          '副 AI 结束后你会收到它的证据和审核对照表，再用 workflow_review_stage 审核。',
      };
    });
  },

  async bindAgent(sessionId: string, agentId: string, taskPrompt: string): Promise<string | null> {
    return withLock(sessionId, async () => {
      const run = await loadActiveRun(sessionId);
      if (!run?.pendingToken || !taskPrompt.includes(`[${run.pendingToken}]`)) return null;
      const nr = currentNodeRun(run);
      if (!nr || nr.status !== 'dispatched' || nr.agentId) return null;
      await prisma.workflowNodeRun.update({ where: { id: nr.id }, data: { agentId } });
      const fresh = (await publish(run.id))!;
      const dto = toRunDTO(fresh);
      const node = nodeOf(dto, nr.nodeId);
      const steps = orderedSteps(dto);
      const before = steps.slice(0, steps.findIndex((s) => s.id === node.id));
      const upstream = before
        .map((n) => ({ node: n, nodeRun: dto.nodeRuns.find((x) => x.nodeId === n.id)! }))
        .filter((u) => u.nodeRun && u.nodeRun.status === 'done')
        .map((u) => ({ ...u, outputDir: stageOutputDir(sessionId, run.id, u.node.id, u.nodeRun.iterKey) }));
      const mainNote = taskPrompt.split('\n').slice(1).join('\n').trim() || null;
      const inputs = fresh.inputs ? `运行输入：${JSON.stringify(fresh.inputs)}` : null;
      // Memory policy (spec: SOP text is the authority): `none` = a pure tool, no recall;
      // `skills` (default) = tool-usage know-how only, never preferences or old data.
      const recall =
        (node.memory ?? 'skills') === 'none'
          ? null
          : await recallBlock(`${node.title}\n${node.instructions ?? ''}`, {
              heading: '[知识图谱·与本阶段相关的工具用法经验]',
              kinds: ['skill'],
              k: 5,
            }).catch(() => null);
      return renderStageCard({
        run: dto,
        node,
        nodeRun: dto.nodeRuns.find((x) => x.id === nr.id)!,
        token: run.pendingToken,
        outputDir: stageOutputDir(sessionId, run.id, node.id, nr.iterKey),
        upstream,
        lastFeedback: nr.lastFeedback,
        mainNote: [mainNote, inputs].filter(Boolean).join('\n') || null,
        recall,
      });
    });
  },

  /** The memory policy of the stage a sub-agent is bound to (null = not a stage sub-agent). */
  async memoryModeOf(sessionId: string, agentId: string): Promise<'none' | 'skills' | null> {
    const run = await loadActiveRun(sessionId);
    const nr = run?.nodeRuns.find((n) => n.agentId === agentId);
    if (!run || !nr) return null;
    return nodeOf(toRunDTO(run), nr.nodeId).memory ?? 'skills';
  },

  async tokenOwner(sessionId: string, token: string): Promise<{ agentId: string | null; status: string } | null> {
    const run = await loadActiveRun(sessionId);
    if (!run || run.pendingToken !== token) return null;
    const nr = currentNodeRun(run);
    return nr ? { agentId: nr.agentId ?? null, status: nr.status } : null;
  },

  async submit(
    sessionId: string,
    input: { token: string; agentId: string; evidence: unknown; summary: string },
  ): Promise<{ ok: true; message: string } | Fail> {
    return withLock(sessionId, async () => {
      const run = await loadActiveRun(sessionId);
      if (!run) return fail('当前会话没有进行中的工作流运行。');
      if (!run.pendingToken || run.pendingToken !== input.token) return fail(`令牌 ${input.token} 无效或已过期（本阶段可能已被返工或重新派发）。停止工作，在最后回复里说明情况。`);
      const nr = currentNodeRun(run);
      if (!nr || nr.status !== 'dispatched') return fail('本阶段当前不接受提交（可能已经提交过）。');
      if (!nr.agentId || nr.agentId !== input.agentId) return fail('这个令牌不是派给你的，不能提交。');
      const node = nodeOf(toRunDTO(run), nr.nodeId);
      const open = substepStates(node, nr.substeps).filter((s) => s.status === 'pending');
      if (open.length) {
        const titles = open.map((s) => node.substeps!.find((d) => d.id === s.id)?.title ?? s.id);
        return fail(`还有 ${open.length} 个子步骤没有标记，不能提交：${titles.join('、')}。每个子步骤做完后调用 workflow_substep 标 done；确实不适用的标 na 并写原因。`);
      }
      const checked = checkEvidence(node.evidence ?? [], input.evidence);
      if (!checked.ok) return fail(`证据不完整，提交被退回，请修正后重新提交：\n${checked.errors.map((e) => `- ${e}`).join('\n')}`);
      // Text deliverables: the server writes them into the stage's output dir; evidence keeps the path.
      const textFields = (node.evidence ?? []).filter((f) => f.saveAs && typeof checked.value[f.key] === 'string');
      if (textFields.length) {
        const dir = stageOutputDir(sessionId, run.id, nr.nodeId, nr.iterKey);
        await fs.mkdir(dir, { recursive: true });
        for (const f of textFields) {
          const file = path.join(dir, f.saveAs!);
          await fs.writeFile(file, String(checked.value[f.key]), 'utf8');
          checked.value[f.key] = file;
        }
      }
      await prisma.workflowNodeRun.update({
        where: { id: nr.id },
        data: { status: 'submitted', evidence: checked.value as object, summary: input.summary?.trim() || null },
      });
      await publish(run.id);
      return { ok: true, message: '证据已提交，主 AI 会审核。现在结束：最后回复用一段话总结本阶段的结果和异常。' };
    });
  },

  /** The stage's sub-agent marks one sub-step done (or na, with a reason). */
  async substep(
    sessionId: string,
    input: { token: string; agentId: string; substep: string; status: 'done' | 'na'; note?: string },
  ): Promise<{ ok: true; message: string } | Fail> {
    return withLock(sessionId, async () => {
      const run = await loadActiveRun(sessionId);
      if (!run?.pendingToken || run.pendingToken !== input.token) return fail(`令牌 ${input.token} 无效或已过期。`);
      const nr = currentNodeRun(run);
      if (!nr || nr.status !== 'dispatched') return fail('本阶段当前不在执行中。');
      if (!nr.agentId || nr.agentId !== input.agentId) return fail('这个令牌不是派给你的。');
      const node = nodeOf(toRunDTO(run), nr.nodeId);
      const states = substepStates(node, nr.substeps);
      const target = states.find((s) => s.id === input.substep);
      if (!target) {
        return fail(`没有子步骤「${input.substep}」。本阶段的子步骤：${(node.substeps ?? []).map((s) => `${s.id}（${s.title}）`).join('、') || '无'}`);
      }
      if (input.status === 'na' && (input.note ?? '').trim().length < 4) return fail('标 na（不适用）必须写原因（至少 4 个字）。');
      target.status = input.status;
      target.note = input.note?.trim() || null;
      await prisma.workflowNodeRun.update({ where: { id: nr.id }, data: { substeps: states as unknown as object } });
      await publish(run.id);
      const left = states.filter((s) => s.status === 'pending').length;
      return { ok: true, message: left ? `已标记。还剩 ${left} 个子步骤。` : '所有子步骤都已标记，可以提交证据了。' };
    });
  },

  async onSubagentStop(sessionId: string, agentId: string): Promise<string | null> {
    return withLock(sessionId, async () => {
      const run = await loadActiveRun(sessionId);
      if (!run) return null;
      const nr = currentNodeRun(run);
      if (!nr || nr.agentId !== agentId || nr.status !== 'dispatched') return null;
      const node = nodeOf(toRunDTO(run), nr.nodeId);
      if (nr.remindCount < SUBAGENT_REMINDERS) {
        await prisma.workflowNodeRun.update({ where: { id: nr.id }, data: { remindCount: { increment: 1 } } });
        log.info(`nudged sub-agent ${agentId} on stage ${nr.nodeId} (#${nr.remindCount + 1}): no evidence yet`);
        return (
          `[工作流] 你还没有提交本阶段「${node.title}」的证据，不能结束。` +
          `请调用 mcp__chapi__workflow_submit_stage，token="${run.pendingToken}"，evidence 包含：${(node.evidence ?? []).map((f) => f.key).join('、')}。` +
          '确实做不完的部分如实写进 summary 和证据，不要编造。'
        );
      }
      await prisma.$transaction([
        prisma.workflowNodeRun.update({
          where: { id: nr.id },
          data: {
              status: 'redo',
              agentId: null,
              lastFeedback: [nr.lastFeedback, '另外：上一个副 AI 没有提交证据就结束了。请完整执行本阶段，并在结束前调用 workflow_submit_stage。']
                .filter(Boolean)
                .join('\n'),
            },
        }),
        prisma.workflowRun.update({ where: { id: run.id }, data: { pendingToken: null } }),
      ]);
      await publish(run.id);
      return null;
    });
  },

  async review(
    sessionId: string,
    input: { decision: 'accept' | 'redo'; perCriterion?: CriterionVerdict[]; feedback?: string },
  ): Promise<{ ok: true; message: string } | Fail> {
    return withLock(sessionId, async () => {
      const run = await loadActiveRun(sessionId);
      if (!run) return fail('当前会话没有进行中的工作流运行。');
      const nr = currentNodeRun(run);
      if (!nr || nr.status !== 'submitted') return fail('当前没有待审核的阶段。');
      const dto = toRunDTO(run);
      const node = nodeOf(dto, nr.nodeId);
      const review = { decision: input.decision, perCriterion: input.perCriterion ?? [], feedback: input.feedback?.trim() || null };
      if (input.decision === 'redo') {
        if (!review.feedback) return fail('返工必须写 feedback：哪里不达标、要怎么补。');
        await prisma.$transaction([
          prisma.workflowNodeRun.update({
            where: { id: nr.id },
            data: { status: 'redo', review: review as object, lastFeedback: review.feedback, agentId: null },
          }),
          prisma.workflowRun.update({ where: { id: run.id }, data: { pendingToken: null } }),
        ]);
        await publish(run.id);
        return { ok: true, message: `已退回阶段「${node.title}」。调用 workflow_next_stage 重新派发，新的副 AI 会收到你的返工意见。` };
      }
      const checked = checkReview(node.doneCriteria ?? [], review.perCriterion);
      if (!checked.ok) return fail(`审核不完整：\n${checked.errors.map((e) => `- ${e}`).join('\n')}`);
      const steps = orderedSteps(dto);
      const next = steps[steps.findIndex((s) => s.id === node.id) + 1] ?? null;
      await prisma.$transaction([
        prisma.workflowNodeRun.update({ where: { id: nr.id }, data: { status: 'done', review: review as object, endedAt: new Date() } }),
        prisma.workflowRun.update({
          where: { id: run.id },
          data: next
            ? { pendingToken: null, cursor: { nodeId: next.id, iterKey: '' } }
            : { pendingToken: null, cursor: Prisma.DbNull, status: 'done', endedAt: new Date() },
        }),
      ]);
      await publish(run.id);
      return {
        ok: true,
        message: next
          ? `阶段「${node.title}」已通过。下一个阶段：「${next.title}」——调用 workflow_next_stage 领取。`
          : `阶段「${node.title}」已通过，「${dto.workflowName}」全部阶段完成。现在可以整理成果并调用 request_approval 提交给用户。`,
      };
    });
  },

  /** User-initiated cancel: ends the run, frees approval, stops the nudges; unfinished SOP rows are marked blocked. */
  async cancel(sessionId: string, runId: string, reason?: string): Promise<{ ok: true; message: string } | Fail> {
    return withLock(sessionId, async () => {
      const run = await loadRun(runId);
      if (!run || run.sessionId !== sessionId) return fail('找不到这个运行。');
      if (!['running', 'waiting_user', 'blocked'].includes(run.status)) return fail(`这个运行已经是 ${run.status} 状态。`);
      const why = reason?.trim() || '用户取消了工作流';
      await prisma.$transaction([
        prisma.workflowNodeRun.updateMany({
          where: { runId, status: { notIn: ['done', 'skipped', 'external'] } },
          data: { status: 'blocked', skipReason: why, agentId: null },
        }),
        prisma.workflowRun.update({ where: { id: runId }, data: { status: 'cancelled', pendingToken: null, endedAt: new Date() } }),
      ]);
      const fresh = (await loadRun(runId))!;
      await syncLockedSteps(
        sessionId,
        orderedSteps(toRunDTO(fresh)).map((node) => {
          const nr = fresh.nodeRuns.find((x) => x.nodeId === node.id)!;
          return {
            nodeRunId: nr.id,
            text: `【SOP】${node.title}`,
            status: PLAN_STATUS[nr.status] ?? 'blocked',
            reason: nr.status === 'blocked' ? why : undefined,
          };
        }),
        { scope: fresh.nodeRuns.map((n) => n.id) },
      ).catch((err) => log.warn('plan sync failed', err));
      emitRun(fresh);
      log.info(`run ${runId} cancelled: ${why}`);
      return { ok: true, message: `已取消「${fresh.workflow.name}」：${why}` };
    });
  },

  async reviewSheet(sessionId: string): Promise<string | null> {
    const run = await loadActiveRun(sessionId);
    const nr = run ? currentNodeRun(run) : null;
    if (!run || !nr || nr.status !== 'submitted') return null;
    return renderReviewSheet(nodeOf(toRunDTO(run), nr.nodeId), toNodeRunDTO(nr, run.graph as unknown as WorkflowRunDTO['graph']));
  },

  async statusText(sessionId: string): Promise<string> {
    const run = await loadActiveRun(sessionId);
    if (!run) return '当前会话没有进行中的工作流。';
    const dto = toRunDTO(run);
    const lines = orderedSteps(dto).map((n, i) => {
      const nr = dto.nodeRuns.find((x) => x.nodeId === n.id);
      return `${i + 1}. [${nr?.status ?? 'pending'}] ${n.title}${nr?.attempts && nr.attempts > 1 ? `（第 ${nr.attempts} 次）` : ''}`;
    });
    return [renderProgress(dto), ...lines].join('\n');
  },

  async approvalBlock(sessionId: string): Promise<string | null> {
    const run = await loadActiveRun(sessionId);
    if (!run) return null;
    return `还不能提交审批：工作流「${run.workflow.name}」还没走完（${renderProgress(toRunDTO(run))}）。所有阶段都审核通过后才能调用 request_approval。`;
  },

  async turnEndReminder(sessionId: string): Promise<string | null> {
    const run = await loadActiveRun(sessionId);
    if (!run || run.status !== 'running') return null;
    const nr = currentNodeRun(run);
    if (!nr) return null;
    const key = `${nr.id}:${nr.attempts}:${nr.status}`;
    const n = turnReminders.get(key) ?? 0;
    if (n >= TURN_END_REMINDERS) return null;
    turnReminders.set(key, n + 1);
    const dto = toRunDTO(run);
    const node = nodeOf(dto, nr.nodeId);
    const { index, total } = stagePosition(dto, node.id);
    const head = `[工作流] 「${dto.workflowName}」还没走完（阶段 ${index}/${total}「${node.title}」），先别结束这一轮：`;
    switch (nr.status) {
      case 'pending':
      case 'redo':
        return `${head}调用 workflow_next_stage 领取这个阶段，然后用 Task 派副 AI。`;
      case 'dispatched':
        return `${head}这个阶段已派发但还没提交证据。如果副 AI 已经结束、不会再提交，调用 workflow_next_stage({force:true}) 重新派发。`;
      case 'submitted':
        return `${head}副 AI 已提交，调用 workflow_status 看审核对照表，再用 workflow_review_stage 审核。`;
      default:
        return null;
    }
  },
};

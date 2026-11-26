import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CreateSessionInput,
  PermissionProfile,
  RunState,
  SessionDetailResponse,
  SessionDTO,
  SessionSearchResponse,
} from '@chapi/shared';
import { config, sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { listSessionRuns } from '../workflow/store.js';
import { HITL_MESSAGE_TYPES } from '../engine/hitlTranscript.js';
import { hitl } from '../engine/hitl.js';
import { createLogger } from '../logger.js';
import {
  toAgentRunDTO,
  toApprovalDTO,
  toArtifactDTO,
  toAttachmentDTO,
  toMessageDTO,
  toPendingQuestionDTO,
  toPlanTaskDTO,
  toSessionDTO,
} from '../mappers.js';
import { settings } from '../secrets.js';
import { getOrchestrator } from '../orchestrator/types.js';
import { ensureSandboxHelpers } from './workspaces.js';
import { generateSessionTitle, setTitleKeepingOrder } from '../learning/title.js';
import { deriveTitle, makeSessionSlug } from '../util/ids.js';

const log = createLogger('sessions');

const MEMORY_INDEX = `# 记忆 (Memory) — 会话私有

本目录只属于当前会话，会话被删除时一并删除。

存放：
- \`plan.json\` — 当前任务计划
- \`conversation/\` — 对话历史与每 5 轮摘要
- \`subagents/\` — 各子代理的临时数据
- \`web-cache/\` — 网页抓取结果缓存
- 任何本工作流内需要的临时记忆

限制：仅当前会话可读写；不要写入用户最终产物（产物放 \`../sandbox\`）。
`;

const SANDBOX_INDEX = `# 沙盘 (Sandbox) — 会话私有

AI 可自由支配的工作空间：创建/编辑 Excel、Doc、下载文件、生成 PDF 等。
文件类产物默认产出在这里；最终优先上传到 Google Drive 并返回链接。

会话被删除时本目录一并删除。
`;

async function scaffoldSessionDirs(sessionId: string): Promise<void> {
  const p = sessionPaths(sessionId);
  await fs.mkdir(p.memory, { recursive: true });
  await fs.mkdir(p.sandbox, { recursive: true });
  await fs.mkdir(path.join(p.memory, 'conversation'), { recursive: true });
  await fs.mkdir(path.join(p.memory, 'subagents'), { recursive: true });
  await fs.mkdir(path.join(p.memory, 'web-cache'), { recursive: true });
  await fs.writeFile(path.join(p.memory, 'INDEX.md'), MEMORY_INDEX, 'utf8');
  await fs.writeFile(path.join(p.sandbox, 'INDEX.md'), SANDBOX_INDEX, 'utf8');
  await ensureSandboxHelpers(p.sandbox);
}

export async function createSession(input: CreateSessionInput): Promise<SessionDTO> {
  const models = await settings.getModels();
  const slug = makeSessionSlug(input.firstMessage);
  const title = input.title ?? deriveTitle(input.firstMessage);
  const profile: PermissionProfile = input.permissionProfile ?? 'web';

  const session = await prisma.session.create({
    data: {
      slug,
      title,
      // An explicit title is the caller's own; otherwise it's a placeholder until the AI titles it.
      titleSource: input.title ? 'user' : 'auto',
      model: input.model ?? models.main,
      subagentModel: input.subagentModel ?? models.subagent,
      permissionProfile: profile,
      status: 'active',
      // Initial config from the home page; omit → Prisma column defaults apply.
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.language ? { language: input.language } : {}),
      ...(input.accountMode ? { accountMode: input.accountMode } : {}),
      ...(input.qualityReviewMinutes !== undefined
        ? { qualityReviewMinutes: input.qualityReviewMinutes }
        : {}),
      ...(input.qualityModel ? { qualityModel: input.qualityModel } : {}),
    },
  });

  await scaffoldSessionDirs(session.id);
  const dto = toSessionDTO(session);
  bus.emit({ type: 'session.created', session: dto });
  log.info(`created session ${session.id} (${slug})`);
  return dto;
}

export async function listSessions(): Promise<SessionDTO[]> {
  const rows = await prisma.session.findMany({
    where: { status: { not: 'deleted' } },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toSessionDTO);
}

export async function getSessionBySlug(slug: string): Promise<SessionDTO | null> {
  const s = await prisma.session.findUnique({ where: { slug } });
  return s ? toSessionDTO(s) : null;
}

// Long sessions can accumulate thousands of messages; loading and rendering them
// all at once is what makes the chat sluggish to open. Only the most recent page
// loads up front — older ones page in on demand via getEarlierMessages().
const MESSAGE_PAGE_SIZE = 200;

/**
 * The session's live run state for a client that is (re)loading. A run that was
 * torn down without emitting 'idle' (stop/delete) has no Run any more, so it
 * can't still be 'running'/'paused'.
 */
export function currentRunState(sessionId: string): RunState {
  const st = bus.lastRunState(sessionId);
  if ((st === 'running' || st === 'paused') && !getOrchestrator().isActive(sessionId)) return 'idle';
  return st;
}

export async function getSessionDetail(
  id: string,
): Promise<SessionDetailResponse | null> {
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) return null;
  await reconcileAgents(id);
  const [messageCount, recentMessagesDesc, plan, agents, artifacts, attachments, openQuestions, openApprovals] =
    await Promise.all([
      prisma.message.count({ where: { sessionId: id } }),
      prisma.message.findMany({
        where: { sessionId: id },
        orderBy: { createdAt: 'desc' },
        take: MESSAGE_PAGE_SIZE,
      }),
      prisma.planTask.findMany({ where: { sessionId: id }, orderBy: { ordinal: 'asc' } }),
      prisma.agentRun.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.artifact.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.attachment.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.pendingQuestion.findMany({ where: { sessionId: id, status: 'open' } }),
      prisma.approval.findMany({ where: { sessionId: id, status: 'open' }, orderBy: { createdAt: 'asc' } }),
    ]);
  const messages = recentMessagesDesc.slice().reverse();
  const workflowRuns = await listSessionRuns(id).catch(() => []);
  return {
    session: toSessionDTO(session),
    messages: messages.map(toMessageDTO),
    hasMoreMessages: messageCount > messages.length,
    plan: plan.map(toPlanTaskDTO),
    agents: agents.map(toAgentRunDTO),
    artifacts: artifacts.map(toArtifactDTO),
    attachments: attachments.map(toAttachmentDTO),
    openQuestions: openQuestions.map(toPendingQuestionDTO),
    // Only approvals a live run is actually waiting on — rows left 'open' by a
    // run that died (e.g. server restart) can't be answered, so don't show them.
    openApprovals: openApprovals.filter((a) => hitl.hasApproval(a.id)).map(toApprovalDTO),
    workflowRuns,
    runState: currentRunState(id),
  };
}

/**
 * A page of messages strictly older than `beforeMessageId`, oldest-to-newest —
 * for the chat's infinite-scroll-up. `hasMore` tells the client whether to keep
 * offering to load further back.
 */
export async function getEarlierMessages(
  sessionId: string,
  beforeMessageId: string,
  limit = MESSAGE_PAGE_SIZE,
): Promise<{ messages: ReturnType<typeof toMessageDTO>[]; hasMore: boolean }> {
  const anchor = await prisma.message.findUnique({
    where: { id: beforeMessageId },
    select: { createdAt: true },
  });
  if (!anchor) return { messages: [], hasMore: false };
  const rows = await prisma.message.findMany({
    where: { sessionId, createdAt: { lt: anchor.createdAt } },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return { messages: page.map(toMessageDTO), hasMore };
}

/**
 * Clean up an agent list before display: collapse duplicate "main" rows (left by
 * earlier runs/restarts) into one, and — when no run is active — mark agents stuck
 * in "running" (from a killed process) as interrupted.
 */
async function reconcileAgents(sessionId: string): Promise<void> {
  const mains = await prisma.agentRun.findMany({
    where: { sessionId, name: 'main' },
    orderBy: { createdAt: 'asc' },
  });
  if (mains.length > 1) {
    const keep = mains[mains.length - 1];
    const dropIds = mains.filter((m) => m.id !== keep?.id).map((m) => m.id);
    if (dropIds.length) await prisma.agentRun.deleteMany({ where: { id: { in: dropIds } } });
  }
  if (!getOrchestrator().isActive(sessionId)) {
    await prisma.agentRun.updateMany({
      where: { sessionId, status: 'running' },
      data: { status: 'interrupted', currentTool: null, currentActivity: null },
    });
  }
}

export async function deleteSession(id: string): Promise<void> {
  // DB children cascade via Prisma relations. Then remove the private dirs.
  await prisma.session.delete({ where: { id } }).catch((err) => {
    log.warn(`delete session ${id} db error`, err);
  });
  const p = sessionPaths(id);
  await fs.rm(p.root, { recursive: true, force: true }).catch(() => undefined);
  log.info(`deleted session ${id} (db + ${p.root})`);
}

/** Mark a session completed (read-only). Learning consolidation is triggered separately. */
export async function setSessionStatus(
  id: string,
  status: 'active' | 'completed',
): Promise<SessionDTO | null> {
  const s = await prisma.session.update({ where: { id }, data: { status } });
  const dto = toSessionDTO(s);
  bus.emit({ type: 'session.updated', session: dto });
  return dto;
}

/**
 * Rename a session. A non-empty title is the user's own and the AI will never
 * overwrite it; an empty one hands the title back to the AI, which regenerates
 * it from the conversation. Keeps the session's place in the history list.
 */
export async function renameSession(id: string, rawTitle: string): Promise<SessionDTO | null> {
  const existing = await prisma.session.findUnique({ where: { id } });
  if (!existing) return null;
  const title = rawTitle.replace(/\s+/g, ' ').trim();
  if (title) {
    await setTitleKeepingOrder(id, title, 'user');
  } else {
    // Keep showing the current title until the regenerated one lands (pushed via session.updated).
    await setTitleKeepingOrder(id, existing.title, 'auto');
    void generateSessionTitle(id);
  }
  const s = await prisma.session.findUnique({ where: { id } });
  if (!s) return null;
  const dto = toSessionDTO(s);
  bus.emit({ type: 'session.updated', session: dto });
  return dto;
}

const SEARCH_SCAN_LIMIT = 600;
const MATCHES_PER_SESSION = 3;
const SNIPPET_CHARS = 120;

/** Message text as plain prose for a one-line preview: no Markdown emphasis, headings, code ticks or link URLs. */
function plainText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`+|~~)/g, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ~SNIPPET_CHARS of `text` around the first case-insensitive hit of `q`, on one line. */
function snippetAround(text: string, q: string): string {
  const flat = plainText(text);
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return flat.slice(0, SNIPPET_CHARS);
  const lead = Math.floor((SNIPPET_CHARS - q.length) / 3);
  const start = Math.max(0, at - lead);
  const end = Math.min(flat.length, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Full-text search over what was actually said in each conversation (user turns
 * and the AI's visible replies, plus approval/question round-trips — not
 * thinking, tool calls or quality reviews).
 * Plain LIKE on the utf8mb4_unicode_ci column: case-insensitive and works for
 * Chinese without a tokenizer; fast enough at tens of thousands of messages.
 */
export async function searchSessions(rawQuery: string): Promise<SessionSearchResponse> {
  const q = rawQuery.trim();
  if (!q) return { results: [] };
  const where = {
    role: { in: ['user', 'assistant'] },
    type: { in: ['user', 'assistant', ...HITL_MESSAGE_TYPES] },
    text: { contains: q },
    session: { status: { not: 'deleted' } },
  };
  const [counts, rows] = await Promise.all([
    prisma.message.groupBy({ by: ['sessionId'], where, _count: { _all: true } }),
    prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: SEARCH_SCAN_LIMIT,
      select: { id: true, sessionId: true, role: true, text: true, createdAt: true },
    }),
  ]);
  const bySession = new Map<string, SessionSearchResponse['results'][number]>();
  for (const c of counts) {
    bySession.set(c.sessionId, { sessionId: c.sessionId, matchCount: c._count._all, matches: [] });
  }
  for (const r of rows) {
    const entry = bySession.get(r.sessionId);
    if (!entry || entry.matches.length >= MATCHES_PER_SESSION) continue;
    entry.matches.push({
      messageId: r.id,
      role: r.role as 'user' | 'assistant',
      snippet: snippetAround(r.text, q),
      createdAt: r.createdAt.toISOString(),
    });
  }
  return { results: [...bySession.values()] };
}

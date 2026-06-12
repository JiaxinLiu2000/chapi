import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CreateSessionInput,
  PermissionProfile,
  SessionDetailResponse,
  SessionDTO,
} from '@chapi/shared';
import { config, sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import {
  toAgentRunDTO,
  toArtifactDTO,
  toAttachmentDTO,
  toMessageDTO,
  toPendingQuestionDTO,
  toPlanTaskDTO,
  toSessionDTO,
} from '../mappers.js';
import { settings } from '../secrets.js';
import { getOrchestrator } from '../orchestrator/types.js';
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
      model: input.model ?? models.main,
      permissionProfile: profile,
      status: 'active',
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

export async function getSessionDetail(
  id: string,
): Promise<SessionDetailResponse | null> {
  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) return null;
  await reconcileAgents(id);
  const [messages, plan, agents, artifacts, attachments, openQuestions] =
    await Promise.all([
      prisma.message.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.planTask.findMany({ where: { sessionId: id }, orderBy: { ordinal: 'asc' } }),
      prisma.agentRun.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.artifact.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.attachment.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.pendingQuestion.findMany({ where: { sessionId: id, status: 'open' } }),
    ]);
  return {
    session: toSessionDTO(session),
    messages: messages.map(toMessageDTO),
    plan: plan.map(toPlanTaskDTO),
    agents: agents.map(toAgentRunDTO),
    artifacts: artifacts.map(toArtifactDTO),
    attachments: attachments.map(toAttachmentDTO),
    openQuestions: openQuestions.map(toPendingQuestionDTO),
  };
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

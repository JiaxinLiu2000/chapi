import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BoardProjectsDTO } from '@chapi/shared';
import { prisma } from '../../db/client.js';
import { bus } from '../../gateway/bus.js';
import { classifyAll, isClassifying, summarizeProject } from '../../board/classify.js';
import { automationDTOs, createAutomation, deleteAutomation, runNow, updateAutomation } from '../../board/service.js';
import { getBoardToday } from '../../board/today.js';
import { createLogger } from '../../logger.js';
import { toProjectDTO, toSessionDTO } from '../../mappers.js';
import { fromWebUI } from '../originGuard.js';

const log = createLogger('board-routes');
const changed = () => bus.emit({ type: 'board.changed' });

/** Mutating board routes must come from the chapi web UI (the AI's shell may not call them). */
function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  if (fromWebUI(req.headers.origin)) return true;
  void reply.status(403).send({ error: '只能由用户在 chapi 页面上操作。' });
  return false;
}

/** Set a session's project without bumping updatedAt (it would flood "today"). */
async function assignSession(sessionId: string, projectId: string | null): Promise<void> {
  await prisma.$executeRaw`UPDATE \`Session\` SET projectId = ${projectId}, projectSource = 'user' WHERE id = ${sessionId}`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  // ── today ────────────────────────────────────────────────────────────────
  app.get('/board/today', async () => getBoardToday());

  // ── projects ─────────────────────────────────────────────────────────────
  app.get('/board/projects', async (): Promise<BoardProjectsDTO> => {
    const [projects, stats, unassignedCount] = await Promise.all([
      prisma.project.findMany({ where: { archived: false }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
      prisma.session.groupBy({
        by: ['projectId'],
        where: { status: { not: 'deleted' }, projectId: { not: null } },
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      prisma.session.count({ where: { status: { not: 'deleted' }, projectId: null } }),
    ]);
    const byId = new Map(stats.map((s) => [s.projectId, s]));
    return {
      projects: projects.map((p) => {
        const s = byId.get(p.id);
        return toProjectDTO(p, { sessionCount: s?._count._all ?? 0, lastActivityAt: s?._max.updatedAt ?? null });
      }),
      unassignedCount,
      classifying: isClassifying(),
    };
  });

  // :id may be the literal "unassigned" for sessions with no project.
  app.get<{ Params: { id: string } }>('/board/projects/:id/sessions', async (req, reply) => {
    const id = req.params.id;
    if (id !== 'unassigned' && !(await prisma.project.findUnique({ where: { id }, select: { id: true } }))) {
      return reply.status(404).send({ error: '找不到这个项目。' });
    }
    const rows = await prisma.session.findMany({
      where: { status: { not: 'deleted' }, projectId: id === 'unassigned' ? null : id },
      orderBy: { updatedAt: 'desc' },
    });
    return { sessions: rows.map(toSessionDTO) };
  });

  const projectName = async (raw: unknown, exceptId?: string): Promise<{ ok: true; name: string } | { ok: false; status: number; error: string }> => {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length < 1 || name.length > 40) return { ok: false, status: 400, error: '项目名要 1–40 个字。' };
    const dup = await prisma.project.findFirst({ where: { archived: false, name, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (dup) return { ok: false, status: 409, error: '已经有同名项目了。' };
    return { ok: true, name };
  };

  app.post('/board/projects', async (req, reply) => {
    if (!guard(req, reply)) return;
    const n = await projectName((req.body as { name?: unknown } | null)?.name);
    if (!n.ok) return reply.status(n.status).send({ error: n.error });
    const max = await prisma.project.aggregate({ _max: { sortOrder: true } });
    const p = await prisma.project.create({ data: { name: n.name, sortOrder: (max._max.sortOrder ?? -1) + 1 } });
    changed();
    return reply.status(201).send({ project: toProjectDTO(p, { sessionCount: 0, lastActivityAt: null }) });
  });

  app.patch<{ Params: { id: string } }>('/board/projects/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body ?? {}) as { name?: unknown; sortOrder?: unknown };
    const p = await prisma.project.findUnique({ where: { id: req.params.id } });
    if (!p || p.archived) return reply.status(404).send({ error: '找不到这个项目。' });
    const data: { name?: string; sortOrder?: number } = {};
    if (body.name !== undefined) {
      const n = await projectName(body.name, p.id);
      if (!n.ok) return reply.status(n.status).send({ error: n.error });
      data.name = n.name;
    }
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== 'number' || !Number.isInteger(body.sortOrder)) return reply.status(400).send({ error: '排序必须是整数。' });
      data.sortOrder = body.sortOrder;
    }
    const u = await prisma.project.update({ where: { id: p.id }, data });
    changed();
    return { project: toProjectDTO(u, { sessionCount: 0, lastActivityAt: null }) };
  });

  app.post<{ Params: { id: string } }>('/board/projects/:id/merge', async (req, reply) => {
    if (!guard(req, reply)) return;
    const intoId = str((req.body as { intoId?: unknown } | null)?.intoId);
    if (!intoId || intoId === req.params.id) return reply.status(400).send({ error: '请选择另一个项目来合并。' });
    const [from, into] = await Promise.all([
      prisma.project.findUnique({ where: { id: req.params.id } }),
      prisma.project.findUnique({ where: { id: intoId } }),
    ]);
    if (!from || from.archived || !into || into.archived) return reply.status(404).send({ error: '找不到这个项目。' });
    // keep projectSource as is; no updatedAt bump
    await prisma.$transaction([
      prisma.$executeRaw`UPDATE \`Session\` SET projectId = ${into.id} WHERE projectId = ${from.id}`,
      prisma.automation.updateMany({ where: { projectId: from.id }, data: { projectId: into.id } }),
      prisma.project.update({ where: { id: from.id }, data: { archived: true } }),
    ]);
    changed();
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>('/sessions/:id/project', async (req, reply) => {
    if (!guard(req, reply)) return;
    const pid = (req.body as { projectId?: unknown } | null)?.projectId;
    if (pid !== null && typeof pid !== 'string') return reply.status(400).send({ error: 'projectId 必须是项目 id 或 null。' });
    const s = await prisma.session.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!s) return reply.status(404).send({ error: 'session not found' });
    if (pid && !(await prisma.project.findFirst({ where: { id: pid, archived: false }, select: { id: true } }))) {
      return reply.status(404).send({ error: '找不到这个项目。' });
    }
    await assignSession(s.id, pid);
    changed();
    return { ok: true };
  });

  app.post('/board/classify', async (req, reply) => {
    if (!guard(req, reply)) return;
    void classifyAll().catch((err) => log.warn('classifyAll failed', err));
    changed(); // other open boards pick up classifying=true
    return reply.status(202).send({ started: true });
  });

  app.post<{ Params: { id: string } }>('/board/projects/:id/summary', async (req, reply) => {
    if (!guard(req, reply)) return;
    const p = await prisma.project.findUnique({ where: { id: req.params.id }, select: { id: true, archived: true } });
    if (!p || p.archived) return reply.status(404).send({ error: '找不到这个项目。' });
    await summarizeProject(p.id);
    changed();
    const row = await prisma.project.findUniqueOrThrow({ where: { id: p.id } });
    return { project: toProjectDTO(row, { sessionCount: 0, lastActivityAt: null }) };
  });

  // ── automations (validation + side effects live in board/service.ts) ──────
  app.get('/board/automations', async () => ({ automations: await automationDTOs() }));

  const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;

  app.post('/board/automations', async (req, reply) => {
    if (!guard(req, reply)) return;
    const r = await createAutomation(body(req));
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return reply.status(201).send({ automation: r.value });
  });

  app.patch<{ Params: { id: string } }>('/board/automations/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const r = await updateAutomation(req.params.id, body(req));
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return { automation: r.value };
  });

  app.delete<{ Params: { id: string } }>('/board/automations/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const r = await deleteAutomation(req.params.id);
    if (!r.ok) return reply.status(r.status).send({ error: r.error });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/board/automations/:id/run', async (req, reply) => {
    if (!guard(req, reply)) return;
    const r = await runNow(req.params.id);
    if (r.ok) return { run: r.run };
    if (r.status === 404) return reply.status(404).send({ error: r.error });
    return reply.status(r.status).send({ error: r.error, runId: r.runId, sessionSlug: r.sessionSlug });
  });

  app.post<{ Params: { id: string } }>('/board/automation-runs/:id/dismiss', async (req, reply) => {
    if (!guard(req, reply)) return;
    const r = await prisma.automationRun.updateMany({
      where: { id: req.params.id, status: { in: ['waiting_user', 'stale'] } },
      data: { status: 'failed', note: '用户关闭', endedAt: new Date() },
    });
    if (r.count === 0) {
      const exists = await prisma.automationRun.findUnique({ where: { id: req.params.id }, select: { id: true } });
      return reply.status(exists ? 409 : 404).send({ error: exists ? '这次运行已经结束，不需要关闭。' : '找不到这次运行。' });
    }
    const run = await prisma.automationRun.findUniqueOrThrow({ where: { id: req.params.id } });
    const newest = await prisma.automationRun.findFirst({ where: { automationId: run.automationId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], select: { id: true } });
    if (newest?.id === run.id) await prisma.automation.update({ where: { id: run.automationId }, data: { lastStatus: 'failed' } }).catch(() => undefined);
    changed();
    return { ok: true };
  });
}

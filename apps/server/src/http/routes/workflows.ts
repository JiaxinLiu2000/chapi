import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WorkflowSummaryDTO } from '@chapi/shared';
import { fromWebUI } from '../originGuard.js';
import { prisma } from '../../db/client.js';
import { workflowEngine } from '../../workflow/engine.js';
import { notifyMainAI } from '../../workflow/notify.js';
import { parseGraph } from '../../workflow/schema.js';
import { listSessionRuns } from '../../workflow/store.js';
import { confirmLatestDraft, draftChanges, findWorkflowRef, saveDraft, toDetail, toSummary } from '../../workflow/drafts.js';

const createSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(120).optional(),
  aliases: z.array(z.string()).optional(),
  whenToUse: z.string().optional(),
  description: z.string().optional(),
  sourceRef: z.string().optional(),
  graph: z.unknown(),
  /** Ignored: an SOP only becomes runnable when the user confirms it in the web UI. */
  confirm: z.boolean().optional(),
});

const draftSchema = z.object({
  graph: z.unknown(),
  note: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  whenToUse: z.string().optional(),
  description: z.string().optional(),
  sourceRef: z.string().optional(),
});

const slugify = (name: string) =>
  (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sop') + `-${Date.now().toString(36)}`;

export async function workflowRoutes(app: FastifyInstance): Promise<void> {
  app.get('/workflows', async (): Promise<WorkflowSummaryDTO[]> => {
    const ws = await prisma.workflow.findMany({
      where: { status: { not: 'archived' } },
      orderBy: { name: 'asc' },
      include: { versions: { select: { version: true, state: true } } },
    });
    return ws.map(toSummary);
  });

  app.get<{ Params: { ref: string } }>('/workflows/:ref', async (req, reply) => {
    const w = await findWorkflowRef(req.params.ref);
    if (!w) return reply.status(404).send({ error: 'not found' });
    return { ...toDetail(w), pendingChanges: draftChanges(w) };
  });

  app.post('/workflows', async (req, reply) => {
    const body = createSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ errors: body.error.issues.map((i) => `${i.path.join('.')}：${i.message}`) });
    const g = parseGraph(body.data.graph);
    if (!g.ok) return reply.status(400).send({ errors: g.errors });
    const confirm = false; // drafts only — see POST /workflows/:ref/confirm
    const w = await prisma.workflow.create({
      data: {
        slug: body.data.slug ?? slugify(body.data.name),
        name: body.data.name,
        aliases: body.data.aliases ?? [],
        whenToUse: body.data.whenToUse ?? null,
        description: body.data.description ?? null,
        sourceRef: body.data.sourceRef ?? null,
        status: confirm ? 'confirmed' : 'draft',
        confirmedVersion: confirm ? 1 : null,
        versions: {
          create: { version: 1, graph: g.graph as unknown as object, state: confirm ? 'confirmed' : 'draft', confirmedAt: confirm ? new Date() : null },
        },
      },
      include: { versions: true },
    });
    return toDetail(w);
  });

  // The user confirms a draft in the web UI (the AI may draft SOPs, never confirm them).
  // Requests must come from the web app's origin; the agent's shell is separately
  // barred from calling this (permissions.looksLikeWorkflowConfirm).
  app.post<{ Params: { ref: string } }>('/workflows/:ref/confirm', async (req, reply) => {
    if (!fromWebUI(req.headers.origin)) return reply.status(403).send({ error: '只能由用户在 chapi 页面上确认 SOP。' });
    const r = await confirmLatestDraft(req.params.ref);
    if (!r.ok) return reply.status(r.status).send(r.status === 400 ? { errors: r.errors } : { error: r.errors.join('；') });
    return r.detail;
  });

  // Save a draft (the AI may draft; only the user confirms). An open draft is replaced
  // in place; a confirmed SOP gets a new draft version — the confirmed one keeps running.
  app.put<{ Params: { ref: string } }>('/workflows/:ref/draft', async (req, reply) => {
    const body = draftSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ errors: body.error.issues.map((i) => `${i.path.join('.')}：${i.message}`) });
    const { graph, ...meta } = body.data;
    const r = await saveDraft(req.params.ref, graph, meta, 'user');
    if (!r.ok) return reply.status(r.status).send(r.status === 400 ? { errors: r.errors } : { error: r.errors.join('；') });
    return r.detail;
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/workflow-runs', async (req) => listSessionRuns(req.params.id));

  // User-only (no model tool): stop a run — wrong SOP, change of plans, or a stage that can't pass.
  // The web's unload flush sends this as text/plain (a CORS-"simple" request, no preflight);
  // Fastify hands that body over as a string, so accept JSON in it too.
  app.post<{ Params: { id: string; runId: string }; Body: { reason?: string } | string }>(
    '/sessions/:id/workflow-runs/:runId/cancel',
    async (req, reply) => {
      let body: { reason?: unknown } | null = null;
      if (typeof req.body === 'string') {
        try {
          const v = req.body.trim() ? (JSON.parse(req.body) as unknown) : {};
          body = v && typeof v === 'object' && !Array.isArray(v) ? (v as { reason?: unknown }) : null;
        } catch {
          return reply.status(400).send({ error: '请求体不是 JSON。' });
        }
      } else body = req.body ?? null;
      const reason = typeof body?.reason === 'string' ? body.reason : undefined;
      const r = await workflowEngine.cancel(req.params.id, req.params.runId, reason);
      if (!r.ok) return reply.status(409).send({ error: r.error });
      notifyMainAI(req.params.id, `[工作流] ${r.message}。工作流已结束，不要再领取或派发它的阶段；按用户接下来的要求继续。`);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { workflow?: string; label?: string } }>('/sessions/:id/workflow-runs', async (req, reply) => {
    const ref = req.body?.workflow?.trim();
    if (!ref) return reply.status(400).send({ error: 'workflow 必填' });
    const r = await workflowEngine.start(req.params.id, { workflow: ref, label: req.body?.label, trigger: 'manual' });
    if (!r.ok) return reply.status(409).send({ error: r.error });
    // Hand the main AI the wheel (system-injected: not a user round).
    notifyMainAI(req.params.id, `[工作流] 用户已启动「${r.run.workflowName}」。${r.message}`);
    return r.run;
  });
}

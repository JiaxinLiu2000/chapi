import { afterAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { WorkflowSummaryDTO } from '@chapi/shared';

const handleUserMessage = vi.fn(async (_sessionId: string, _text: string) => undefined);
vi.mock('../../orchestrator/types.js', () => ({ getOrchestrator: () => ({ handleUserMessage }) }));
vi.mock('../../knowledge/recall.js', () => ({ recallBlock: async () => null }));

const { prisma } = await import('../../db/client.js');
const { workflowRoutes } = await import('./workflows.js');
const { workflowEngine } = await import('../../workflow/engine.js');
const { config } = await import('../../config.js');
const WEB_ORIGIN = `http://127.0.0.1:${config.webPort}`;

const slug = `route-test-${Date.now()}`;
afterAll(async () => {
  await prisma.workflow.deleteMany({ where: { slug } });
});

const graph = {
  nodes: [
    { id: 'start', type: 'start', title: '开始' },
    { id: 'a', type: 'step', title: '阶段 A', instructions: '做 A', doneCriteria: ['A 完成'], evidence: [{ key: 'n', type: 'int' }] },
    { id: 'end', type: 'end', title: '结束' },
  ],
  edges: [
    { from: 'start', to: 'a' },
    { from: 'a', to: 'end' },
  ],
};

async function app() {
  const a = Fastify();
  await a.register(workflowRoutes, { prefix: '/api' });
  return a;
}

describe('workflow routes', () => {
  it('rejects an invalid graph with 400 and the errors', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: '坏的', slug: `${slug}-bad`, graph: { nodes: [], edges: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { errors: string[] }).errors.length).toBeGreaterThan(0);
  });

  it('creating via the API always yields a draft, even with confirm:true', async () => {
    const a = await app();
    const res = await a.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: { name: '路由测试 SOP', slug, aliases: ['路由别名'], whenToUse: '测试用', graph, confirm: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as WorkflowSummaryDTO).status).toBe('draft');
  });

  it('confirm is refused without the web UI origin', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: `/api/workflows/${slug}/confirm`, payload: {} });
    expect(res.statusCode).toBe(403);
    const spoof = await a.inject({ method: 'POST', url: `/api/workflows/${slug}/confirm`, payload: {}, headers: { origin: 'http://127.0.0.1:8123' } });
    expect(spoof.statusCode).toBe(403);
    // a foreign site served on the web port must not be able to confirm (CSRF)
    const foreign = await a.inject({ method: 'POST', url: `/api/workflows/${slug}/confirm`, payload: {}, headers: { origin: `http://evil.example:${config.webPort}` } });
    expect(foreign.statusCode).toBe(403);
    const https = await a.inject({ method: 'POST', url: `/api/workflows/${slug}/confirm`, payload: {}, headers: { origin: `https://attacker.test:${config.webPort}` } });
    expect(https.statusCode).toBe(403);
  });

  it('the web UI confirms a draft and it is listed as confirmed', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: `/api/workflows/${slug}/confirm`, payload: {}, headers: { origin: WEB_ORIGIN } });
    expect(res.statusCode).toBe(200);
    const list = (await a.inject({ method: 'GET', url: '/api/workflows' })).json() as WorkflowSummaryDTO[];
    const mine = list.find((w) => w.slug === slug);
    expect(mine?.status).toBe('confirmed');
    expect(mine?.confirmedVersion).toBe(1);
    expect(mine?.aliases).toEqual(['路由别名']);
    const detail = (await a.inject({ method: 'GET', url: `/api/workflows/${slug}` })).json() as { versions: unknown[] };
    expect(detail.versions).toHaveLength(1);
  });

  it('PUT draft replaces the open draft, or opens a new draft version on a confirmed SOP', async () => {
    const a = await app();
    const g2 = structuredClone(graph);
    (g2.nodes[1] as Record<string, unknown>).memory = 'none';
    const res = await a.inject({ method: 'PUT', url: `/api/workflows/${slug}/draft`, payload: { graph: g2, note: '加记忆开关' } });
    expect(res.statusCode).toBe(200);
    const d = res.json() as { status: string; confirmedVersion: number | null; versions: { version: number; state: string; graph: { nodes: { memory?: string }[] } }[] };
    // the SOP was confirmed as v1 by an earlier test → v2 draft, v1 still the confirmed one
    expect(d.confirmedVersion).toBe(1);
    expect(d.versions.map((v) => [v.version, v.state])).toEqual([[1, 'confirmed'], [2, 'draft']]);
    expect(d.versions[1]!.graph.nodes[1]!.memory).toBe('none');
    const again = await a.inject({ method: 'PUT', url: `/api/workflows/${slug}/draft`, payload: { graph } });
    expect((again.json() as { versions: unknown[] }).versions).toHaveLength(2);
    const bad = await a.inject({ method: 'PUT', url: `/api/workflows/${slug}/draft`, payload: { graph: { nodes: [], edges: [] } } });
    expect(bad.statusCode).toBe(400);
  });

  it('cancels a run (user-only route) and tells the main AI', async () => {
    const a = await app();
    const session = await prisma.session.create({ data: { slug: `route-cancel-${Date.now()}`, title: 't', model: 'm' } });
    try {
      const started = await workflowEngine.start(session.id, { workflow: slug });
      expect(started.ok).toBe(true);
      const runId = started.ok ? started.run.id : '';
      const bad = await a.inject({ method: 'POST', url: `/api/sessions/${session.id}/workflow-runs/nope/cancel`, payload: {} });
      expect(bad.statusCode).toBe(409);
      const res = await a.inject({ method: 'POST', url: `/api/sessions/${session.id}/workflow-runs/${runId}/cancel`, payload: { reason: '选错了 SOP' } });
      expect(res.statusCode).toBe(200);
      expect((await prisma.workflowRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');
      expect(handleUserMessage.mock.calls.some(([sid, text]) => sid === session.id && text.startsWith('[工作流]') && text.includes('选错了 SOP'))).toBe(true);
    } finally {
      await prisma.session.delete({ where: { id: session.id } });
    }
  });

  it('accepts the unload flush as a text/plain JSON body (no CORS preflight); bad JSON → 400', async () => {
    const a = await app();
    const session = await prisma.session.create({ data: { slug: `route-cancel-tp-${Date.now()}`, title: 't', model: 'm' } });
    try {
      const started = await workflowEngine.start(session.id, { workflow: slug });
      const runId = started.ok ? started.run.id : '';
      const url = `/api/sessions/${session.id}/workflow-runs/${runId}/cancel`;
      const headers = { 'content-type': 'text/plain;charset=UTF-8', origin: WEB_ORIGIN };
      const bad = await a.inject({ method: 'POST', url, payload: '{oops', headers });
      expect(bad.statusCode).toBe(400);
      const res = await a.inject({ method: 'POST', url, payload: JSON.stringify({ reason: '关页面时撤销' }), headers });
      expect(res.statusCode).toBe(200);
      expect((await prisma.workflowRun.findUnique({ where: { id: runId } }))?.status).toBe('cancelled');
      expect(handleUserMessage.mock.calls.some(([sid, text]) => sid === session.id && text.includes('关页面时撤销'))).toBe(true);
    } finally {
      await prisma.session.delete({ where: { id: session.id } });
    }
  });
});

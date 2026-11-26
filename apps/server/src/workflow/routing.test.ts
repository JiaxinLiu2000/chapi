import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../knowledge/recall.js', () => ({ recallBlock: async () => null }));
const { prisma } = await import('../db/client.js');
const { sopHintFor, setPlanBounce } = await import('./routing.js');
const { workflowEngine } = await import('./engine.js');

const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const slug = `route-hint-${tag}`;
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
let sessionId: string;

beforeEach(async () => {
  await prisma.workflow.create({
    data: {
      slug,
      name: `Zeta Ledger 周更 ${tag}`,
      aliases: ['zeta ledger 更新'],
      status: 'confirmed',
      confirmedVersion: 1,
      versions: { create: { version: 1, graph, state: 'confirmed' } },
    },
  });
  sessionId = (await prisma.session.create({ data: { slug: `route-hint-s-${tag}-${Math.random()}`, title: 't', model: 'm' } })).id;
});
afterEach(async () => {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
  await prisma.workflow.deleteMany({ where: { slug } });
});

describe('SOP routing', () => {
  it('a matching request gets a workflow_start instruction naming the SOP', async () => {
    const hint = await sopHintFor(sessionId, '帮我更新一下 zeta ledger');
    expect(hint).toContain(`workflow="${slug}"`);
    expect(hint).toContain('workflow_start');
  });

  it('no hint for unrelated requests, or while a run is already active', async () => {
    expect(await sopHintFor(sessionId, '帮我查一下天气')).toBeNull();
    await workflowEngine.start(sessionId, { workflow: slug });
    expect(await sopHintFor(sessionId, '更新 zeta ledger')).toBeNull();
  });

  it('set_plan is bounced once after a matching request, then allowed', async () => {
    await sopHintFor(sessionId, '更新 zeta ledger');
    const first = await setPlanBounce(sessionId);
    expect(first).toContain(slug);
    expect(await setPlanBounce(sessionId)).toBeNull();
  });

  it('set_plan is not bounced without a matching request, or once the run started', async () => {
    expect(await setPlanBounce(sessionId)).toBeNull();
    await sopHintFor(sessionId, '更新 zeta ledger');
    await workflowEngine.start(sessionId, { workflow: slug });
    expect(await setPlanBounce(sessionId)).toBeNull();
  });
});

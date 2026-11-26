import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowGraph } from '@chapi/shared';

const recallBlock = vi.fn(async (_q: string, _o?: { kinds?: string[] }) => null as string | null);
vi.mock('../knowledge/recall.js', () => ({ recallBlock }));

const { prisma } = await import('../db/client.js');
const { workflowEngine } = await import('./engine.js');
const { stageOutputDir } = await import('./card.js');
const fs = await import('node:fs/promises');
const path = await import('node:path');

const graph: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'start', title: '开始' },
    {
      id: 'a',
      type: 'step',
      title: '阶段 A 统计',
      instructions: '统计名单人数。',
      doneCriteria: ['人数已统计', '名单文件已保存'],
      evidence: [
        { key: 'count', type: 'int' },
        { key: 'file', type: 'path' },
      ],
    },
    {
      id: 'b',
      type: 'step',
      title: '阶段 B 摘要',
      instructions: '写一句摘要。',
      inputs: [{ name: '名单', from: 'a' }],
      doneCriteria: ['摘要已写'],
      evidence: [{ key: 'summary_file', type: 'path' }],
    },
    { id: 'end', type: 'end', title: '结束' },
  ],
  edges: [
    { from: 'start', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: 'end' },
  ],
};

const tag = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let sessionId: string;
let workflowSlug: string;
let workflowId: string;

async function makeWorkflow(status: 'draft' | 'confirmed'): Promise<{ id: string; slug: string }> {
  const slug = `wf-test-${tag()}`;
  const w = await prisma.workflow.create({
    data: {
      slug,
      name: `测试 SOP ${slug}`,
      status,
      confirmedVersion: status === 'confirmed' ? 1 : null,
      versions: { create: { version: 1, graph: graph as unknown as object, state: status === 'confirmed' ? 'confirmed' : 'draft' } },
    },
  });
  return { id: w.id, slug };
}

/** Dispatch the current stage to `agentId` and return its token + card. */
async function dispatch(agentId: string): Promise<{ token: string; card: string }> {
  const n = await workflowEngine.nextStage(sessionId);
  if (!n.ok) throw new Error(n.error);
  const card = await workflowEngine.bindAgent(sessionId, agentId, `[${n.token}] ${n.title}\n请按卡片执行`);
  if (!card) throw new Error('bind failed');
  return { token: n.token, card };
}

const acceptAll = (n: number) =>
  workflowEngine.review(sessionId, {
    decision: 'accept',
    perCriterion: Array.from({ length: n }, (_, i) => ({ criterion: `第${i + 1}条`, verdict: 'met' as const, reason: '已核对产出文件' })),
  });

beforeEach(async () => {
  const s = await prisma.session.create({ data: { slug: `wf-engine-${tag()}`, title: 'engine test', model: 'm' } });
  sessionId = s.id;
  const w = await makeWorkflow('confirmed');
  workflowSlug = w.slug;
  workflowId = w.id;
});

afterEach(async () => {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
  await prisma.workflow.deleteMany({ where: { slug: { startsWith: 'wf-test-' }, id: workflowId } }).catch(() => undefined);
});

describe('workflowEngine', () => {
  it('start refuses a draft workflow', async () => {
    const d = await makeWorkflow('draft');
    const r = await workflowEngine.start(sessionId, { workflow: d.slug });
    expect(r.ok).toBe(false);
    await prisma.workflow.delete({ where: { id: d.id } });
  });

  it('start refuses when the session already has an active run', async () => {
    expect((await workflowEngine.start(sessionId, { workflow: workflowSlug })).ok).toBe(true);
    const again = await workflowEngine.start(sessionId, { workflow: workflowSlug });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error).toContain('测试 SOP');
      expect(again.error).toContain('阶段 A 统计');
    }
  });

  it('saves saveAs evidence into the stage output dir on submit', async () => {
    const g = structuredClone(graph);
    g.nodes[1]!.evidence = [
      { key: 'count', type: 'int' },
      { key: 'report', type: 'string', saveAs: 'report.md' },
    ];
    const slug = `wf-test-save-${tag()}`;
    const w = await prisma.workflow.create({
      data: { slug, name: `保存测试 ${slug}`, status: 'confirmed', confirmedVersion: 1, versions: { create: { version: 1, graph: g as unknown as object, state: 'confirmed' } } },
    });
    try {
      await workflowEngine.start(sessionId, { workflow: slug });
      const a = await dispatch('agent-1');
      const r = await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 3, report: '# 摘要\n共 3 人' }, summary: 's' });
      expect(r.ok).toBe(true);
      const run = (await prisma.workflowRun.findFirst({ where: { sessionId } }))!;
      const file = path.join(stageOutputDir(sessionId, run.id, 'a', ''), 'report.md');
      expect(await fs.readFile(file, 'utf8')).toBe('# 摘要\n共 3 人');
      const nr = await prisma.workflowNodeRun.findFirst({ where: { runId: run.id, nodeId: 'a' } });
      expect((nr?.evidence as Record<string, unknown>).report).toBe(file);
      expect(await workflowEngine.reviewSheet(sessionId)).toContain(file);
    } finally {
      await prisma.workflowRun.deleteMany({ where: { sessionId } });
      await prisma.workflow.delete({ where: { id: w.id } });
    }
  });

  it('runs a→b to done, and only then allows approval', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug, label: '第一批' });
    expect(await workflowEngine.approvalBlock(sessionId)).toBeTruthy();

    const a = await dispatch('agent-1');
    expect(a.card).toContain('统计名单人数。');
    expect(a.card).toContain(a.token);
    const sub = await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: '12', file: '/tmp/a.csv' }, summary: '12 人' });
    expect(sub.ok).toBe(true);
    expect(await workflowEngine.reviewSheet(sessionId)).toContain('人数已统计');
    expect((await acceptAll(2)).ok).toBe(true);

    const b = await dispatch('agent-2');
    expect(b.card).toContain('"count": 12');
    expect((await workflowEngine.submit(sessionId, { token: b.token, agentId: 'agent-2', evidence: { summary_file: '/tmp/s.md' }, summary: 'ok' })).ok).toBe(true);
    expect((await acceptAll(1)).ok).toBe(true);

    const run = (await prisma.workflowRun.findFirst({ where: { sessionId } }))!;
    expect(run.status).toBe('done');
    expect(await workflowEngine.approvalBlock(sessionId)).toBeNull();
    expect(await workflowEngine.activeRun(sessionId)).toBeNull();
  });

  it('cancel ends the run, frees approval and stops nudges', async () => {
    const s = await workflowEngine.start(sessionId, { workflow: workflowSlug });
    expect(s.ok).toBe(true);
    const runId = s.ok ? s.run.id : '';
    await dispatch('agent-1');
    const r = await workflowEngine.cancel(sessionId, runId, '用户换了需求');
    expect(r.ok).toBe(true);
    expect(await workflowEngine.activeRun(sessionId)).toBeNull();
    expect(await workflowEngine.approvalBlock(sessionId)).toBeNull();
    expect(await workflowEngine.turnEndReminder(sessionId)).toBeNull();
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('cancelled');
    expect(run?.pendingToken).toBeNull();
    const plan = await prisma.planTask.findMany({ where: { sessionId } });
    expect(plan.every((t) => t.status === 'done' || t.status === 'blocked')).toBe(true);
    expect((await workflowEngine.start(sessionId, { workflow: workflowSlug })).ok).toBe(true);
  });

  it('two simultaneous starts create only one run', async () => {
    const [a, b] = await Promise.all([
      workflowEngine.start(sessionId, { workflow: workflowSlug }),
      workflowEngine.start(sessionId, { workflow: workflowSlug }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await prisma.workflowRun.count({ where: { sessionId } })).toBe(1);
  });

  it('a sub-agent that quits after a review redo keeps the reviewer feedback', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    const a = await dispatch('agent-1');
    await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
    await workflowEngine.review(sessionId, { decision: 'redo', feedback: '名单漏了 3 人' });
    await dispatch('agent-2');
    for (let i = 0; i < 3; i++) await workflowEngine.onSubagentStop(sessionId, 'agent-2');
    const again = await dispatch('agent-3');
    expect(again.card).toContain('名单漏了 3 人');
  });

  it('start posts a workflow_run card message into the chat', async () => {
    const r = await workflowEngine.start(sessionId, { workflow: workflowSlug });
    expect(r.ok).toBe(true);
    const msg = await prisma.message.findFirst({ where: { sessionId, type: 'workflow_run' } });
    expect(msg?.role).toBe('assistant');
    expect(msg?.text).toBe(r.ok ? r.run.id : '');
  });

  it('nextStage refuses while a token is outstanding', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    await dispatch('agent-1');
    const again = await workflowEngine.nextStage(sessionId);
    expect(again.ok).toBe(false);
  });

  it('bindAgent ignores a prompt without the current token', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    await workflowEngine.nextStage(sessionId);
    expect(await workflowEngine.bindAgent(sessionId, 'x', '随便做点事')).toBeNull();
  });

  it('submit rejects a token bound to another agent', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    const a = await dispatch('agent-1');
    const r = await workflowEngine.submit(sessionId, { token: a.token, agentId: 'intruder', evidence: { count: 1, file: 'f' }, summary: 's' });
    expect(r.ok).toBe(false);
    expect((await workflowEngine.tokenOwner(sessionId, a.token))?.agentId).toBe('agent-1');
  });

  it('submit returns all evidence errors', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    const a = await dispatch('agent-1');
    const r = await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: {}, summary: 's' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('count');
      expect(r.error).toContain('file');
    }
  });

  it('accept without verdicts for every criterion fails', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    const a = await dispatch('agent-1');
    await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
    const r = await acceptAll(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('名单文件已保存');
  });

  it('redo invalidates the old token and the next card carries feedback', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    const a = await dispatch('agent-1');
    await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
    expect((await workflowEngine.review(sessionId, { decision: 'redo', perCriterion: [], feedback: '名单少了 3 个人，重新核对原表' })).ok).toBe(true);
    const stale = await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 4, file: 'f' }, summary: 's' });
    expect(stale.ok).toBe(false);
    const again = await dispatch('agent-3');
    expect(again.token).not.toBe(a.token);
    expect(again.card).toContain('名单少了 3 个人，重新核对原表');
  });

  it('redo requires feedback', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    const a = await dispatch('agent-1');
    await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
    expect((await workflowEngine.review(sessionId, { decision: 'redo', perCriterion: [] })).ok).toBe(false);
  });

  it('onSubagentStop reminds twice then marks redo', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    const a = await dispatch('agent-1');
    expect(await workflowEngine.onSubagentStop(sessionId, 'agent-1')).toContain(a.token);
    expect(await workflowEngine.onSubagentStop(sessionId, 'agent-1')).toBeTruthy();
    expect(await workflowEngine.onSubagentStop(sessionId, 'agent-1')).toBeNull();
    const nr = await prisma.workflowNodeRun.findFirst({ where: { run: { sessionId }, nodeId: 'a' } });
    expect(nr?.status).toBe('redo');
    expect((await workflowEngine.nextStage(sessionId)).ok).toBe(true);
  });

  it('onSubagentStop is silent once evidence is submitted, and for unknown agents', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    const a = await dispatch('agent-1');
    await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
    expect(await workflowEngine.onSubagentStop(sessionId, 'agent-1')).toBeNull();
    expect(await workflowEngine.onSubagentStop(sessionId, 'someone-else')).toBeNull();
  });

  it('locked plan rows mirror node statuses', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    let plan = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
    expect(plan.map((t) => [t.text, t.status, t.locked])).toEqual([
      ['【SOP】阶段 A 统计', 'pending', true],
      ['【SOP】阶段 B 摘要', 'pending', true],
    ]);
    const a = await dispatch('agent-1');
    plan = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
    expect(plan[0]!.status).toBe('in_progress');
    await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
    await acceptAll(2);
    plan = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
    expect(plan[0]!.status).toBe('done');
  });

  it('turnEndReminder nudges at most twice per stage while a run is open', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    expect(await workflowEngine.turnEndReminder(sessionId)).toContain('workflow_next_stage');
    expect(await workflowEngine.turnEndReminder(sessionId)).toBeTruthy();
    expect(await workflowEngine.turnEndReminder(sessionId)).toBeNull();
  });

  it('a second run in the same session keeps the first run SOP rows', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug, label: '第一次' });
    const a = await dispatch('agent-1');
    await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
    await acceptAll(2);
    const b = await dispatch('agent-2');
    await workflowEngine.submit(sessionId, { token: b.token, agentId: 'agent-2', evidence: { summary_file: 'f' }, summary: 's' });
    await acceptAll(1);
    expect((await workflowEngine.start(sessionId, { workflow: workflowSlug, label: '第二次' })).ok).toBe(true);
    const plan = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
    expect(plan.map((t) => t.status)).toEqual(['done', 'done', 'pending', 'pending']);
    expect(plan.every((t) => t.locked)).toBe(true);
  });

  it('memory none: no recall in the card; skills: recall limited to tool skills', async () => {
    const g = structuredClone(graph);
    g.nodes[1]!.memory = 'none';
    g.nodes[2]!.memory = 'skills';
    const slug = `wf-test-mem-${tag()}`;
    const w = await prisma.workflow.create({
      data: { slug, name: `记忆测试 ${slug}`, status: 'confirmed', confirmedVersion: 1, versions: { create: { version: 1, graph: g as unknown as object, state: 'confirmed' } } },
    });
    try {
      await workflowEngine.start(sessionId, { workflow: slug });
      recallBlock.mockClear();
      recallBlock.mockResolvedValue('[知识图谱·旧数据] 某公司是 Investor');
      const a = await dispatch('agent-1');
      expect(recallBlock).not.toHaveBeenCalled();
      expect(a.card).not.toContain('旧数据');
      expect(await workflowEngine.memoryModeOf(sessionId, 'agent-1')).toBe('none');
      expect(await workflowEngine.memoryModeOf(sessionId, 'someone-else')).toBeNull();
      await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
      await acceptAll(2);
      await dispatch('agent-2');
      expect(recallBlock).toHaveBeenCalledTimes(1);
      expect(recallBlock.mock.calls[0]![1]?.kinds).toEqual(['skill']);
      expect(await workflowEngine.memoryModeOf(sessionId, 'agent-2')).toBe('skills');
    } finally {
      recallBlock.mockResolvedValue(null);
      await prisma.workflowRun.deleteMany({ where: { sessionId } });
      await prisma.workflow.delete({ where: { id: w.id } });
    }
  });

  describe('sub-steps and progress', () => {
    let subSlug: string;
    let subId: string;
    beforeEach(async () => {
      const g = structuredClone(graph);
      g.nodes[1]!.substeps = [
        { id: 's1', title: '读名单' },
        { id: 's2', title: '统计人数' },
        { id: 's3', title: '保存文件' },
        { id: 's4', title: '回读核对' },
      ];
      subSlug = `wf-test-sub-${tag()}`;
      const w = await prisma.workflow.create({
        data: { slug: subSlug, name: `子步骤测试 ${subSlug}`, status: 'confirmed', confirmedVersion: 1, versions: { create: { version: 1, graph: g as unknown as object, state: 'confirmed' } } },
      });
      subId = w.id;
      await workflowEngine.start(sessionId, { workflow: subSlug });
    });
    afterEach(async () => {
      await prisma.workflowRun.deleteMany({ where: { sessionId } });
      await prisma.workflow.delete({ where: { id: subId } }).catch(() => undefined);
    });
    const progressOf = async (nodeId: string) => (await workflowEngine.activeRun(sessionId))?.nodeRuns.find((n) => n.nodeId === nodeId)?.progress;

    it('submit is refused until every sub-step is resolved; na needs a reason', async () => {
      const a = await dispatch('agent-1');
      expect(a.card).toContain('s1');
      expect(a.card).toContain('workflow_substep');
      const early = await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
      expect(early.ok).toBe(false);
      if (!early.ok) expect(early.error).toContain('统计人数');
      expect((await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: 's4', status: 'na' })).ok).toBe(false);
      expect((await workflowEngine.substep(sessionId, { token: a.token, agentId: 'intruder', substep: 's1', status: 'done' })).ok).toBe(false);
      expect((await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: 'nope', status: 'done' })).ok).toBe(false);
      for (const s of ['s1', 's2', 's3']) expect((await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: s, status: 'done' })).ok).toBe(true);
      expect((await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: 's4', status: 'na', note: '本批文件很小，不需要回读' })).ok).toBe(true);
      expect((await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' })).ok).toBe(true);
      expect(await workflowEngine.reviewSheet(sessionId)).toContain('本批文件很小');
    });

    it('progress: 0 pending → fraction of sub-steps → 95 submitted → 100 done; 15 without sub-steps', async () => {
      expect(await progressOf('a')).toBe(0);
      const a = await dispatch('agent-1');
      expect(await progressOf('a')).toBe(5);
      await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: 's1', status: 'done' });
      await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: 's2', status: 'done' });
      expect(await progressOf('a')).toBe(48); // 5 + 85 * 2/4 → 47.5 → 48
      for (const s of ['s3', 's4']) await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: s, status: 'done' });
      await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
      expect(await progressOf('a')).toBe(95);
      await acceptAll(2);
      expect(await progressOf('a')).toBe(100);
      await dispatch('agent-2');
      expect(await progressOf('b')).toBe(15);
    });

    it('sub-steps appear in the plan as depth-1 rows under their stage, with progress fill', async () => {
      const a = await dispatch('agent-1');
      await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: 's1', status: 'done' });
      const plan = await prisma.planTask.findMany({ where: { sessionId }, orderBy: { ordinal: 'asc' } });
      expect(plan.map((t) => [t.depth, t.text, t.status])).toEqual([
        [0, '【SOP】阶段 A 统计', 'in_progress'],
        [1, '读名单', 'done'],
        [1, '统计人数', 'pending'],
        [1, '保存文件', 'pending'],
        [1, '回读核对', 'pending'],
        [0, '【SOP】阶段 B 摘要', 'pending'],
      ]);
      expect(plan[0]!.progress).toBe(26); // 5 + 85 * 1/4
      expect(plan.every((t) => t.locked)).toBe(true);
    });

    it('a redo resets the sub-steps for the new attempt', async () => {
      const a = await dispatch('agent-1');
      for (const s of ['s1', 's2', 's3', 's4']) await workflowEngine.substep(sessionId, { token: a.token, agentId: 'agent-1', substep: s, status: 'done' });
      await workflowEngine.submit(sessionId, { token: a.token, agentId: 'agent-1', evidence: { count: 1, file: 'f' }, summary: 's' });
      await workflowEngine.review(sessionId, { decision: 'redo', feedback: '名单少了人' });
      await dispatch('agent-2');
      const nr = (await workflowEngine.activeRun(sessionId))!.nodeRuns.find((n) => n.nodeId === 'a')!;
      expect(nr.substeps.every((s) => s.status === 'pending')).toBe(true);
    });
  });

  it('statusText describes the current stage', async () => {
    await workflowEngine.start(sessionId, { workflow: workflowSlug });
    expect(await workflowEngine.statusText(sessionId)).toContain('阶段 A 统计');
  });
});

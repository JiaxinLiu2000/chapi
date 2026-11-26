import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db/client.js';
import { onPlanTransitions, setPlan, syncLockedSteps, updatePlanStep, type StepTransition } from './plan.js';

describe('plan — workflow-locked steps', () => {
  let sessionId: string;

  beforeEach(async () => {
    const s = await prisma.session.create({
      data: { slug: `plan-lock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: 'plan lock test', model: 'm' },
    });
    sessionId = s.id;
    await syncLockedSteps(sessionId, [
      { nodeRunId: 'nr-a', text: '【SOP】阶段 A', status: 'pending' },
      { nodeRunId: 'nr-b', text: '【SOP】阶段 B', status: 'pending' },
    ]);
  });

  afterEach(async () => {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
  });

  it('setPlan keeps locked rows that are omitted', async () => {
    const { plan } = await setPlan(sessionId, [{ text: '辅助：整理文件' }]);
    expect(plan.map((t) => t.text)).toEqual(['【SOP】阶段 A', '【SOP】阶段 B', '辅助：整理文件']);
    expect(plan.slice(0, 2).every((t) => t.locked && t.status === 'pending')).toBe(true);
  });

  it('setPlan cannot change a locked row status', async () => {
    const { plan } = await setPlan(sessionId, [{ text: '【SOP】阶段 A', status: 'done' }]);
    expect(plan.find((t) => t.text === '【SOP】阶段 A')?.status).toBe('pending');
  });

  it('updatePlanStep refuses done on a locked row', async () => {
    const r = await updatePlanStep(sessionId, { step: 1, status: 'done' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('workflow_review_stage');
  });

  it('updatePlanStep allows problem on a locked row with reason', async () => {
    const r = await updatePlanStep(sessionId, { step: '【SOP】阶段 B', status: 'problem', reason: '数据源超时' });
    expect(r.ok).toBe(true);
  });

  it('syncLockedSteps for a new run keeps the previous run rows (before it)', async () => {
    await syncLockedSteps(sessionId, [
      { nodeRunId: 'nr-a', text: '【SOP】阶段 A', status: 'done' },
      { nodeRunId: 'nr-b', text: '【SOP】阶段 B', status: 'done' },
    ]);
    const plan = await syncLockedSteps(sessionId, [{ nodeRunId: 'nr-x', text: '【SOP】阶段 X', status: 'pending' }], { scope: ['nr-x'] });
    expect(plan.map((t) => [t.text, t.status])).toEqual([
      ['【SOP】阶段 A', 'done'],
      ['【SOP】阶段 B', 'done'],
      ['【SOP】阶段 X', 'pending'],
    ]);
  });

  it('syncLockedSteps for a new run keeps the previous run rows', async () => {
    await setPlan(sessionId, []);
    const plan = await syncLockedSteps(sessionId, [{ nodeRunId: 'nr-x', text: '【SOP】阶段 X', status: 'pending' }], { scope: ['nr-x'] });
    expect(plan.map((t) => t.text)).toContain('【SOP】阶段 A');
  });

  it('syncLockedSteps updates status by nodeRunId and fires transitions', async () => {
    const seen: StepTransition[] = [];
    onPlanTransitions((sid, t) => {
      if (sid === sessionId) seen.push(...t);
    });
    await setPlan(sessionId, [{ text: '辅助' }]);
    const plan = await syncLockedSteps(sessionId, [
      { nodeRunId: 'nr-a', text: '【SOP】阶段 A', status: 'in_progress' },
      { nodeRunId: 'nr-b', text: '【SOP】阶段 B', status: 'pending' },
    ]);
    expect(plan.map((t) => t.text)).toEqual(['【SOP】阶段 A', '【SOP】阶段 B', '辅助']);
    expect(plan[0]!.status).toBe('in_progress');
    expect(seen.some((x) => x.step.nodeRunId === 'nr-a' && x.from === 'pending' && x.to === 'in_progress')).toBe(true);
  });
});

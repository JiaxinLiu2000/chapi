import { describe, expect, it } from 'vitest';
import type { WorkflowGraph, WorkflowNodeDef } from '@chapi/shared';
import { applyOps, diffGraphs } from './drafts.js';

const step = (id: string, extra: Partial<WorkflowNodeDef> = {}): WorkflowNodeDef => ({
  id,
  type: 'step',
  title: `阶段 ${id}`,
  instructions: `做 ${id}`,
  doneCriteria: [`${id} 完成`],
  evidence: [{ key: 'n', type: 'int' }],
  ...extra,
});
const linear = (steps: WorkflowNodeDef[]): WorkflowGraph => {
  const nodes: WorkflowNodeDef[] = [{ id: 'start', type: 'start', title: '开始' }, ...steps, { id: 'end', type: 'end', title: '结束' }];
  return { nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })) };
};
const ids = (g: WorkflowGraph) => g.nodes.map((n) => n.id);

describe('applyOps', () => {
  const base = linear([step('a'), step('b')]);

  it('updates fields of one stage and leaves the rest alone', () => {
    const r = applyOps(base, [{ op: 'update_stage', stage: 'b', set: { title: '阶段 B 新', substeps: [{ id: 's1', title: '查新合同' }], memory: 'none' } }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const b = r.graph.nodes.find((n) => n.id === 'b')!;
      expect([b.title, b.memory, b.substeps?.[0]?.title, b.instructions]).toEqual(['阶段 B 新', 'none', '查新合同', '做 b']);
      expect(base.nodes.find((n) => n.id === 'b')!.title).toBe('阶段 b'); // input not mutated
    }
  });

  it('inserts a stage after another and rewires the edges', () => {
    const r = applyOps(base, [{ op: 'insert_stage', after: 'a', stage: step('a2') }]);
    expect(r.ok && ids(r.graph)).toEqual(['start', 'a', 'a2', 'b', 'end']);
    expect(r.ok && r.graph.edges).toEqual([
      { from: 'start', to: 'a' },
      { from: 'a', to: 'a2' },
      { from: 'a2', to: 'b' },
      { from: 'b', to: 'end' },
    ]);
  });

  it('removes a stage', () => {
    const r = applyOps(base, [{ op: 'remove_stage', stage: 'a' }]);
    expect(r.ok && ids(r.graph)).toEqual(['start', 'b', 'end']);
  });

  it('reports unknown stages and validates the result', () => {
    const r1 = applyOps(base, [{ op: 'update_stage', stage: 'zzz', set: { title: 'x' } }]);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.join('\n')).toContain('zzz');
    const r2 = applyOps(base, [{ op: 'update_stage', stage: 'a', set: { doneCriteria: [] } }]);
    expect(r2.ok).toBe(false); // parseGraph: a stage needs ≥1 done criterion
    const r3 = applyOps(base, [{ op: 'remove_stage', stage: 'a' }, { op: 'remove_stage', stage: 'b' }]);
    expect(r3.ok).toBe(false); // ≥1 stage
  });
});

describe('diffGraphs', () => {
  it('lists added, removed and changed stages with the fields that changed', () => {
    const a = linear([step('a'), step('b'), step('c')]);
    const b = linear([step('a', { title: '阶段 A 改', memory: 'none' }), step('c'), step('d')]);
    const lines = diffGraphs(a, b);
    expect(lines).toContain('修改「阶段 A 改」：标题、记忆模式');
    expect(lines).toContain('删除「阶段 b」');
    expect(lines).toContain('新增「阶段 d」');
    expect(lines.some((l) => l.includes('阶段 c'))).toBe(false);
    expect(diffGraphs(a, a)).toEqual([]);
  });
});

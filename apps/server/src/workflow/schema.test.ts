import { describe, expect, it } from 'vitest';
import type { WorkflowGraph, WorkflowNodeDef } from '@chapi/shared';
import { parseGraph, stepOrder } from './schema.js';

const step = (id: string, extra: Partial<WorkflowNodeDef> = {}): WorkflowNodeDef => ({
  id,
  type: 'step',
  title: `阶段 ${id}`,
  instructions: `做 ${id}`,
  doneCriteria: [`${id} 完成`],
  evidence: [{ key: 'count', type: 'int' }],
  ...extra,
});
const linear = (steps: WorkflowNodeDef[]): WorkflowGraph => {
  const nodes: WorkflowNodeDef[] = [{ id: 'start', type: 'start', title: '开始' }, ...steps, { id: 'end', type: 'end', title: '结束' }];
  return { nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })) };
};

describe('parseGraph', () => {
  it('accepts a linear start→a→b→end graph', () => {
    const r = parseGraph(linear([step('a'), step('b')]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.order).toEqual(['start', 'a', 'b', 'end']);
      expect(stepOrder(r.order, r.graph).map((n) => n.id)).toEqual(['a', 'b']);
    }
  });

  it('rejects a step without doneCriteria', () => {
    const r = parseGraph(linear([step('a', { doneCriteria: [] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('a') && e.includes('doneCriteria'))).toBe(true);
  });

  it('rejects a fork', () => {
    const g = linear([step('a'), step('b')]);
    g.edges.push({ from: 'start', to: 'b' });
    expect(parseGraph(g).ok).toBe(false);
  });

  it('rejects an unreachable node', () => {
    const g = linear([step('a')]);
    g.nodes.push(step('orphan'));
    const r = parseGraph(g);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('orphan'))).toBe(true);
  });

  it('rejects inputs.from pointing at a later node', () => {
    const r = parseGraph(linear([step('a', { inputs: [{ name: 'x', from: 'b' }] }), step('b')]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('inputs') && e.includes('b'))).toBe(true);
  });

  it('accepts saveAs on a string field', () => {
    expect(parseGraph(linear([step('a', { evidence: [{ key: 'text', type: 'string', saveAs: 'summary.md' }] })])).ok).toBe(true);
  });

  it('rejects saveAs on a non-string field or with a path', () => {
    const r1 = parseGraph(linear([step('a', { evidence: [{ key: 'n', type: 'int', saveAs: 'n.txt' }] })]));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.join('\n')).toContain('saveAs');
    const r2 = parseGraph(linear([step('a', { evidence: [{ key: 't', type: 'string', saveAs: '../x.md' }] })]));
    expect(r2.ok).toBe(false);
    const r3 = parseGraph(linear([step('a', { evidence: [{ key: 't', type: 'string', saveAs: 'a.md' }, { key: 'u', type: 'string', saveAs: 'a.md' }] })]));
    expect(r3.ok).toBe(false);
  });

  it('rejects duplicate evidence keys', () => {
    const r = parseGraph(linear([step('a', { evidence: [{ key: 'n', type: 'int' }, { key: 'n', type: 'string' }] })]));
    expect(r.ok).toBe(false);
  });

  it('collects several errors at once', () => {
    const r = parseGraph(linear([step('a', { instructions: '' }), step('b', { evidence: [] })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts memory none / skills and rejects other values', () => {
    expect(parseGraph(linear([step('a', { memory: 'none' }), step('b', { memory: 'skills' })])).ok).toBe(true);
    expect(parseGraph(linear([step('a', { memory: 'all' as never })])).ok).toBe(false);
  });

  it('keeps the memory field on the parsed graph', () => {
    const r = parseGraph(linear([step('a', { memory: 'none' })]));
    expect(r.ok && r.graph.nodes[1]!.memory).toBe('none');
  });

  it('accepts sub-steps and rejects duplicate or malformed ones', () => {
    const ok = parseGraph(linear([step('a', { substeps: [{ id: 's1', title: '查新合同' }, { id: 's2', title: '排序' }] })]));
    expect(ok.ok && ok.graph.nodes[1]!.substeps?.length).toBe(2);
    expect(parseGraph(linear([step('a', { substeps: [{ id: 's1', title: 'x' }, { id: 's1', title: 'y' }] })])).ok).toBe(false);
    expect(parseGraph(linear([step('a', { substeps: [{ id: 's1', title: '' }] })])).ok).toBe(false);
  });

  it('accepts an icon key on a stage', () => {
    const r = parseGraph(linear([step('a', { icon: 'googlesheets' })]));
    expect(r.ok && r.graph.nodes[1]!.icon).toBe('googlesheets');
    expect(parseGraph(linear([step('a', { icon: 'Not A Key!' })])).ok).toBe(false);
  });

  it('rejects a graph with no steps', () => {
    const r = parseGraph(linear([]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('至少');
  });

  it('rejects malformed input', () => {
    expect(parseGraph({ nodes: 'x' }).ok).toBe(false);
    expect(parseGraph(null).ok).toBe(false);
  });
});

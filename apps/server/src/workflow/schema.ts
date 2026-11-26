import { z } from 'zod';
import type { WorkflowGraph, WorkflowNodeDef } from '@chapi/shared';

/**
 * Workflow graph validation. Phase 1: a single linear path start → step… → end.
 * Every problem is collected and returned at once (the model / editor fixes them in one go).
 */

const EvidenceFieldZ = z.object({
  key: z.string().min(1),
  type: z.enum(['int', 'number', 'string', 'bool', 'list', 'path']),
  required: z.boolean().optional(),
  desc: z.string().optional(),
  saveAs: z.string().optional(),
});
const IOZ = z.object({ name: z.string().min(1), from: z.string().optional(), file: z.string().optional(), desc: z.string().optional() });
const NodeZ = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, 'id 只能用小写字母、数字、下划线'),
  type: z.enum(['start', 'end', 'step']),
  title: z.string().min(1),
  instructions: z.string().optional(),
  inputs: z.array(IOZ).optional(),
  outputs: z.array(IOZ).optional(),
  doneCriteria: z.array(z.string()).optional(),
  evidence: z.array(EvidenceFieldZ).optional(),
  agent: z.object({ model: z.string().optional(), maxTurns: z.number().int().positive().optional() }).optional(),
  memory: z.enum(['none', 'skills']).optional(),
  icon: z.string().regex(/^[a-z0-9_-]+$/, 'icon 只能是图标的 key（小写）').optional(),
  substeps: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]+$/, '子步骤 id 只能用小写字母、数字、下划线'), title: z.string().min(1) })).optional(),
});
const GraphZ = z.object({
  nodes: z.array(NodeZ).min(2),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
});

/** A bare file name for `saveAs`: no directories, no leading dot. */
const SAVE_AS_RE = /^[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff._-]*$/;

export type GraphResult = { ok: true; graph: WorkflowGraph; order: string[] } | { ok: false; errors: string[] };

export function parseGraph(input: unknown): GraphResult {
  const parsed = GraphZ.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`) };
  }
  const graph = parsed.data as WorkflowGraph;
  const errors: string[] = [];
  const byId = new Map<string, WorkflowNodeDef>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) errors.push(`节点 id 重复：${n.id}`);
    byId.set(n.id, n);
  }
  const starts = graph.nodes.filter((n) => n.type === 'start');
  const ends = graph.nodes.filter((n) => n.type === 'end');
  if (starts.length !== 1) errors.push(`必须有且只有一个 start 节点（现在 ${starts.length} 个）`);
  if (ends.length !== 1) errors.push(`必须有且只有一个 end 节点（现在 ${ends.length} 个）`);

  const out = new Map<string, string[]>();
  const inCount = new Map<string, number>();
  for (const e of graph.edges) {
    if (!byId.has(e.from)) errors.push(`连线起点不存在：${e.from}`);
    if (!byId.has(e.to)) errors.push(`连线终点不存在：${e.to}`);
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1);
  }
  for (const [id, tos] of out) if (tos.length > 1) errors.push(`节点 ${id} 有 ${tos.length} 条出边（目前只支持顺序流程）`);
  for (const [id, n] of inCount) if (n > 1) errors.push(`节点 ${id} 有 ${n} 条入边（目前只支持顺序流程）`);

  // Walk from start.
  const order: string[] = [];
  if (starts.length === 1) {
    const seen = new Set<string>();
    let cur: string | undefined = starts[0]!.id;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      order.push(cur);
      cur = out.get(cur)?.[0];
    }
    if (cur && seen.has(cur)) errors.push(`流程有环：回到了 ${cur}`);
    const last = order[order.length - 1];
    if (last && byId.get(last)?.type !== 'end') errors.push(`流程没有走到 end（停在 ${last}）`);
    for (const n of graph.nodes) if (!seen.has(n.id)) errors.push(`节点 ${n.id} 从 start 走不到`);
  }

  if (!graph.nodes.some((n) => n.type === 'step')) errors.push('流程至少要有一个阶段（step 节点）');

  // Per-step content.
  const position = new Map(order.map((id, i) => [id, i]));
  for (const n of graph.nodes) {
    if (n.type !== 'step') continue;
    if (!n.instructions?.trim()) errors.push(`阶段 ${n.id} 缺少 instructions（SOP 原文）`);
    if (!n.doneCriteria?.filter((c) => c.trim()).length) errors.push(`阶段 ${n.id} 缺少 doneCriteria（至少 1 条完成标准）`);
    if (!n.evidence?.length) errors.push(`阶段 ${n.id} 缺少 evidence（至少 1 个证据字段）`);
    const subIds = new Set<string>();
    for (const sub of n.substeps ?? []) {
      if (subIds.has(sub.id)) errors.push(`阶段 ${n.id} 的子步骤 id 重复：${sub.id}`);
      subIds.add(sub.id);
    }
    const keys = new Set<string>();
    const files = new Set<string>();
    for (const f of n.evidence ?? []) {
      if (keys.has(f.key)) errors.push(`阶段 ${n.id} 的证据字段重复：${f.key}`);
      keys.add(f.key);
      if (f.saveAs === undefined) continue;
      if (f.type !== 'string') errors.push(`阶段 ${n.id} 的证据字段 ${f.key}：saveAs 只能用在 string 类型的字段上`);
      if (!SAVE_AS_RE.test(f.saveAs) || f.saveAs.includes('..')) errors.push(`阶段 ${n.id} 的证据字段 ${f.key}：saveAs 只能是一个文件名（如 summary.md），不能带路径`);
      if (files.has(f.saveAs)) errors.push(`阶段 ${n.id} 有两个证据字段都要存成 ${f.saveAs}`);
      files.add(f.saveAs);
    }
    for (const inp of n.inputs ?? []) {
      if (!inp.from) continue;
      const p = position.get(inp.from);
      const self = position.get(n.id);
      if (p === undefined || self === undefined || p >= self) {
        errors.push(`阶段 ${n.id} 的 inputs「${inp.name}」来自 ${inp.from}，但它不是排在前面的节点`);
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, graph, order };
}

/** The step nodes, in execution order. */
export function stepOrder(order: string[], graph: WorkflowGraph): WorkflowNodeDef[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return order.map((id) => byId.get(id)).filter((n): n is WorkflowNodeDef => !!n && n.type === 'step');
}

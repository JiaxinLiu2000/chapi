import type { WorkflowDetailDTO, WorkflowGraph, WorkflowNodeDef, WorkflowSummaryDTO } from '@chapi/shared';
import type { Workflow, WorkflowVersion } from '@prisma/client';
import { prisma } from '../db/client.js';
import { parseGraph } from './schema.js';

/**
 * SOP drafting shared by the REST routes and the main AI's chat tools. The AI may
 * draft and edit; only the user confirms (web page button, or the approval card the
 * main AI raises in chat — the user's click is what confirms).
 */

// ── DTOs ──
export function toSummary(w: Workflow & { versions?: Pick<WorkflowVersion, 'version' | 'state'>[] }): WorkflowSummaryDTO {
  const draft = (w.versions ?? []).filter((v) => v.state === 'draft').sort((a, b) => b.version - a.version)[0];
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    status: w.status as WorkflowSummaryDTO['status'],
    confirmedVersion: w.confirmedVersion ?? null,
    whenToUse: w.whenToUse ?? null,
    aliases: (w.aliases as string[] | null) ?? [],
    pendingDraftVersion: draft && (w.confirmedVersion ?? 0) < draft.version ? draft.version : null,
  };
}

export function toDetail(w: Workflow & { versions: WorkflowVersion[] }): WorkflowDetailDTO {
  return {
    ...toSummary(w),
    description: w.description ?? null,
    sourceRef: w.sourceRef ?? null,
    versions: w.versions.map((v) => ({
      version: v.version,
      state: v.state as WorkflowDetailDTO['versions'][number]['state'],
      graph: v.graph as unknown as WorkflowGraph,
      note: v.note ?? null,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

export async function findWorkflowRef(ref: string) {
  const key = ref.trim();
  const byId = await prisma.workflow.findFirst({
    where: { OR: [{ id: key }, { slug: key }] },
    include: { versions: { orderBy: { version: 'asc' } } },
  });
  if (byId) return byId;
  const lower = key.toLowerCase();
  const all = await prisma.workflow.findMany({ where: { status: { not: 'archived' } }, include: { versions: { orderBy: { version: 'asc' } } } });
  return (
    all.find((w) => w.name.toLowerCase() === lower) ??
    all.find((w) => ((w.aliases as string[] | null) ?? []).some((a) => a.toLowerCase() === lower)) ??
    null
  );
}

/** The version an edit should start from: the open draft if any, else the confirmed one. */
export function workingVersion(w: { versions: WorkflowVersion[]; confirmedVersion: number | null }): WorkflowVersion | null {
  const sorted = [...w.versions].sort((a, b) => b.version - a.version);
  return sorted.find((v) => v.state === 'draft') ?? sorted.find((v) => v.version === w.confirmedVersion) ?? sorted[0] ?? null;
}

// ── edits ──
export type StageFields = Partial<
  Pick<WorkflowNodeDef, 'title' | 'instructions' | 'doneCriteria' | 'evidence' | 'substeps' | 'memory' | 'inputs' | 'outputs' | 'agent'>
>;
export type StageOp =
  | { op: 'update_stage'; stage: string; set: StageFields }
  | { op: 'insert_stage'; after: string; stage: WorkflowNodeDef }
  | { op: 'remove_stage'; stage: string };

/** Apply stage edits to a linear graph (input untouched); the result is fully validated. */
export function applyOps(graph: WorkflowGraph, ops: StageOp[]): { ok: true; graph: WorkflowGraph } | { ok: false; errors: string[] } {
  const parsed = parseGraph(graph);
  if (!parsed.ok) return { ok: false, errors: parsed.errors.map((e) => `原流程无效：${e}`) };
  const byId = new Map(parsed.graph.nodes.map((n) => [n.id, structuredClone(n)]));
  let order = [...parsed.order];
  const errors: string[] = [];
  for (const [i, op] of ops.entries()) {
    const where = `第 ${i + 1} 个修改`;
    if (op.op === 'update_stage') {
      const n = byId.get(op.stage);
      if (!n || n.type !== 'step') errors.push(`${where}：没有阶段「${op.stage}」`);
      else Object.assign(n, structuredClone(op.set));
    } else if (op.op === 'insert_stage') {
      const at = order.indexOf(op.after);
      if (at < 0 || op.after === 'end') errors.push(`${where}：插入位置「${op.after}」不存在`);
      else if (byId.has(op.stage.id)) errors.push(`${where}：阶段 id「${op.stage.id}」已存在`);
      else {
        byId.set(op.stage.id, { ...structuredClone(op.stage), type: 'step' });
        order.splice(at + 1, 0, op.stage.id);
      }
    } else if (op.op === 'remove_stage') {
      const n = byId.get(op.stage);
      if (!n || n.type !== 'step') errors.push(`${where}：没有阶段「${op.stage}」`);
      else {
        byId.delete(op.stage);
        order = order.filter((id) => id !== op.stage);
      }
    } else {
      errors.push(`${where}：未知操作`);
    }
  }
  if (errors.length) return { ok: false, errors };
  const nodes = order.map((id) => byId.get(id)!);
  const next: WorkflowGraph = { nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })) };
  const check = parseGraph(next);
  return check.ok ? { ok: true, graph: check.graph } : { ok: false, errors: check.errors };
}

const FIELD_LABEL: Record<string, string> = {
  title: '标题',
  instructions: 'SOP 原文',
  substeps: '子步骤',
  doneCriteria: '完成标准',
  evidence: '证据字段',
  memory: '记忆模式',
  inputs: '输入',
  outputs: '输出',
  agent: '副 AI 设置',
};

/** Human-readable stage-level differences between two versions (empty = identical). */
export function diffGraphs(before: WorkflowGraph, after: WorkflowGraph): string[] {
  const steps = (g: WorkflowGraph) => new Map(g.nodes.filter((n) => n.type === 'step').map((n) => [n.id, n]));
  const a = steps(before);
  const b = steps(after);
  const lines: string[] = [];
  for (const [id, nb] of b) {
    const na = a.get(id);
    if (!na) {
      lines.push(`新增「${nb.title}」`);
      continue;
    }
    const changed = Object.keys(FIELD_LABEL).filter(
      (k) => JSON.stringify((na as unknown as Record<string, unknown>)[k] ?? null) !== JSON.stringify((nb as unknown as Record<string, unknown>)[k] ?? null),
    );
    if (changed.length) lines.push(`修改「${nb.title}」：${changed.map((k) => FIELD_LABEL[k]).join('、')}`);
  }
  for (const [id, na] of a) if (!b.has(id)) lines.push(`删除「${na.title}」`);
  const order = (g: WorkflowGraph) => g.nodes.filter((n) => n.type === 'step' && a.has(n.id) && b.has(n.id)).map((n) => n.id).join(',');
  if (order(before) !== order(after)) lines.push('阶段顺序有调整');
  return lines;
}

// ── persistence ──
export interface DraftMeta {
  note?: string;
  aliases?: string[];
  whenToUse?: string;
  description?: string;
  sourceRef?: string;
}

/** Save `graph` as the workflow's draft: replace the open draft, or open a new draft version. */
export async function saveDraft(
  ref: string,
  rawGraph: unknown,
  meta: DraftMeta,
  createdBy: 'user' | 'ai',
): Promise<{ ok: true; detail: WorkflowDetailDTO; version: number } | { ok: false; status: number; errors: string[] }> {
  const g = parseGraph(rawGraph);
  if (!g.ok) return { ok: false, status: 400, errors: g.errors };
  const w = await findWorkflowRef(ref);
  if (!w) return { ok: false, status: 404, errors: [`找不到 SOP「${ref}」`] };
  const latest = [...w.versions].sort((x, y) => y.version - x.version)[0];
  const graph = g.graph as unknown as object;
  let version: number;
  if (latest && latest.state === 'draft') {
    await prisma.workflowVersion.update({ where: { id: latest.id }, data: { graph, note: meta.note ?? latest.note, createdBy } });
    version = latest.version;
  } else {
    version = (latest?.version ?? 0) + 1;
    await prisma.workflowVersion.create({ data: { workflowId: w.id, version, graph, state: 'draft', createdBy, note: meta.note ?? null } });
  }
  const fields = { aliases: meta.aliases, whenToUse: meta.whenToUse, description: meta.description, sourceRef: meta.sourceRef };
  const fresh = await prisma.workflow.update({
    where: { id: w.id },
    data: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
    include: { versions: { orderBy: { version: 'asc' } } },
  });
  return { ok: true, detail: toDetail(fresh), version };
}

const slugify = (name: string) =>
  (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sop') + `-${Date.now().toString(36)}`;

/** A brand-new SOP, as a draft (v1). */
export async function createDraftWorkflow(input: {
  name: string;
  slug?: string;
  aliases?: string[];
  whenToUse?: string;
  description?: string;
  sourceRef?: string;
  graph: unknown;
}): Promise<{ ok: true; slug: string; detail: WorkflowDetailDTO } | { ok: false; errors: string[] }> {
  const g = parseGraph(input.graph);
  if (!g.ok) return { ok: false, errors: g.errors };
  const slug = input.slug ?? slugify(input.name);
  if (await prisma.workflow.findUnique({ where: { slug } })) return { ok: false, errors: [`workflow 标识「${slug}」已被占用`] };
  const w = await prisma.workflow.create({
    data: {
      slug,
      name: input.name,
      aliases: input.aliases ?? [],
      whenToUse: input.whenToUse ?? null,
      description: input.description ?? null,
      sourceRef: input.sourceRef ?? null,
      status: 'draft',
      versions: { create: { version: 1, graph: g.graph as unknown as object, state: 'draft', createdBy: 'ai' } },
    },
    include: { versions: true },
  });
  return { ok: true, slug, detail: toDetail(w) };
}

/** Promote the open draft to the confirmed version. Callers must have the USER's decision. */
export async function confirmLatestDraft(ref: string): Promise<{ ok: true; detail: WorkflowDetailDTO } | { ok: false; status: number; errors: string[] }> {
  const w = await findWorkflowRef(ref);
  if (!w) return { ok: false, status: 404, errors: ['not found'] };
  const draft = [...w.versions].sort((a, b) => b.version - a.version).find((v) => v.state === 'draft');
  if (!draft) return { ok: false, status: 409, errors: ['没有待确认的草稿版本。'] };
  const g = parseGraph(draft.graph);
  if (!g.ok) return { ok: false, status: 400, errors: g.errors };
  await prisma.$transaction([
    prisma.workflowVersion.updateMany({ where: { workflowId: w.id, state: 'confirmed' }, data: { state: 'superseded' } }),
    prisma.workflowVersion.update({ where: { id: draft.id }, data: { state: 'confirmed', confirmedAt: new Date() } }),
    prisma.workflow.update({ where: { id: w.id }, data: { status: 'confirmed', confirmedVersion: draft.version } }),
  ]);
  const fresh = await prisma.workflow.findUniqueOrThrow({ where: { id: w.id }, include: { versions: { orderBy: { version: 'asc' } } } });
  return { ok: true, detail: toDetail(fresh) };
}

/** What changed in the open draft relative to the confirmed version (for the confirm card / page). */
export function draftChanges(w: { versions: WorkflowVersion[]; confirmedVersion: number | null }): string[] | null {
  const draft = [...w.versions].sort((a, b) => b.version - a.version).find((v) => v.state === 'draft');
  if (!draft) return null;
  const base = w.versions.find((v) => v.version === w.confirmedVersion);
  if (!base) return ['首次确认'];
  return diffGraphs(base.graph as unknown as WorkflowGraph, draft.graph as unknown as WorkflowGraph);
}

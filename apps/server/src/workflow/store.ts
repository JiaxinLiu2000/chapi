import type { Prisma } from '@prisma/client';
import type {
  NodeRunStatus,
  WorkflowGraph,
  WorkflowNodeRunDTO,
  WorkflowRunDTO,
  WorkflowRunStatus,
} from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { stageProgress, substepStates } from './progress.js';

/** Prisma access + DTO mapping for workflow runs (the engine is the only writer). */

export const ACTIVE_RUN_STATUSES: WorkflowRunStatus[] = ['running', 'waiting_user', 'blocked'];

const runInclude = { nodeRuns: true, workflow: { select: { name: true } } } satisfies Prisma.WorkflowRunInclude;
export type RunRow = Prisma.WorkflowRunGetPayload<{ include: typeof runInclude }>;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toNodeRunDTO(n: RunRow['nodeRuns'][number], graph?: WorkflowGraph): WorkflowNodeRunDTO {
  const substeps = substepStates(graph?.nodes.find((x) => x.id === n.nodeId), n.substeps);
  return {
    id: n.id,
    nodeId: n.nodeId,
    iterKey: n.iterKey,
    status: n.status as NodeRunStatus,
    agentId: n.agentId ?? null,
    agentRunId: n.agentRunId ?? null,
    summary: n.summary ?? null,
    evidence: (n.evidence as Record<string, unknown> | null) ?? null,
    review: (n.review as WorkflowNodeRunDTO['review']) ?? null,
    attempts: n.attempts,
    substeps,
    progress: stageProgress(n.status, substeps),
    startedAt: iso(n.startedAt),
    endedAt: iso(n.endedAt),
  };
}

export function toRunDTO(r: RunRow): WorkflowRunDTO {
  return {
    id: r.id,
    workflowId: r.workflowId,
    workflowName: r.workflow.name,
    version: r.version,
    sessionId: r.sessionId,
    label: r.label ?? null,
    status: r.status as WorkflowRunStatus,
    graph: r.graph as unknown as WorkflowGraph,
    cursor: (r.cursor as WorkflowRunDTO['cursor']) ?? null,
    pendingToken: r.pendingToken ?? null,
    nodeRuns: r.nodeRuns.map((n) => toNodeRunDTO(n, r.graph as unknown as WorkflowGraph)),
    createdAt: r.createdAt.toISOString(),
    endedAt: iso(r.endedAt),
  };
}

export async function loadActiveRun(sessionId: string): Promise<RunRow | null> {
  return prisma.workflowRun.findFirst({
    where: { sessionId, status: { in: ACTIVE_RUN_STATUSES } },
    include: runInclude,
    orderBy: { createdAt: 'desc' },
  });
}

export async function loadRun(runId: string): Promise<RunRow | null> {
  return prisma.workflowRun.findUnique({ where: { id: runId }, include: runInclude });
}

export async function listSessionRuns(sessionId: string): Promise<WorkflowRunDTO[]> {
  const rows = await prisma.workflowRun.findMany({ where: { sessionId }, include: runInclude, orderBy: { createdAt: 'asc' } });
  return rows.map(toRunDTO);
}

export function emitRun(run: RunRow): WorkflowRunDTO {
  const dto = toRunDTO(run);
  bus.emit({ type: 'workflow.run.updated', sessionId: run.sessionId, run: dto });
  return dto;
}

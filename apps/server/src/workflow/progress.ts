import type { SubstepState, WorkflowNodeDef } from '@chapi/shared';

/**
 * A stage's 0-100 progress (drives the progress fill in the task flow):
 *   pending 0 · dispatched/redo 5 + 85 × resolved sub-steps (15 when the stage has none)
 *   · submitted 95 · done / skipped / external 100.
 */
export function stageProgress(status: string, substeps: SubstepState[]): number {
  switch (status) {
    case 'done':
    case 'skipped':
    case 'external':
      return 100;
    case 'submitted':
      return 95;
    case 'pending':
      return 0;
    default: {
      if (!substeps.length) return 15;
      const resolved = substeps.filter((s) => s.status !== 'pending').length;
      return Math.round(5 + (85 * resolved) / substeps.length);
    }
  }
}

/** Fresh (all pending) sub-step states for a new attempt of `node`. */
export function freshSubsteps(node: WorkflowNodeDef): SubstepState[] {
  return (node.substeps ?? []).map((s) => ({ id: s.id, status: 'pending', note: null }));
}

/** Stored states aligned to the node's declared sub-steps (missing ones = pending). */
export function substepStates(node: WorkflowNodeDef | undefined, stored: unknown): SubstepState[] {
  const list = Array.isArray(stored) ? (stored as SubstepState[]) : [];
  return (node?.substeps ?? []).map((s) => list.find((x) => x.id === s.id) ?? { id: s.id, status: 'pending', note: null });
}

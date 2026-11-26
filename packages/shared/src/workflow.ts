/**
 * Workflow (SOP) definitions and run state — see
 * docs/superpowers/specs/2026-11-22-workflow-sop-design.md.
 * Phase 1 supports linear graphs of start → step… → end.
 */

export type EvidenceFieldType = 'int' | 'number' | 'string' | 'bool' | 'list' | 'path';

export interface EvidenceField {
  key: string;
  type: EvidenceFieldType;
  /** Defaults to true. */
  required?: boolean;
  desc?: string;
  /**
   * Text deliverable: the sub-agent submits the full text as this field's value and
   * the server writes it to `<stage output dir>/<saveAs>` (sub-agents may not write
   * report files themselves). The stored evidence value becomes the file path.
   * Only for `string` fields; a bare file name.
   */
  saveAs?: string;
}

export interface WorkflowIO {
  name: string;
  /** Upstream nodeId this input comes from. */
  from?: string;
  /** File name convention inside the stage's output dir. */
  file?: string;
  desc?: string;
}

export type WorkflowNodeType = 'start' | 'end' | 'step';

export interface WorkflowNodeDef {
  id: string;
  type: WorkflowNodeType;
  title: string;
  /** The SOP's original text for this stage — handed to the sub-agent verbatim. */
  instructions?: string;
  inputs?: WorkflowIO[];
  outputs?: WorkflowIO[];
  doneCriteria?: string[];
  evidence?: EvidenceField[];
  agent?: { model?: string; maxTurns?: number };
  /**
   * What the stage's sub-agent may recall from the knowledge graph (default `skills`).
   * - `none`: a pure tool — no recall at all, wiki tools and the session memory dir are off;
   *   it judges only from the SOP text, its inputs and what it finds this run.
   * - `skills`: only tool-usage know-how (how to drive a site / API), never recalled
   *   preferences or old data — the SOP text is the authority.
   */
  memory?: WorkflowMemoryMode;
  /**
   * The stage's own action items (shown as 1.1, 1.2 … under the stage). The sub-agent
   * marks each one done / na as it goes; all must be resolved before it can submit.
   */
  substeps?: WorkflowSubstepDef[];
  /** Canvas icon: a brand key (gmail, googlesheets, googledrive, googlecalendar, googleappsscript, slack, linkedin) or a type key (search, verify, write, review, summary, classify, match, phone, prep, calc, extract). Inferred from the stage text when absent. */
  icon?: string;
}

export interface WorkflowSubstepDef {
  id: string;
  title: string;
}

export type SubstepStatus = 'pending' | 'done' | 'na';
export interface SubstepState {
  id: string;
  status: SubstepStatus;
  note: string | null;
}

export type WorkflowMemoryMode = 'none' | 'skills';

export interface WorkflowGraph {
  nodes: WorkflowNodeDef[];
  edges: { from: string; to: string }[];
}

export type WorkflowStatus = 'draft' | 'confirmed' | 'archived';

export type NodeRunStatus =
  | 'pending'
  | 'dispatched'
  | 'submitted'
  | 'done'
  | 'redo'
  | 'skipped'
  | 'external'
  | 'failed'
  | 'blocked'
  | 'waiting_user';

export type WorkflowRunStatus = 'running' | 'waiting_user' | 'blocked' | 'done' | 'cancelled' | 'failed';

export interface CriterionVerdict {
  criterion: string;
  verdict: 'met' | 'na';
  reason: string;
}

export interface WorkflowNodeRunDTO {
  id: string;
  nodeId: string;
  iterKey: string;
  status: NodeRunStatus;
  agentId: string | null;
  agentRunId: string | null;
  summary: string | null;
  evidence: Record<string, unknown> | null;
  review: { decision: 'accept' | 'redo'; perCriterion: CriterionVerdict[]; feedback: string | null } | null;
  attempts: number;
  /** Sub-step states of the current attempt (empty when the stage has none). */
  substeps: SubstepState[];
  /** 0-100. */
  progress: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface WorkflowRunDTO {
  id: string;
  workflowId: string;
  workflowName: string;
  version: number;
  sessionId: string;
  label: string | null;
  status: WorkflowRunStatus;
  graph: WorkflowGraph;
  cursor: { nodeId: string; iterKey: string } | null;
  pendingToken: string | null;
  nodeRuns: WorkflowNodeRunDTO[];
  createdAt: string;
  endedAt: string | null;
}

export interface WorkflowSummaryDTO {
  id: string;
  slug: string;
  name: string;
  status: WorkflowStatus;
  confirmedVersion: number | null;
  whenToUse: string | null;
  aliases: string[];
  /** A draft version newer than the confirmed one is waiting for the user's confirmation. */
  pendingDraftVersion: number | null;
}

export interface WorkflowDetailDTO extends WorkflowSummaryDTO {
  /** Stage-level changes of the pending draft vs the confirmed version (null = no draft). */
  pendingChanges?: string[] | null;
  description: string | null;
  sourceRef: string | null;
  versions: { version: number; state: 'draft' | 'confirmed' | 'superseded'; graph: WorkflowGraph; note: string | null; createdAt: string }[];
}

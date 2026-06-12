/**
 * Core domain model shared between the server and the web client.
 * These are the client-facing DTO shapes (the server maps Prisma rows to these).
 */

// ── Enums (string-literal unions) ─────────────────────────────────────────

export const SESSION_STATUSES = ['active', 'completed', 'deleted'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const RUN_STATES = ['idle', 'running', 'paused', 'done', 'error'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const AGENT_RUN_STATUSES = [
  'idle',
  'running',
  'done',
  'error',
  'interrupted',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const PLAN_TASK_STATUSES = ['pending', 'in_progress', 'done', 'error'] as const;
export type PlanTaskStatus = (typeof PLAN_TASK_STATUSES)[number];

export const MESSAGE_ROLES = ['user', 'assistant', 'tool', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const TOOL_CALL_STATUSES = ['running', 'done', 'error'] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const ARTIFACT_KINDS = ['file', 'drive', 'sheet', 'doc', 'draft', 'pdf'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const PENDING_QUESTION_STATUSES = ['open', 'answered'] as const;
export type PendingQuestionStatus = (typeof PENDING_QUESTION_STATUSES)[number];

export const APPROVAL_STATUSES = ['open', 'approved', 'rejected', 'revise'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Permission profile for a run. `web` is restricted (no editing platform code); `vscode` is full. */
export const PERMISSION_PROFILES = ['web', 'vscode'] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

/** Reasoning effort levels (Claude Agent SDK). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Selectable Claude models shown in the UI. */
export const MODEL_OPTIONS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 · 最强' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 · 均衡' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 · 最快' },
] as const;

export const NOTIFICATION_LEVELS = ['info', 'question', 'success', 'error'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

// ── Message content blocks (assistant/tool turns) ─────────────────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

// ── DTOs ──────────────────────────────────────────────────────────────────

export interface UsageDTO {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Wall-clock time the AI was actively running (excludes idle/HITL waits). */
  activeMs: number;
}

export interface SessionDTO {
  id: string;
  slug: string;
  title: string;
  status: SessionStatus;
  model: string;
  effort: EffortLevel;
  permissionProfile: PermissionProfile;
  usage: UsageDTO;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDTO {
  id: string;
  sessionId: string;
  role: MessageRole;
  /** SDK message subtype, e.g. "assistant", "result", "tool_result". */
  type: string;
  content: ContentBlock[];
  text: string;
  tokens: number;
  agentRunId: string | null;
  createdAt: string;
}

export interface AgentRunDTO {
  id: string;
  sessionId: string;
  /** "main" for the orchestrator, otherwise the sub-agent name. */
  name: string;
  status: AgentRunStatus;
  currentTool: string | null;
  currentActivity: string | null;
  tokens: number;
  startedAt: string | null;
  endedAt: string | null;
  /** Active elapsed ms for this agent. */
  elapsedMs: number;
}

export interface ToolCallDTO {
  id: string;
  sessionId: string;
  agentRunId: string | null;
  toolName: string;
  inputPreview: string;
  outputPreview: string | null;
  status: ToolCallStatus;
  durationMs: number | null;
  createdAt: string;
}

export interface PlanTaskDTO {
  id: string;
  sessionId: string;
  ordinal: number;
  text: string;
  status: PlanTaskStatus;
}

export interface AttachmentDTO {
  id: string;
  sessionId: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
}

export interface WebPageDTO {
  id: string;
  sessionId: string | null;
  url: string;
  title: string | null;
  summary: string | null;
  fetchedAt: string;
}

export interface ArtifactDTO {
  id: string;
  sessionId: string;
  kind: ArtifactKind;
  pathOrUrl: string;
  title: string;
  createdAt: string;
}

export interface PendingQuestionDTO {
  id: string;
  sessionId: string;
  agentRunId: string | null;
  question: string;
  options: string[] | null;
  answer: string | null;
  status: PendingQuestionStatus;
  createdAt: string;
}

export interface ApprovalRequestDTO {
  id: string;
  sessionId: string;
  summary: string;
  artifacts: ArtifactDTO[];
  status: ApprovalStatus;
  feedback: string | null;
  createdAt: string;
}

export interface WikiEntryDTO {
  id: string;
  slug: string;
  title: string;
  bodyMd: string;
  sourceRefs: WikiSourceRef[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WikiSourceRef {
  /** "raw-material" | "web" | "session-message" | "artifact" */
  kind: string;
  /** A file path, URL, or message id that backs this knowledge (for verification). */
  ref: string;
  note?: string;
}

export interface WikiSearchHit {
  entry: WikiEntryDTO;
  chunk: string;
  score: number;
  sourceRef: WikiSourceRef | null;
}

export interface MemorySummaryDTO {
  id: string;
  sessionId: string;
  roundStart: number;
  roundEnd: number;
  summary: string;
  createdAt: string;
}

/** Non-secret settings surfaced to the client. Secret values are write-only. */
export interface PublicSettingsDTO {
  mainModel: string;
  subagentModel: string;
  embeddingModel: string;
  hasOpenAiKey: boolean;
  hasAnthropicKey: boolean;
  hasGoogleOAuth: boolean;
  canvaEnabled: boolean;
}

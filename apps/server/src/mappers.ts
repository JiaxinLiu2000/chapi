import type {
  AgentRun,
  Approval,
  Artifact,
  Attachment,
  Message,
  MemorySummary,
  PendingQuestion,
  PlanTask,
  Session,
  ToolCall,
  WebPage,
  WikiEntry,
} from '@prisma/client';
import type {
  AgentRunDTO,
  ApprovalRequestDTO,
  ApprovalStatus,
  ArtifactDTO,
  ArtifactKind,
  AttachmentDTO,
  ContentBlock,
  EffortLevel,
  MemorySummaryDTO,
  MessageDTO,
  MessageRole,
  PendingQuestionDTO,
  PendingQuestionStatus,
  PermissionProfile,
  PlanTaskDTO,
  PlanTaskStatus,
  SessionDTO,
  SessionStatus,
  ToolCallDTO,
  ToolCallStatus,
  UsageDTO,
  WebPageDTO,
  WikiEntryDTO,
  WikiSourceRef,
} from '@chapi/shared';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();

export function sessionUsage(s: Session): UsageDTO {
  return {
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheCreationTokens: s.cacheCreationTokens,
    totalTokens: s.totalTokens,
    costUsd: s.costUsd,
    activeMs: s.activeMs,
  };
}

export function toSessionDTO(s: Session): SessionDTO {
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    status: s.status as SessionStatus,
    model: s.model,
    subagentModel: s.subagentModel || s.model,
    effort: s.effort as EffortLevel,
    permissionProfile: s.permissionProfile as PermissionProfile,
    usage: sessionUsage(s),
    createdAt: isoReq(s.createdAt),
    updatedAt: isoReq(s.updatedAt),
  };
}

export function toMessageDTO(m: Message): MessageDTO {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role as MessageRole,
    type: m.type,
    content: (m.content as unknown as ContentBlock[]) ?? [],
    text: m.text,
    tokens: m.tokens,
    agentRunId: m.agentRunId,
    createdAt: isoReq(m.createdAt),
  };
}

export function toAgentRunDTO(a: AgentRun): AgentRunDTO {
  return {
    id: a.id,
    sessionId: a.sessionId,
    name: a.name,
    title: a.title,
    status: a.status as AgentRunDTO['status'],
    currentTool: a.currentTool,
    currentActivity: a.currentActivity,
    tokens: a.tokens,
    startedAt: iso(a.startedAt),
    endedAt: iso(a.endedAt),
    elapsedMs: a.elapsedMs,
  };
}

export function toToolCallDTO(t: ToolCall): ToolCallDTO {
  return {
    id: t.id,
    sessionId: t.sessionId,
    agentRunId: t.agentRunId,
    toolName: t.toolName,
    inputPreview: t.inputPreview,
    outputPreview: t.outputPreview,
    status: t.status as ToolCallStatus,
    durationMs: t.durationMs,
    createdAt: isoReq(t.createdAt),
  };
}

export function toPlanTaskDTO(p: PlanTask): PlanTaskDTO {
  return {
    id: p.id,
    sessionId: p.sessionId,
    ordinal: p.ordinal,
    text: p.text,
    status: p.status as PlanTaskStatus,
  };
}

export function toAttachmentDTO(a: Attachment): AttachmentDTO {
  return {
    id: a.id,
    sessionId: a.sessionId,
    filename: a.filename,
    mime: a.mime,
    size: a.size,
    createdAt: isoReq(a.createdAt),
  };
}

export function toWebPageDTO(w: WebPage): WebPageDTO {
  return {
    id: w.id,
    sessionId: w.sessionId,
    url: w.url,
    title: w.title,
    summary: w.summary,
    fetchedAt: isoReq(w.fetchedAt),
  };
}

export function toArtifactDTO(a: Artifact): ArtifactDTO {
  return {
    id: a.id,
    sessionId: a.sessionId,
    kind: a.kind as ArtifactKind,
    pathOrUrl: a.pathOrUrl,
    title: a.title,
    createdAt: isoReq(a.createdAt),
  };
}

export function toPendingQuestionDTO(q: PendingQuestion): PendingQuestionDTO {
  return {
    id: q.id,
    sessionId: q.sessionId,
    agentRunId: q.agentRunId,
    question: q.question,
    options: (q.options as unknown as string[] | null) ?? null,
    answer: q.answer,
    status: q.status as PendingQuestionStatus,
    createdAt: isoReq(q.createdAt),
  };
}

export function toApprovalDTO(a: Approval): ApprovalRequestDTO {
  return {
    id: a.id,
    sessionId: a.sessionId,
    summary: a.summary,
    artifacts: (a.artifacts as unknown as ArtifactDTO[]) ?? [],
    status: a.status as ApprovalStatus,
    feedback: a.feedback,
    createdAt: isoReq(a.createdAt),
  };
}

export function toWikiEntryDTO(w: WikiEntry): WikiEntryDTO {
  return {
    id: w.id,
    slug: w.slug,
    title: w.title,
    bodyMd: w.bodyMd,
    sourceRefs: (w.sourceRefs as unknown as WikiSourceRef[]) ?? [],
    tags: (w.tags as unknown as string[]) ?? [],
    createdAt: isoReq(w.createdAt),
    updatedAt: isoReq(w.updatedAt),
  };
}

export function toMemorySummaryDTO(m: MemorySummary): MemorySummaryDTO {
  return {
    id: m.id,
    sessionId: m.sessionId,
    roundStart: m.roundStart,
    roundEnd: m.roundEnd,
    summary: m.summary,
    createdAt: isoReq(m.createdAt),
  };
}

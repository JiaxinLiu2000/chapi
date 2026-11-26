import type {
  AgentRun,
  Approval,
  Artifact,
  Attachment,
  Automation,
  AutomationRun,
  Message,
  MemorySummary,
  PendingQuestion,
  PlanTask,
  Project,
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
  AutomationDTO,
  AutomationRunDTO,
  AutomationRunStatus,
  AutomationRunTrigger,
  EffortLevel,
  Language,
  MemorySummaryDTO,
  MessageDTO,
  MessageRole,
  PendingQuestionDTO,
  PendingQuestionStatus,
  PermissionProfile,
  PlanTaskDTO,
  PlanTaskStatus,
  ProjectDTO,
  ScheduleSpec,
  SessionDTO,
  SessionStatus,
  TitleSource,
  ToolCallDTO,
  ToolCallStatus,
  UsageDTO,
  WebPageDTO,
  KnowledgeHistoryItem,
  KnowledgeKind,
  WikiEntryDTO,
  WikiSourceRef,
} from '@chapi/shared';
import { KNOWLEDGE_KINDS } from '@chapi/shared';
import { isUserChromeEnabled } from './services/userChrome.js';

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
    claudeCalls: s.claudeCalls,
    toolCallCount: s.toolCallCount,
    learnings: s.learnings,
  };
}

export function toSessionDTO(s: Session): SessionDTO {
  return {
    id: s.id,
    slug: s.slug,
    title: s.title,
    titleSource: (s.titleSource as TitleSource) ?? 'auto',
    status: s.status as SessionStatus,
    model: s.model,
    subagentModel: s.subagentModel || s.model,
    effort: s.effort as EffortLevel,
    language: (s.language as Language) ?? 'zh',
    accountMode: (s.accountMode as SessionDTO['accountMode']) ?? 'auto',
    qualityReviewMinutes: s.qualityReviewMinutes ?? 0,
    qualityModel: s.qualityModel ?? '',
    userChrome: isUserChromeEnabled(s.id),
    permissionProfile: s.permissionProfile as PermissionProfile,
    usage: sessionUsage(s),
    createdAt: isoReq(s.createdAt),
    updatedAt: isoReq(s.updatedAt),
  };
}

// Not populated: the client only ever renders `text`, and `content` can carry
// large tool output — shipping it would just bloat the payload for long sessions.
export function toMessageDTO(m: Message): MessageDTO {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role as MessageRole,
    type: m.type,
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
    summary: a.summary,
    tokens: a.tokens,
    startedAt: iso(a.startedAt),
    endedAt: iso(a.endedAt),
    elapsedMs: a.elapsedMs,
    scheduledFor: iso(a.scheduledFor),
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
    reason: p.reason ?? null,
    replacesId: p.replacesId ?? null,
    startedAt: iso(p.startedAt),
    endedAt: iso(p.endedAt),
    locked: p.locked,
    depth: p.depth,
    progress: p.progress ?? null,
    nodeRunId: p.nodeRunId ?? null,
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
    source: q.source === 'learning' ? 'learning' : 'agent',
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
    category: w.category || '未分类',
    aliases: (w.aliases as unknown as string[] | null) ?? [],
    relPath: w.relPath ?? '',
    kind: (KNOWLEDGE_KINDS as readonly string[]).includes(w.kind) ? (w.kind as KnowledgeKind) : 'skill',
    topics: (w.topics as unknown as string[] | null) ?? [],
    score: w.score ?? 50,
    polarity: w.polarity === 'positive' || w.polarity === 'negative' ? w.polarity : '',
    situation: w.situation ?? '',
    solution: w.solution ?? '',
    observedAt: iso(w.observedAt),
    history: (w.history as unknown as KnowledgeHistoryItem[] | null) ?? [],
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

export function toProjectDTO(
  p: Project,
  stats: { sessionCount: number; lastActivityAt: Date | null },
): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    summary: p.summary,
    summaryAt: iso(p.summaryAt),
    sessionCount: stats.sessionCount,
    lastActivityAt: iso(stats.lastActivityAt),
    sortOrder: p.sortOrder,
  };
}

export function toAutomationRunDTO(r: AutomationRun, session: { slug: string } | null): AutomationRunDTO {
  return {
    id: r.id,
    automationId: r.automationId,
    sessionId: r.sessionId,
    sessionSlug: session?.slug ?? null,
    workflowRunId: r.workflowRunId,
    workflowVersion: r.workflowVersion,
    trigger: r.trigger as AutomationRunTrigger,
    status: r.status as AutomationRunStatus,
    note: r.note,
    dueAt: iso(r.dueAt),
    startedAt: isoReq(r.startedAt),
    endedAt: iso(r.endedAt),
  };
}

export function toAutomationDTO(
  a: Automation,
  extra: {
    workflow: { slug: string; name: string; confirmed: boolean } | null;
    lastRun: AutomationRunDTO | null;
    openRuns: AutomationRunDTO[];
  },
): AutomationDTO {
  return {
    id: a.id,
    name: a.name,
    workflowSlug: extra.workflow?.slug ?? null,
    workflowName: extra.workflow?.name ?? null,
    workflowConfirmed: extra.workflow?.confirmed ?? false,
    prompt: a.prompt,
    schedule: a.schedule as unknown as ScheduleSpec,
    mode: a.mode === 'auto' ? 'auto' : 'manual',
    enabled: a.enabled,
    model: a.model,
    effort: a.effort,
    inputs: (a.inputs as Record<string, string> | null) ?? null,
    projectId: a.projectId,
    nextRunAt: iso(a.nextRunAt),
    autoSince: iso(a.autoSince),
    lastRun: extra.lastRun,
    openRuns: extra.openRuns,
  };
}

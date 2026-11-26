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
  'scheduled',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const PLAN_TASK_STATUSES = [
  'pending',
  'in_progress',
  'done',
  'failed',
  'problem',
  'replaced',
  'blocked',
  'error', // legacy alias of replaced (kept for back-compat)
] as const;
export type PlanTaskStatus = (typeof PLAN_TASK_STATUSES)[number];

/** UI language for talking to the user (outputs/research still default to English). */
export const ACCOUNT_MODES = ['auto', 'primary', 'fallback'] as const;
export type AccountMode = (typeof ACCOUNT_MODES)[number];

export const LANGUAGES = ['zh', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

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

export const TITLE_SOURCES = ['auto', 'ai', 'user'] as const;
export type TitleSource = (typeof TITLE_SOURCES)[number];

/** Selectable Claude models shown in the UI. */
export const MODEL_OPTIONS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1 · 最强' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 · 强' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 · 均衡' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 · 最快' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;

/**
 * The best model an account can use, ranked by `MODEL_OPTIONS` order (strongest
 * first). Used to downgrade gracefully when a model isn't available on an account
 * (e.g. switching to a fallback seat without Fable 5 access) — both on a manual
 * account switch and an automatic rate-limit failover.
 */
export function topAllowedModel(allowedIds: readonly string[] | undefined | null): string {
  if (allowedIds && allowedIds.length) {
    const ranked = MODEL_OPTIONS.find((m) => allowedIds.includes(m.id));
    if (ranked) return ranked.id;
    return allowedIds[0]!;
  }
  return MODEL_OPTIONS[0].id;
}

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
  /** Total Claude turns/calls so far (sum of result.num_turns). */
  claudeCalls: number;
  /** Total tool invocations so far. */
  toolCallCount: number;
  /** Times knowledge was sedimented to the wiki (wiki_write). */
  learnings: number;
}

export interface SessionDTO {
  id: string;
  slug: string;
  title: string;
  /** Where the title came from: a first-message placeholder, an AI summary, or the user's own rename. */
  titleSource: TitleSource;
  status: SessionStatus;
  model: string;
  subagentModel: string;
  effort: EffortLevel;
  language: Language;
  /** Which Claude seat this session uses: auto (primary→fallback) | primary | fallback. */
  accountMode: AccountMode;
  /** Periodic quality-review interval in minutes; 0 = off. */
  qualityReviewMinutes: number;
  /** Quality-advisor model; "" = follow the sub-agent model. */
  qualityModel: string;
  /** May the agent use the user's own logged-in Chrome? Off = cloakbrowser only. */
  userChrome: boolean;
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
  /** Raw content blocks. Omitted from list/history responses — the client only
   * ever renders `text`, so shipping this (which can carry large tool output)
   * would just bloat the payload for long sessions with nothing rendering it. */
  content?: ContentBlock[];
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
  /** main: the task title; sub-agent: its short task description. */
  title: string | null;
  status: AgentRunStatus;
  /** Short category tag of the current tool use (e.g. 浏览器, 联网搜索, 编辑). */
  currentTool: string | null;
  /** Human-friendly one-line description of the current activity. */
  currentActivity: string | null;
  /** Sub-agent work summary shown after it finishes (its last assistant message). */
  summary: string | null;
  tokens: number;
  startedAt: string | null;
  endedAt: string | null;
  /** Active elapsed ms for this agent. */
  elapsedMs: number;
  /** When a scheduled task will fire (status='scheduled'); drives the countdown. */
  scheduledFor: string | null;
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
  /** Why it failed / hit a problem / was blocked / was replaced. */
  reason: string | null;
  /** The step this one replaced (a change of approach). */
  replacesId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Workflow-owned step: the engine sets its status; the model can't remove or finish it. */
  locked: boolean;
  /** 0 = step, 1 = sub-step shown indented under its stage. */
  depth: number;
  /** 0-100 progress of an engine-owned row (null for the model's own steps). */
  progress: number | null;
  nodeRunId: string | null;
}

export interface AttachmentDTO {
  id: string;
  sessionId: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Path of the sandbox copy, relative to the session sandbox cwd (e.g. "uploads/123-file.png"). */
  sandboxPath?: string;
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
  /** agent = ask_user (blocks the run); learning = preference conflict from the learning agent (never blocks). */
  source: 'agent' | 'learning';
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

/**
 * Knowledge point kinds:
 * - data: third-party facts from documents / the web / the user — has confidence, sources, timestamp
 * - skill: how to use tools, learned while working — has weight and tool tags
 * - preference: what the user expects in some situation — has weight, scenario tags, positive/negative
 */
export const KNOWLEDGE_KINDS = ['data', 'skill', 'preference'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KNOWLEDGE_KIND_LABEL: Record<KnowledgeKind, string> = { data: '数据', skill: '技能', preference: '偏好' };
/** Section labels per kind: [situation, solution]. */
export const KNOWLEDGE_SECTION_LABEL: Record<KnowledgeKind, [string, string]> = {
  data: ['数据对象 / 口径', '数据内容'],
  skill: ['情况 / 前提', '方案'],
  preference: ['场景 / 前提', '期望做法'],
};

export interface KnowledgeHistoryItem {
  at: string;
  op: string; // create | reinforce | weaken | merge_source | update | resolve | user_edit | import
  delta?: number;
  score?: number;
  note?: string;
  sessionId?: string;
}

export interface WikiEntryDTO {
  id: string;
  slug: string;
  title: string;
  bodyMd: string;
  sourceRefs: WikiSourceRef[];
  tags: string[];
  /** Obsidian vault folder under entries/ (e.g. "网页抓取与反爬"). */
  category: string;
  /** Alternate phrasings (Obsidian `aliases`). */
  aliases: string[];
  /** Note file inside the vault, e.g. "entries/技能/X.md" ("" until exported). */
  relPath: string;
  kind: KnowledgeKind;
  /** 1-3 content categories (which website / project / client / domain) — the primary grouping. */
  topics: string[];
  /** 0-100: confidence (data) or weight (skill / preference). */
  score: number;
  /** Preference only. */
  polarity: 'positive' | 'negative' | '';
  /** 情况 / 前提 (data: object & scope). */
  situation: string;
  /** 方案 (data: the data; preference: what the user wants). */
  solution: string;
  /** Data only: when the data is from. */
  observedAt: string | null;
  history: KnowledgeHistoryItem[];
  createdAt: string;
  updatedAt: string;
}

export interface WikiSourceRef {
  /** "raw-material" | "web" | "session-message" | "artifact" */
  kind: string;
  /** A file path, URL, or message id that backs this knowledge (for verification). */
  ref: string;
  note?: string;
  /** Data points: publish/update date of this source (YYYY-MM-DD). */
  date?: string;
  /** Data points: this source's own confidence 0-100. */
  confidence?: number;
  /** Data points: official | reputable | aggregator | community | unknown. */
  tier?: string;
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
  /** Quality advisor model ("" = follow the sub-agent model). */
  qualityModel: string;
  /** Learning agent model ("" = follow the sub-agent model). */
  learningModel: string;
  embeddingModel: string;
  hasOpenAiKey: boolean;
  hasAnthropicKey: boolean;
  hasGoogleOAuth: boolean;
  googleConnected: boolean;
  googleUserEmail: string;
  canvaEnabled: boolean;
  enableBrowser: boolean;
  browserHidden: boolean;
  maxSubagents: number;
  maxBrowserPages: number; // 1 or 2 live browser panes
  // Claude account failover: primary subscription, auto-switch to fallback on limit.
  hasClaudeTokenPrimary: boolean;
  hasClaudeTokenFallback: boolean;
  claudeEmailPrimary: string;
  claudeEmailFallback: string;
  claudeActive: 'primary' | 'fallback'; // which account is currently active
  claudePrimaryResetAt: string; // ISO when primary's rate limit resets (real or estimated), or ''
  claudeCooldownH: number; // hours before retrying primary after a switch
  claudeModelsPrimary: string[]; // model IDs the primary seat may use
  claudeModelsFallback: string[]; // model IDs the fallback seat may use
  // Email verification (AfterShip email-verifier); proxy password is write-only.
  emailVerifyEnabled: boolean;
  emailVerifyProxyHost: string;
  emailVerifyProxyPort: number | null;
  emailVerifyProxyUsername: string;
  hasEmailVerifyProxyPassword: boolean;
  emailVerifyFromEmail: string;
  emailVerifyHelloName: string;
}

// ---- Board / automations (see docs/superpowers/specs/2026-11-24-board-automations-design.md) ----

export interface ScheduleSpec {
  kind: 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';
  /** Local PT time, 'HH:mm'. */
  time: string;
  /** 0-6 (Sun-Sat) for weekly / biweekly. */
  weekdays?: number[];
  /** 'YYYY-MM-DD' anchoring which week a biweekly schedule fires on. */
  anchorDate?: string;
  /** 1-31 for monthly (single day; older form). */
  dayOfMonth?: number;
  /** 1-31, several days for monthly (wins over dayOfMonth). Days past the month end clamp to its last day. */
  daysOfMonth?: number[];
}

/** 'history' = a past session linked by hand / by the AI as an earlier run (always done). */
export type AutomationRunTrigger = 'manual' | 'cron' | 'catchup' | 'history';
export type AutomationRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'stale';

export interface ProjectDTO {
  id: string;
  name: string;
  summary: string | null;
  summaryAt: string | null;
  sessionCount: number;
  lastActivityAt: string | null;
  sortOrder: number;
}

export interface AutomationRunDTO {
  id: string;
  automationId: string;
  /** null when the session was deleted. */
  sessionId: string | null;
  sessionSlug: string | null;
  workflowRunId: string | null;
  workflowVersion: number | null;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  note: string | null;
  dueAt: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface AutomationDTO {
  id: string;
  name: string;
  workflowSlug: string | null;
  workflowName: string | null;
  /** True when the bound SOP has a confirmed version (required before mode can be 'auto'). */
  workflowConfirmed: boolean;
  prompt: string | null;
  schedule: ScheduleSpec;
  mode: 'manual' | 'auto';
  enabled: boolean;
  model: string;
  effort: string;
  inputs: Record<string, string> | null;
  projectId: string | null;
  nextRunAt: string | null;
  autoSince: string | null;
  lastRun: AutomationRunDTO | null;
  /** Unfinished runs (queued / running / waiting_user / stale). */
  openRuns: AutomationRunDTO[];
}

// ── WeChat remote ──────────────────────────────────────────────────────────

export type WechatLoginStatus = 'idle' | 'wait' | 'scaned' | 'need_verifycode' | 'confirmed' | 'expired' | 'error';

export interface WechatLoginDTO {
  status: WechatLoginStatus;
  /** SVG markup of the login QR code (while waiting for a scan). */
  qrSvg?: string;
  message?: string;
}

export interface WechatBindingDTO {
  sessionId: string;
  slug: string;
  title: string;
  tag: string;
  focused: boolean;
}

export interface WechatStatusDTO {
  loggedIn: boolean;
  accountStatus: 'none' | 'active' | 'stale' | 'logged_out';
  botId: string | null;
  polling: boolean;
  /** True once the user has messaged the bot at least once (a context token exists). */
  pushReady: boolean;
  lastInboundAt: string | null;
  lastError: string | null;
  /** Pushes waiting to be re-sent on the next inbound message. */
  queued: number;
  focusSessionId: string | null;
  bindings: WechatBindingDTO[];
}

export interface WechatSessionStateDTO {
  loggedIn: boolean;
  connected: boolean;
  tag: string | null;
  focused: boolean;
}

// ── Discord remote ─────────────────────────────────────────────────────────

export interface DiscordChannelOption {
  id: string;
  name: string;
  guild: string;
}

export interface DiscordBindingDTO {
  sessionId: string;
  slug: string;
  title: string;
  threadId: string;
  threadUrl: string | null;
}

export interface DiscordStatusDTO {
  configured: boolean;
  connected: boolean;
  botTag: string | null;
  /** Invite link to add the bot to a server (once the token is known). */
  inviteUrl: string | null;
  owners: string[];
  channelId: string | null;
  channels: DiscordChannelOption[];
  lastError: string | null;
  /** Automation runs get a thread by themselves · manual automations ping the channel when due. */
  prefs: { autoAutomations: boolean; remindManual: boolean };
  bindings: DiscordBindingDTO[];
}

export interface DiscordSessionStateDTO {
  ready: boolean;
  connected: boolean;
  threadUrl: string | null;
}

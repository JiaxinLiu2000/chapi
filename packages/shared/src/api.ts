/**
 * REST API request/response contracts (the non-streaming surface).
 * The live run surface is the WebSocket protocol in events.ts.
 */
import { z } from 'zod';
import type { WorkflowRunDTO } from './workflow.js';
import type {
  AgentRunDTO,
  ApprovalRequestDTO,
  ArtifactDTO,
  AttachmentDTO,
  MessageDTO,
  PendingQuestionDTO,
  PlanTaskDTO,
  ProjectDTO,
  PublicSettingsDTO,
  RunState,
  SessionDTO,
  WikiEntryDTO,
  WikiSearchHit,
} from './domain.js';

// ── Sessions ────────────────────────────────────────────────────────────────

export const createSessionSchema = z.object({
  /** Optional first message; if present the title is derived from it. */
  firstMessage: z.string().optional(),
  title: z.string().optional(),
  permissionProfile: z.enum(['web', 'vscode']).optional(),
  model: z.string().optional(),
  // Initial per-session config chosen on the home page (falls back to defaults).
  subagentModel: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  language: z.enum(['zh', 'en']).optional(),
  accountMode: z.enum(['auto', 'primary', 'fallback']).optional(),
  qualityReviewMinutes: z.number().int().min(0).max(120).optional(),
  qualityModel: z.string().optional(),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/** Rename a session. An empty title hands it back to the AI (regenerated from the conversation). */
export const renameSessionSchema = z.object({
  title: z.string().max(300),
});
export type RenameSessionInput = z.infer<typeof renameSessionSchema>;

/** One message whose text matched a history search. */
export interface SessionSearchMatch {
  messageId: string;
  role: 'user' | 'assistant';
  /** ~120 chars of the message around the first hit. */
  snippet: string;
  createdAt: string;
}

/** Sessions whose messages contain the query, most recently updated first. */
export interface SessionSearchResponse {
  results: {
    sessionId: string;
    /** Total matching messages in this session. */
    matchCount: number;
    /** The most recent few matches. */
    matches: SessionSearchMatch[];
  }[];
}

export interface CreateSessionResponse {
  session: SessionDTO;
}

export interface ListSessionsResponse {
  sessions: SessionDTO[];
}

export interface SessionDetailResponse {
  session: SessionDTO;
  /** Most recent page only (see `hasMoreMessages`); older ones load via `/sessions/:id/messages`. */
  messages: MessageDTO[];
  /** True when there are older messages beyond this initial page. */
  hasMoreMessages: boolean;
  plan: PlanTaskDTO[];
  agents: AgentRunDTO[];
  artifacts: ArtifactDTO[];
  attachments: AttachmentDTO[];
  openQuestions: PendingQuestionDTO[];
  /**
   * Approvals a live run is still blocked on. Without these a reload/reopen
   * lost the approval card and the run waited forever.
   */
  openApprovals: ApprovalRequestDTO[];
  /** Every workflow run in this session (oldest first), for the live progress views. */
  workflowRuns: WorkflowRunDTO[];
  /**
   * Whether the agent is working right now. `run.state` events only fire on
   * transitions, so without this a reload mid-run showed 'idle' (no stop button).
   */
  runState: RunState;
}

/** A page of older messages, oldest-to-newest, for infinite-scroll-up. */
export interface EarlierMessagesResponse {
  messages: MessageDTO[];
  hasMore: boolean;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export const updateSettingsSchema = z.object({
  openAiKey: z.string().optional(),
  anthropicKey: z.string().optional(),
  googleOAuthClientId: z.string().optional(),
  googleOAuthClientSecret: z.string().optional(),
  googleUserEmail: z.string().optional(),
  mainModel: z.string().optional(),
  subagentModel: z.string().optional(),
  qualityModel: z.string().optional(),
  learningModel: z.string().optional(),
  embeddingModel: z.string().optional(),
  canvaEnabled: z.boolean().optional(),
  enableBrowser: z.boolean().optional(),
  browserHidden: z.boolean().optional(),
  maxSubagents: z.number().int().min(1).max(8).optional(),
  maxBrowserPages: z.number().int().min(1).max(2).optional(),
  claudeTokenPrimary: z.string().optional(),
  claudeTokenFallback: z.string().optional(),
  claudeEmailPrimary: z.string().optional(),
  claudeEmailFallback: z.string().optional(),
  claudeCooldownH: z.number().int().min(1).max(72).optional(),
  claudeModelsPrimary: z.array(z.string()).optional(),
  claudeModelsFallback: z.array(z.string()).optional(),
  // Email verification (AfterShip email-verifier, built locally from tools/email-verifier).
  emailVerifyEnabled: z.boolean().optional(),
  emailVerifyProxyHost: z.string().optional(), // SOCKS5; '' clears (= no proxy)
  emailVerifyProxyPort: z.number().int().min(1).max(65535).nullable().optional(),
  emailVerifyProxyUsername: z.string().optional(),
  emailVerifyProxyPassword: z.string().optional(),
  emailVerifyFromEmail: z.string().optional(),
  emailVerifyHelloName: z.string().optional(),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export interface SettingsResponse {
  settings: PublicSettingsDTO;
}

// ── Wiki ─────────────────────────────────────────────────────────────────────

export interface WikiListResponse {
  entries: WikiEntryDTO[];
}

export const wikiSearchSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).optional(),
});
export type WikiSearchInput = z.infer<typeof wikiSearchSchema>;

/** Knowledge graph of the wiki: notes as nodes, `[[wikilinks]]` as links. */
export interface WikiGraphResponse {
  nodes: Array<{
    id: string;
    slug: string;
    title: string;
    category: string;
    kind: 'data' | 'skill' | 'preference';
    /** Content categories; the first one is the primary group. */
    topics: string[];
    score: number;
    polarity: string;
    tags: string[];
    degree: number;
    updatedAt: string;
  }>;
  links: Array<{ source: string; target: string }>;
  /** Categories ordered by size (stable color assignment). */
  categories: string[];
  /** Content categories (topics) by number of points, biggest first. */
  topics: Array<{ name: string; count: number }>;
  /** Absolute path of the Obsidian vault on this machine. */
  vaultPath: string;
}

/** Create / edit a knowledge point by hand (web UI). */
export const wikiUpsertSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(['data', 'skill', 'preference']),
  /** 1-3 content categories. */
  topics: z.array(z.string()).max(3).optional(),
  score: z.number().int().min(0).max(100).optional(),
  polarity: z.enum(['positive', 'negative', '']).optional(),
  situation: z.string().optional(),
  solution: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  observedAt: z.string().nullable().optional(),
  sourceRefs: z
    .array(
      z.object({
        kind: z.string(),
        ref: z.string(),
        note: z.string().optional(),
        date: z.string().optional(),
        confidence: z.number().optional(),
        tier: z.string().optional(),
      }),
    )
    .optional(),
});
export type WikiUpsertInput = z.infer<typeof wikiUpsertSchema>;

export interface WikiTagsResponse {
  tags: Array<{ name: string; kind: string; aliases: string[]; count: number }>;
}

export interface WikiSyncResponse {
  created: number;
  updated: number;
  deleted: number;
  exported: number;
}

export interface WikiSearchResponse {
  hits: WikiSearchHit[];
}

// ── Uploads ──────────────────────────────────────────────────────────────────

export interface UploadResponse {
  attachments: AttachmentDTO[];
}

// ── Generic ──────────────────────────────────────────────────────────────────

export interface GoogleConnectResponse {
  status: 'connected' | 'authorizing' | 'error';
  authUrl?: string;
  message: string;
}

export interface BrowserLoginResponse {
  status: 'launched' | 'error';
  message: string;
}

export interface BrowserStatusResponse {
  installed: boolean;
  serving: boolean; // cloakserve CDP reachable
  enabled: boolean; // enableBrowser setting
  profileDir: string;
  message: string;
  logs: string[]; // recent cloakserve/install log lines for diagnostics
}

// ── Email verification ───────────────────────────────────────────────────────

export const emailVerifySchema = z.object({
  emails: z.array(z.string()).min(1).max(200),
});
export type EmailVerifyInput = z.infer<typeof emailVerifySchema>;

/** Compact verdict for one address (mapped from AfterShip email-verifier's Result). */
export interface EmailVerifyResult {
  email: string;
  /** safe = deliverable · risky = catch-all/full inbox/role/disposable · invalid · unknown = SMTP unverifiable */
  status: 'safe' | 'risky' | 'invalid' | 'unknown';
  syntaxValid: boolean;
  /** Typo-fix suggestion when it differs from the input (e.g. gmial.com → gmail.com). */
  suggestion: string | null;
  mxAcceptsMail: boolean | null; // null = not checked (bad syntax, disposable, DNS error)
  canConnectSmtp: boolean | null; // null = SMTP step not reached
  deliverable: boolean | null; // null = SMTP step errored/skipped
  catchAll: boolean | null;
  fullInbox: boolean | null;
  disabled: boolean | null;
  disposable: boolean;
  roleAccount: boolean;
  /** Free webmail provider (gmail.com, qq.com, …). */
  free: boolean;
  /** Verifier error (SMTP timeout/refusal, DNS failure), if any. */
  error: string | null;
}

export interface EmailVerifyResponse {
  results: EmailVerifyResult[];
  /** Human-readable caveats (e.g. port 25 blocked and no proxy configured). */
  notes: string[];
}

export interface EmailVerifyStatusResponse {
  enabled: boolean;
  ready: boolean; // verifier binary built from the current source
  building: boolean;
  /** Is a Go toolchain available to build the verifier? null = not checked yet. */
  goInstalled: boolean | null;
  proxyConfigured: boolean;
  /** Can this machine open outbound TCP 25? null = not probed yet. */
  port25Open: boolean | null;
  message: string;
  logs: string[];
}

export interface OkResponse {
  ok: true;
}

export interface ErrorResponse {
  error: string;
}

// ---- Board ----

export interface BoardSessionCard {
  id: string;
  slug: string;
  title: string;
  projectName: string | null;
  state: RunState;
  progress: string | null;
  waitingKind: 'question' | 'approval' | null;
  updatedAt: string;
  automationRunId: string | null;
  /** Automation run left waiting after its next slot already fired. */
  stale: boolean;
}

export interface BoardProjectsDTO {
  projects: ProjectDTO[];
  unassignedCount: number;
  /** A full re-classification is running on the server. */
  classifying: boolean;
}

export interface BoardTodayDTO {
  running: BoardSessionCard[];
  waiting: BoardSessionCard[];
  done: BoardSessionCard[];
}

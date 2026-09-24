/**
 * REST API request/response contracts (the non-streaming surface).
 * The live run surface is the WebSocket protocol in events.ts.
 */
import { z } from 'zod';
import type {
  AgentRunDTO,
  ArtifactDTO,
  AttachmentDTO,
  MessageDTO,
  PendingQuestionDTO,
  PlanTaskDTO,
  PublicSettingsDTO,
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
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

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

export interface OkResponse {
  ok: true;
}

export interface ErrorResponse {
  error: string;
}

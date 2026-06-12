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
  messages: MessageDTO[];
  plan: PlanTaskDTO[];
  agents: AgentRunDTO[];
  artifacts: ArtifactDTO[];
  attachments: AttachmentDTO[];
  openQuestions: PendingQuestionDTO[];
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

export interface OkResponse {
  ok: true;
}

export interface ErrorResponse {
  error: string;
}

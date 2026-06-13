/**
 * WebSocket protocol between web client and server.
 *
 * - `ServerEvent` (server -> client): typed, pushed live during a run. The client
 *   trusts the server (same local codebase), so these are TS types only.
 * - `ClientCommand` (client -> server): validated at the boundary with zod.
 */
import { z } from 'zod';
import type {
  AgentRunDTO,
  ApprovalRequestDTO,
  ArtifactDTO,
  MessageDTO,
  NotificationLevel,
  PendingQuestionDTO,
  PlanTaskDTO,
  RunState,
  SessionDTO,
  ToolCallDTO,
  UsageDTO,
} from './domain.js';

export const WS_PATH = '/ws';

// ── Server -> Client ──────────────────────────────────────────────────────

export type ServerEvent =
  | { type: 'session.created'; session: SessionDTO }
  | { type: 'session.updated'; session: SessionDTO }
  | { type: 'run.state'; sessionId: string; state: RunState }
  | {
      type: 'assistant.delta';
      sessionId: string;
      messageId: string;
      agentRunId: string | null;
      text: string;
    }
  | { type: 'assistant.message'; sessionId: string; message: MessageDTO }
  | { type: 'tool.started'; sessionId: string; toolCall: ToolCallDTO }
  | {
      type: 'tool.updated';
      sessionId: string;
      toolCallId: string;
      activity?: string;
      status?: ToolCallDTO['status'];
    }
  | {
      type: 'tool.finished';
      sessionId: string;
      toolCallId: string;
      status: ToolCallDTO['status'];
      durationMs: number;
      outputPreview?: string;
    }
  | { type: 'plan.updated'; sessionId: string; tasks: PlanTaskDTO[] }
  | { type: 'agent.status'; sessionId: string; agent: AgentRunDTO }
  | { type: 'usage.updated'; sessionId: string; usage: UsageDTO }
  | { type: 'question.open'; sessionId: string; question: PendingQuestionDTO }
  | { type: 'question.closed'; sessionId: string; questionId: string }
  | { type: 'approval.request'; sessionId: string; approval: ApprovalRequestDTO }
  | { type: 'approval.closed'; sessionId: string; approvalId: string }
  | { type: 'artifact.ready'; sessionId: string; artifact: ArtifactDTO }
  | {
      type: 'notification';
      sessionId: string | null;
      level: NotificationLevel;
      title: string;
      body: string;
    }
  | {
      // Live cloakbrowser screencast frame (base64 JPEG) projected into the UI.
      type: 'browser.frame';
      sessionId: string;
      page: number; // 0 or 1 (which pane)
      dataBase64: string;
      url: string | null;
    }
  | {
      type: 'browser.state';
      sessionId: string;
      page: number; // 0 or 1
      pageCount: number; // how many live panes (1 or 2)
      status: 'connecting' | 'connected' | 'disconnected' | 'unavailable';
      url: string | null;
      message?: string;
    }
  | {
      // Server asks the client to auto-open the live browser panel (agent used a browser tool).
      type: 'browser.show';
      sessionId: string;
    }
  | { type: 'error'; sessionId: string | null; message: string };

export type ServerEventType = ServerEvent['type'];

// ── Client -> Server ────────────────────────────────────────────────────────

export const clientCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.subscribe'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('session.unsubscribe'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('user.message'),
    sessionId: z.string().min(1),
    text: z.string(),
    attachmentIds: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('interrupt'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('answer.question'),
    sessionId: z.string().min(1),
    questionId: z.string().min(1),
    answer: z.string(),
  }),
  z.object({
    type: z.literal('approval.decision'),
    sessionId: z.string().min(1),
    approvalId: z.string().min(1),
    decision: z.enum(['approve', 'reject', 'revise']),
    feedback: z.string().optional(),
  }),
  z.object({ type: z.literal('mark.completed'), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal('browser.view'),
    sessionId: z.string().min(1),
    on: z.boolean(),
  }),
  z.object({
    type: z.literal('set.config'),
    sessionId: z.string().min(1),
    model: z.string().min(1).optional(),
    subagentModel: z.string().min(1).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    language: z.enum(['zh', 'en']).optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type ClientCommandType = ClientCommand['type'];

export function parseClientCommand(
  raw: unknown,
): { ok: true; command: ClientCommand } | { ok: false; error: string } {
  const parsed = clientCommandSchema.safeParse(raw);
  if (parsed.success) return { ok: true, command: parsed.data };
  return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
}

export function encodeServerEvent(event: ServerEvent): string {
  return JSON.stringify(event);
}

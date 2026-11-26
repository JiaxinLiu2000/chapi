import type { Approval, PendingQuestion } from '@prisma/client';
import type { ArtifactDTO } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { toMessageDTO } from '../mappers.js';

/**
 * HITL round-trips (approval requests, ask_user questions) used to live only in
 * the dock above the composer and vanish once answered. These write them into
 * the conversation itself — the AI's ask as one bubble, the user's decision /
 * feedback / chosen option as the reply — so they stay in the history.
 */

export const HITL_MESSAGE_TYPES = ['approval', 'approval_reply', 'question', 'answer'] as const;

const DECISION_LABEL: Record<string, string> = {
  approve: '✅ 通过',
  approved: '✅ 通过',
  revise: '✏️ 要求修改',
  reject: '✖️ 驳回',
  rejected: '✖️ 驳回',
};

export function approvalAskText(summary: string, artifacts: Array<Pick<ArtifactDTO, 'title' | 'pathOrUrl'>>, decision: string): string {
  const arts = artifacts.length
    ? `\n\n**交付物**\n${artifacts.map((a) => `- [${a.title || a.pathOrUrl}](${a.pathOrUrl})`).join('\n')}`
    : '';
  return `**成果待审批** · 结果：${DECISION_LABEL[decision] ?? decision}\n\n${summary.trim()}${arts}\n\n_选项：通过 / 要求修改 / 驳回_`;
}

export function approvalReplyText(decision: string, feedback?: string | null): string {
  const fb = feedback?.trim();
  return fb ? `${DECISION_LABEL[decision] ?? decision}\n\n${fb}` : (DECISION_LABEL[decision] ?? decision);
}

export function questionAskText(question: string, options: string[] | null, answer: string): string {
  const opts = options?.length
    ? `\n\n${options.map((o) => (o === answer ? `- **${o}** ✓` : `- ${o}`)).join('\n')}`
    : '';
  return `**AI 需要你的输入**\n\n${question.trim()}${opts}`;
}

async function writePair(
  sessionId: string,
  ask: { type: string; text: string; at: Date },
  reply: { type: string; text: string; at: Date },
  emit: boolean,
): Promise<void> {
  const a = await prisma.message.create({
    data: {
      sessionId,
      role: 'assistant',
      type: ask.type,
      content: [{ type: 'text', text: ask.text }] as unknown as object,
      text: ask.text,
      createdAt: ask.at,
    },
  });
  const r = await prisma.message.create({
    data: {
      sessionId,
      role: 'user',
      type: reply.type,
      content: [{ type: 'text', text: reply.text }] as unknown as object,
      text: reply.text,
      createdAt: reply.at,
    },
  });
  if (emit) {
    bus.emit({ type: 'assistant.message', sessionId, message: toMessageDTO(a) });
    bus.emit({ type: 'assistant.message', sessionId, message: toMessageDTO(r) });
  }
}

export async function recordApproval(row: Approval, decision: string, feedback: string | null, emit = true): Promise<void> {
  const artifacts = Array.isArray(row.artifacts) ? (row.artifacts as unknown as ArtifactDTO[]) : [];
  await writePair(
    row.sessionId,
    { type: 'approval', text: approvalAskText(row.summary, artifacts, decision), at: row.createdAt },
    { type: 'approval_reply', text: approvalReplyText(decision, feedback), at: row.decidedAt ?? new Date() },
    emit,
  );
}

export async function recordAnswer(row: PendingQuestion, answer: string, emit = true): Promise<void> {
  const options = Array.isArray(row.options) ? (row.options as string[]) : null;
  await writePair(
    row.sessionId,
    { type: 'question', text: questionAskText(row.question, options, answer), at: row.createdAt },
    { type: 'answer', text: answer.trim() || '(空)', at: row.answeredAt ?? new Date() },
    emit,
  );
}

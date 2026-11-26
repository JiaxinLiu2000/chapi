'use client';
import { memo } from 'react';
import type { MessageDTO } from '@chapi/shared';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';
import { RunCard } from './workflow/RunCard';

interface BubbleProps {
  /** Message id, exposed as data-msg-id so search results can scroll to it. */
  id?: string;
  role: string;
  type?: string;
  text: string;
  streaming?: boolean;
}

/**
 * Memoized so re-renders triggered by unrelated state (in particular the
 * `streaming` string, which changes on every streamed chunk from the SDK)
 * don't re-run this for every historical message — that used to mean
 * re-parsing Markdown for the entire conversation on every streamed
 * character, which is what made long conversations feel increasingly janky.
 */
// HITL round-trips recorded into the transcript (see server hitlTranscript.ts).
const HITL_LABEL: Record<string, string> = {
  approval: '成果审批',
  approval_reply: '我的审批',
  question: 'AI 提问',
  answer: '我的回答',
};

const Bubble = memo(function Bubble({ id, role, type, text, streaming }: BubbleProps) {
  const isUser = role === 'user';
  const isQuality = type === 'quality';
  const isApproval = type === 'approval';
  const isQuestion = type === 'question';
  const hitlLabel = type ? HITL_LABEL[type] : undefined;
  return (
    <div data-msg-id={id} className={cn('flex min-w-0', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'min-w-0 max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[85%]',
          // One card recipe; colour only marks the kind (a 3px left bar).
          isUser
            ? 'border border-accent/20 bg-accent/10'
            : cn(
                'border border-border bg-panel',
                isQuality && 'border-l-[3px] border-l-warn',
                isApproval && 'border-l-[3px] border-l-success',
                isQuestion && 'border-l-[3px] border-l-warn',
              ),
        )}
      >
        {isQuality && (
          <div className="mb-1 text-xs font-medium text-warn">质检</div>
        )}
        {hitlLabel && (
          <div
            className={cn(
              'mb-1 text-xs font-medium',
              isApproval ? 'text-success' : isQuestion ? 'text-warn' : 'text-muted',
            )}
          >
            {hitlLabel}
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap text-[14px] leading-[1.7] [overflow-wrap:anywhere]">{text}</div>
        ) : (
          <Markdown content={streaming ? `${text} ▍` : text} />
        )}
      </div>
    </div>
  );
});

export function MessageList({
  messages,
  streaming,
  running,
}: {
  messages: MessageDTO[];
  streaming: string;
  running: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {messages.length === 0 && !streaming && (
        <div className="py-12 text-center text-sm text-muted">描述你的任务，AI 会开始规划</div>
      )}
      {messages
        .filter((m) => m.text.trim().length > 0)
        .map((m) =>
          m.type === 'workflow_run' ? (
            <div key={m.id} data-msg-id={m.id} className="flex min-w-0 justify-start">
              <RunCard runId={m.text.trim()} />
            </div>
          ) : (
            <Bubble key={m.id} id={m.id} role={m.role} type={m.type} text={m.text} />
          ),
        )}
      {streaming && <Bubble role="assistant" text={streaming} streaming />}
      {running && !streaming && (
        <div className="flex items-center gap-2 pl-1 text-xs text-muted" role="status">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden /> AI 正在工作…
        </div>
      )}
    </div>
  );
}

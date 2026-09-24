'use client';
import { memo } from 'react';
import type { MessageDTO } from '@chapi/shared';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';

interface BubbleProps {
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
const Bubble = memo(function Bubble({ role, type, text, streaming }: BubbleProps) {
  const isUser = role === 'user';
  const isQuality = type === 'quality';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5',
          isUser
            ? 'border border-accent/30 bg-accent/15'
            : isQuality
              ? 'border border-warn/50 bg-warn/10'
              : 'border border-border bg-panel',
        )}
      >
        {isQuality && (
          <div className="mb-1 text-xs font-medium text-warn">🔍 质检</div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap text-[15px]">{text}</div>
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
        <div className="py-12 text-center text-sm text-muted">开始你的任务吧。</div>
      )}
      {messages
        .filter((m) => m.text.trim().length > 0)
        .map((m) => (
          <Bubble key={m.id} role={m.role} type={m.type} text={m.text} />
        ))}
      {streaming && <Bubble role="assistant" text={streaming} streaming />}
      {running && !streaming && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> AI 正在工作…
        </div>
      )}
    </div>
  );
}

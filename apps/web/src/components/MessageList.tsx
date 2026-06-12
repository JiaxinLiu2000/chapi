'use client';
import { useEffect, useRef } from 'react';
import type { MessageDTO } from '@chapi/shared';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';

function Bubble({ role, text, streaming }: { role: string; text: string; streaming?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-4 py-2.5',
          isUser ? 'border border-accent/30 bg-accent/15' : 'border border-border bg-panel',
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap text-[15px]">{text}</div>
        ) : (
          <Markdown content={streaming ? `${text} ▍` : text} />
        )}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  running,
}: {
  messages: MessageDTO[];
  streaming: string;
  running: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streaming, running]);

  return (
    <div className="flex flex-col gap-4">
      {messages.length === 0 && !streaming && (
        <div className="py-12 text-center text-sm text-muted">开始你的任务吧。</div>
      )}
      {messages.map((m) => (
        <Bubble key={m.id} role={m.role} text={m.text} />
      ))}
      {streaming && <Bubble role="assistant" text={streaming} streaming />}
      {running && !streaming && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" /> AI 正在工作…
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

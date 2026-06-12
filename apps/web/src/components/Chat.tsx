'use client';
import { CheckCircle2 } from 'lucide-react';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { QuestionDock } from './QuestionDock';
import { RunConfigBar } from './RunConfigBar';

export function Chat({ sessionId }: { sessionId: string }) {
  const messages = useStore((s) => s.messages);
  const streaming = useStore((s) => s.streaming);
  const runState = useStore((s) => s.runState);
  const session = useStore((s) => s.session);
  const completed = session?.status === 'completed';

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-1 flex-col">
      <RunConfigBar sessionId={sessionId} />
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl">
          <MessageList messages={messages} streaming={streaming} running={runState === 'running'} />
        </div>
      </div>
      <div className="border-t border-border bg-bg/70 px-4 py-3">
        <div className="mx-auto max-w-3xl space-y-3">
          <QuestionDock sessionId={sessionId} />
          <Composer sessionId={sessionId} disabled={completed} />
          {completed ? (
            <div className="flex items-center justify-center gap-2 text-sm text-success">
              <CheckCircle2 size={16} /> 已完成并归档
            </div>
          ) : (
            <button
              onClick={() => getSocket().send({ type: 'mark.completed', sessionId })}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-success/90 py-2.5 text-sm font-medium text-white transition hover:bg-success"
            >
              <CheckCircle2 size={16} /> 任务出色完成（学习并归档）
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

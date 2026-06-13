'use client';
import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { QuestionDock } from './QuestionDock';
import { RunConfigBar } from './RunConfigBar';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

export function Chat({ sessionId }: { sessionId: string }) {
  const messages = useStore((s) => s.messages);
  const streaming = useStore((s) => s.streaming);
  const runState = useStore((s) => s.runState);
  const session = useStore((s) => s.session);
  const completed = session?.status === 'completed';
  const [confirmDone, setConfirmDone] = useState(false);

  const markDone = () => {
    getSocket().send({ type: 'mark.completed', sessionId });
    setConfirmDone(false);
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-w-0 flex-1 flex-col">
      <RunConfigBar sessionId={sessionId} />
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl">
          <MessageList messages={messages} streaming={streaming} running={runState === 'running'} />
        </div>
      </div>
      <div className="border-t border-border bg-bg/70 px-4 py-3">
        <div className="mx-auto max-w-3xl space-y-3">
          <QuestionDock sessionId={sessionId} />
          {/* completion button sits to the RIGHT, aligned to the composer's bottom */}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Composer sessionId={sessionId} disabled={completed} />
            </div>
            {completed ? (
              <div className="flex shrink-0 items-center gap-1.5 rounded-xl border border-success/40 bg-success/10 px-3 py-2.5 text-xs font-medium text-success">
                <CheckCircle2 size={15} /> 已完成并归档
              </div>
            ) : (
              <button
                onClick={() => setConfirmDone(true)}
                title="将此任务标记为出色完成：平台会学习并归档，之后该对话变为只读"
                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-success/90 px-3 py-2.5 text-xs font-medium text-white transition hover:bg-success"
              >
                <CheckCircle2 size={15} /> 归档
              </button>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={confirmDone}
        onClose={() => setConfirmDone(false)}
        title="标记为出色完成？"
        className="max-w-sm"
      >
        <p className="text-sm text-muted">
          平台会学习并归档本次任务的成果与方案以便复现，<b className="text-text">该对话随后将变为只读</b>，无法继续对话。确定吗？
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmDone(false)}>
            取消
          </Button>
          <Button variant="success" onClick={markDone}>
            确认完成并归档
          </Button>
        </div>
      </Modal>
    </div>
  );
}

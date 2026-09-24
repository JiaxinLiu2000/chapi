'use client';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { QuestionDock } from './QuestionDock';
import { RunConfigBar } from './RunConfigBar';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

// Scrolling within this many px of the top triggers loading the previous page
// of older messages (infinite-scroll-up), so long sessions don't load/render
// their entire history up front.
const LOAD_EARLIER_THRESHOLD_PX = 150;

export function Chat({ sessionId }: { sessionId: string }) {
  const messages = useStore((s) => s.messages);
  const hasMoreMessages = useStore((s) => s.hasMoreMessages);
  const prependMessages = useStore((s) => s.prependMessages);
  const streaming = useStore((s) => s.streaming);
  const runState = useStore((s) => s.runState);
  const session = useStore((s) => s.session);
  const completed = session?.status === 'completed';
  const [confirmDone, setConfirmDone] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const running = runState === 'running';
  const isStreaming = streaming.length > 0;

  // Whether the user is parked at the bottom (should auto-follow new content)
  // or scrolled up to read history (shouldn't get yanked back down).
  const nearBottomRef = useRef(true);
  const updateNearBottom = () => {
    const el = scrollRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Auto-scroll to the newest content — but only on meaningful transitions
  // (a full message landed, or streaming/running started or ended), not on
  // every individual streamed character/chunk. That would otherwise re-trigger
  // a scroll many times per second on long responses, which is itself a source
  // of visible jank independent of how many past messages there are.
  useEffect(() => {
    if (nearBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, isStreaming, running]);

  const loadEarlier = async () => {
    if (loadingEarlier || !hasMoreMessages || messages.length === 0) return;
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    setLoadingEarlier(true);
    try {
      const res = await api.earlierMessages(sessionId, messages[0].id);
      prependMessages(res.messages, res.hasMore);
      // The list just grew above the fold — re-anchor the scroll position to
      // where the user was, instead of jumping to wherever the new top is.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight + prevTop;
      });
    } catch {
      // transient — the user can just scroll up again to retry
    } finally {
      setLoadingEarlier(false);
    }
  };

  const onScroll = () => {
    updateNearBottom();
    if (scrollRef.current && scrollRef.current.scrollTop < LOAD_EARLIER_THRESHOLD_PX) {
      void loadEarlier();
    }
  };

  const markDone = () => {
    getSocket().send({ type: 'mark.completed', sessionId });
    setConfirmDone(false);
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-w-0 flex-1 flex-col">
      <RunConfigBar sessionId={sessionId} />
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl">
          {hasMoreMessages && (
            <div className="pb-3 text-center text-xs text-muted">
              {loadingEarlier ? '加载更早的消息…' : '↑ 上滑加载更早的消息'}
            </div>
          )}
          <MessageList messages={messages} streaming={streaming} running={running} />
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

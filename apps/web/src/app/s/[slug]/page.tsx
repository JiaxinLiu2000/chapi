'use client';
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Chat } from '@/components/Chat';
import { MonitorCard } from '@/components/MonitorCard';
import { BrowserPanel } from '@/components/BrowserPanel';
import { WorkflowDock } from '@/components/workflow/WorkflowDock';
import { useSessionSocket } from '@/hooks/useSessionSocket';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';

export default function SessionPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  // ?m=<messageId> — opened from a history-search hit; Chat scrolls to it.
  const search = useSearchParams();
  const focusMessageId = search.get('m');
  const focusQuery = search.get('q');
  const loadDetail = useStore((s) => s.loadDetail);
  const resetActive = useStore((s) => s.resetActive);
  const browserViewOn = useStore((s) => s.browserViewOn);
  const workflowOpen = useStore((s) => s.workflowPanel.open && (s.workflowRuns.length > 0 || s.plan.length > 0));
  const sentFirst = useRef(false);

  // resizable split between chat and the live browser panel (lg+ only)
  const [browserWidth, setBrowserWidth] = useState(560);
  // the workflow canvas keeps its own width (wider by default: a snaked flow wants room)
  const [dockWidth, setDockWidth] = useState(680);
  const dragTo = (setWidth: (w: number) => void) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const w = window.innerWidth - ev.clientX;
      // Reserve room for the monitor (~320px) + a chat minimum (~380px).
      const maxW = Math.max(360, window.innerWidth - 320 - 380);
      setWidth(Math.min(Math.max(w, 320), maxW));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const startDrag = dragTo(setBrowserWidth);
  const startDockDrag = dragTo(setDockWidth);
  // Keyboard alternative to dragging: ←/→ widen/narrow the right panel by 24px.
  const keyTo = (width: number, setWidth: (w: number) => void) => (e: React.KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === 'ArrowLeft' ? 24 : e.key === 'ArrowRight' ? -24 : 0;
    if (!d) return;
    e.preventDefault();
    const maxW = Math.max(360, window.innerWidth - 320 - 380);
    setWidth(Math.min(Math.max(width + d, 320), maxW));
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['session', slug],
    queryFn: () => api.sessionBySlug(slug),
  });

  useEffect(() => {
    if (data) loadDetail(data);
    return () => resetActive();
  }, [data, loadDetail, resetActive]);

  useSessionSocket(data?.session.id ?? null);

  useEffect(() => {
    if (!data || sentFirst.current) return;
    const id = data.session.id;
    const pending = sessionStorage.getItem(`chapi:pending:${id}`);
    if (pending && data.messages.length === 0) {
      sentFirst.current = true;
      sessionStorage.removeItem(`chapi:pending:${id}`);
      setTimeout(() => {
        useStore.getState().addOptimisticUser(pending);
        getSocket().send({ type: 'user.message', sessionId: id, text: pending });
      }, 200);
    }
  }, [data]);

  if (isLoading)
    return (
      <div className="p-8 text-sm text-muted" role="status">
        加载中…
      </div>
    );
  if (error || !data)
    return (
      <div className="p-8 text-sm">
        <p className="text-danger">找不到这个对话，它可能已被删除</p>
        <Link href="/board" className="mt-2 inline-block text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
          去看板找其它会话
        </Link>
      </div>
    );

  return (
    <main id="main" tabIndex={-1} className="flex outline-none">
      <h1 className="sr-only">{data.session.title}</h1>
      <MonitorCard />
      <Chat sessionId={data.session.id} focusMessageId={focusMessageId} focusQuery={focusQuery} />
      {workflowOpen && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整对话与流程图的宽度（也可用左右方向键）"
            aria-valuenow={dockWidth}
            aria-valuemin={320}
            tabIndex={0}
            onPointerDown={startDockDrag}
            onKeyDown={keyTo(dockWidth, setDockWidth)}
            className="group relative hidden w-px shrink-0 cursor-col-resize bg-border lg:block"
          >
            <span className="absolute inset-y-0 -left-1 -right-1 transition-colors group-hover:bg-accent/40" />
          </div>
          <WorkflowDock width={dockWidth} />
        </>
      )}
      {browserViewOn && !workflowOpen && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整对话与浏览器的宽度（也可用左右方向键）"
            aria-valuenow={browserWidth}
            aria-valuemin={320}
            tabIndex={0}
            onPointerDown={startDrag}
            onKeyDown={keyTo(browserWidth, setBrowserWidth)}
            className="group relative hidden w-px shrink-0 cursor-col-resize bg-border lg:block"
          >
            {/* 9px invisible grab area around the 1px line */}
            <span className="absolute inset-y-0 -left-1 -right-1 transition-colors group-hover:bg-accent/40" />
          </div>
          <BrowserPanel sessionId={data.session.id} width={browserWidth} />
        </>
      )}
    </main>
  );
}

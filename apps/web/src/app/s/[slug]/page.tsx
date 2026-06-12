'use client';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Chat } from '@/components/Chat';
import { MonitorCard } from '@/components/MonitorCard';
import { BrowserPanel } from '@/components/BrowserPanel';
import { useSessionSocket } from '@/hooks/useSessionSocket';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';

export default function SessionPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const loadDetail = useStore((s) => s.loadDetail);
  const resetActive = useStore((s) => s.resetActive);
  const browserViewOn = useStore((s) => s.browserViewOn);
  const sentFirst = useRef(false);

  // resizable split between chat and the live browser panel
  const [browserWidth, setBrowserWidth] = useState(560);
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const w = window.innerWidth - e.clientX;
      setBrowserWidth(Math.min(Math.max(w, 320), Math.round(window.innerWidth * 0.75)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

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

  if (isLoading) return <div className="p-8 text-sm text-muted">加载中…</div>;
  if (error || !data) return <div className="p-8 text-sm text-danger">找不到该对话。</div>;

  return (
    <div className="flex">
      <MonitorCard />
      <Chat sessionId={data.session.id} />
      {browserViewOn && (
        <>
          <div
            onMouseDown={() => {
              dragging.current = true;
              document.body.style.userSelect = 'none';
            }}
            title="拖动调整对话与浏览器的占比"
            className="w-1.5 shrink-0 cursor-col-resize bg-border transition hover:bg-accent/50"
          />
          <BrowserPanel sessionId={data.session.id} width={browserWidth} />
        </>
      )}
    </div>
  );
}

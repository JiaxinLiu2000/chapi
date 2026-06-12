'use client';
import { useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Chat } from '@/components/Chat';
import { MonitorCard } from '@/components/MonitorCard';
import { useSessionSocket } from '@/hooks/useSessionSocket';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';

export default function SessionPage() {
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const loadDetail = useStore((s) => s.loadDetail);
  const resetActive = useStore((s) => s.resetActive);
  const sentFirst = useRef(false);

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
    </div>
  );
}

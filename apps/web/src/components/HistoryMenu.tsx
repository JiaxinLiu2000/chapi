'use client';
import { useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Search, Trash2 } from 'lucide-react';
import type { SessionDTO } from '@chapi/shared';
import { api } from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

type Filter = 'all' | 'active' | 'completed';

/** Recency bucket label for grouping (sessions arrive ordered by updatedAt desc). */
function bucket(iso: string): string {
  const day = 86400000;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(iso).getTime();
  if (t >= startOfToday) return '今天';
  if (t >= startOfToday - day) return '昨天';
  if (t >= startOfToday - 7 * day) return '过去 7 天';
  if (t >= startOfToday - 30 * day) return '过去 30 天';
  return '更早';
}

export function HistoryMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<SessionDTO | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.listSessions,
    enabled: open,
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const sessions = data?.sessions ?? [];
  const counts = useMemo(
    () => ({
      all: sessions.length,
      active: sessions.filter((s) => s.status !== 'completed').length,
      completed: sessions.filter((s) => s.status === 'completed').length,
    }),
    [sessions],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filter === 'active' && s.status === 'completed') return false;
      if (filter === 'completed' && s.status !== 'completed') return false;
      if (needle && !s.title.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [sessions, q, filter]);

  if (!open) return null;

  const tabs: { key: Filter; label: string }[] = [
    { key: 'all', label: `全部 ${counts.all}` },
    { key: 'active', label: `进行中 ${counts.active}` },
    { key: 'completed', label: `已归档 ${counts.completed}` },
  ];

  let lastBucket = '';

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed right-3 top-16 z-50 flex max-h-[78vh] w-96 flex-col overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl">
        {/* header: search + filter chips */}
        <div className="shrink-0 border-b border-border p-3">
          <div className="relative mb-2.5">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted/60" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索历史对话…"
              className="w-full rounded-lg border border-border bg-panel2 py-2 pl-8 pr-3 text-sm outline-none transition placeholder:text-muted/50 focus:border-accent/60"
            />
          </div>
          <div className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setFilter(t.key)}
                className={cn(
                  'flex-1 rounded-lg px-2 py-1 text-xs font-medium transition',
                  filter === t.key
                    ? 'bg-accent/15 text-accent'
                    : 'text-muted hover:bg-panel2 hover:text-text',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* list */}
        <div className="flex-1 overflow-y-auto p-2">
          {isLoading && <div className="px-2 py-6 text-center text-sm text-muted">加载中…</div>}
          {!isLoading && sessions.length === 0 && (
            <div className="px-2 py-6 text-center text-sm text-muted">还没有对话。</div>
          )}
          {!isLoading && sessions.length > 0 && filtered.length === 0 && (
            <div className="px-2 py-6 text-center text-sm text-muted">没有匹配的对话。</div>
          )}
          <ul className="space-y-0.5">
            {filtered.map((s) => {
              const b = bucket(s.updatedAt);
              const header = b !== lastBucket ? ((lastBucket = b), b) : null;
              const isCurrent = pathname === `/s/${s.slug}`;
              return (
                <li key={s.id}>
                  {header && (
                    <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted/60">
                      {header}
                    </div>
                  )}
                  <div
                    className={cn(
                      'group flex items-center gap-2 rounded-lg px-2 py-2 transition',
                      isCurrent ? 'bg-panel2 ring-1 ring-accent/40' : 'hover:bg-panel2',
                    )}
                  >
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => {
                        onClose();
                        router.push(`/s/${s.slug}`);
                      }}
                    >
                      <div className="flex items-center gap-1.5 text-sm">
                        {s.status === 'completed' ? (
                          <CheckCircle2 size={14} className="shrink-0 text-success" />
                        ) : (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
                        )}
                        <span className="line-clamp-1">{s.title}</span>
                      </div>
                      <div className="mt-0.5 pl-[1.375rem] text-xs text-muted/70">
                        {relativeTime(s.updatedAt)}
                      </div>
                    </button>
                    <button
                      className="shrink-0 rounded p-1 text-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                      title="删除"
                      onClick={() => setConfirm(s)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title="删除对话？" className="max-w-sm">
        <p className="text-sm text-muted">
          确定删除「{confirm?.title}」？这将永久删除该对话的消息、记忆与沙盘文件，无法恢复。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={del.isPending}
            onClick={() => confirm && del.mutate(confirm.id)}
          >
            {del.isPending ? '删除中…' : '确认删除'}
          </Button>
        </div>
      </Modal>
    </>
  );
}

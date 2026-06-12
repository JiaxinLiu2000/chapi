'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Trash2 } from 'lucide-react';
import type { SessionDTO } from '@chapi/shared';
import { api } from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

export function HistoryMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<SessionDTO | null>(null);

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

  if (!open) return null;
  const sessions = data?.sessions ?? [];

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="fixed right-3 top-16 z-50 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-border bg-panel shadow-2xl">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold text-muted">
          历史对话
        </div>
        {isLoading && <div className="px-3 py-4 text-sm text-muted">加载中…</div>}
        {!isLoading && sessions.length === 0 && (
          <div className="px-3 py-4 text-sm text-muted">还没有对话。</div>
        )}
        <ul>
          {sessions.map((s) => (
            <li
              key={s.id}
              className="group flex items-center gap-2 px-3 py-2 hover:bg-panel2"
            >
              <button
                className="flex-1 text-left"
                onClick={() => {
                  onClose();
                  router.push(`/s/${s.slug}`);
                }}
              >
                <div className="flex items-center gap-1.5 text-sm">
                  {s.status === 'completed' && (
                    <CheckCircle2 size={14} className="shrink-0 text-success" />
                  )}
                  <span className="line-clamp-1">{s.title}</span>
                </div>
                <div className="text-xs text-muted">{relativeTime(s.updatedAt)}</div>
              </button>
              <button
                className="rounded p-1 text-muted opacity-0 transition hover:text-danger group-hover:opacity-100"
                title="删除"
                onClick={() => setConfirm(s)}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
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

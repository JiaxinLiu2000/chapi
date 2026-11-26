'use client';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Pencil, Search, Trash2 } from 'lucide-react';
import type { ListSessionsResponse, SessionDTO, SessionSearchResponse } from '@chapi/shared';
import { api } from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';
import { useUrlParam } from '@/lib/urlState';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

type Filter = 'all' | 'active' | 'completed';
type ContentHit = SessionSearchResponse['results'][number];

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

/** `text` with every case-insensitive occurrence of `needle` highlighted. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  for (let at = lower.indexOf(n); at >= 0; at = lower.indexOf(n, i)) {
    if (at > i) parts.push(text.slice(i, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-accent/25 px-0.5 text-text">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    i = at + needle.length;
  }
  parts.push(text.slice(i));
  return <>{parts.map((p, k) => <Fragment key={k}>{p}</Fragment>)}</>;
}

/** Debounce a fast-changing value (the search box) so the server isn't hit per keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function HistoryMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<SessionDTO | null>(null);
  const confirmRef = useRef<SessionDTO | null>(null);
  confirmRef.current = confirm;
  const [q, setQ] = useState('');
  // The filter lives in `?history=active|completed` (全部 = no param; unknown → 全部).
  const [filterParam, setFilterParam] = useUrlParam('history');
  const filter: Filter = filterParam === 'active' || filterParam === 'completed' ? filterParam : 'all';
  const setFilter = (f: Filter) => setFilterParam(f === 'all' ? null : f);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Esc closes; the search box takes focus on desktop only (no surprise keyboard on phones).
  useEffect(() => {
    if (!open) return;
    if (window.matchMedia('(pointer: fine)').matches) searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // The delete dialog and an open rename handle their own Esc.
      if (e.key === 'Escape' && !openEditRef.current && !confirmRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  // Which row's edit is still open — Enter/Esc close it before the input's blur
  // fires, so the blur must not save a second time (or save after a cancel).
  const openEditRef = useRef<string | null>(null);

  const needle = q.trim();
  const searchTerm = useDebounced(needle, 250);

  const { data, isLoading } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.listSessions,
    enabled: open,
  });

  const content = useQuery({
    queryKey: ['sessionSearch', searchTerm],
    queryFn: () => api.searchSessions(searchTerm),
    enabled: open && searchTerm.length > 0,
    staleTime: 30_000,
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameSession(id, title),
    onSuccess: ({ session }) => {
      qc.setQueryData<ListSessionsResponse>(['sessions'], (old) =>
        old ? { sessions: old.sessions.map((s) => (s.id === session.id ? session : s)) } : old,
      );
      // An empty title asks the AI for a new one; it lands a few seconds later.
      if (session.titleSource === 'auto') {
        setTimeout(() => qc.invalidateQueries({ queryKey: ['sessions'] }), 8000);
      }
    },
  });

  const startEdit = (s: SessionDTO) => {
    openEditRef.current = s.id;
    setEditingId(s.id);
    setDraft(s.title);
    setTimeout(() => editRef.current?.select(), 0);
  };
  const cancelEdit = () => {
    openEditRef.current = null;
    setEditingId(null);
  };
  const commitEdit = (s: SessionDTO) => {
    if (openEditRef.current !== s.id) return;
    cancelEdit();
    const next = draft.replace(/\s+/g, ' ').trim();
    // Unchanged → nothing to do (and don't turn an AI title into a "user" one).
    if (next === s.title) return;
    rename.mutate({ id: s.id, title: next });
  };

  const sessions = data?.sessions ?? [];
  const counts = useMemo(
    () => ({
      all: sessions.length,
      active: sessions.filter((s) => s.status !== 'completed').length,
      completed: sessions.filter((s) => s.status === 'completed').length,
    }),
    [sessions],
  );

  // Content hits only count for the term they were fetched for — while the
  // debounce catches up, fall back to title-only matching for the new text.
  const hits = useMemo(() => {
    const m = new Map<string, ContentHit>();
    if (searchTerm === needle) for (const r of content.data?.results ?? []) m.set(r.sessionId, r);
    return m;
  }, [content.data, searchTerm, needle]);

  const filtered = useMemo(() => {
    const n = needle.toLowerCase();
    return sessions.filter((s) => {
      if (filter === 'active' && s.status === 'completed') return false;
      if (filter === 'completed' && s.status !== 'completed') return false;
      if (n && !s.title.toLowerCase().includes(n) && !hits.has(s.id)) return false;
      return true;
    });
  }, [sessions, needle, filter, hits]);

  if (!open) return null;

  const tabs: { key: Filter; label: string }[] = [
    { key: 'all', label: `全部 ${counts.all}` },
    { key: 'active', label: `进行中 ${counts.active}` },
    { key: 'completed', label: `已归档 ${counts.completed}` },
  ];
  const searchingContent = needle.length > 0 && (searchTerm !== needle || content.isFetching);

  const go = (s: SessionDTO, messageId?: string) => {
    onClose();
    router.push(
      messageId
        ? `/s/${s.slug}?m=${encodeURIComponent(messageId)}&q=${encodeURIComponent(needle)}`
        : `/s/${s.slug}`,
    );
  };

  let lastBucket = '';

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label="历史记录"
        className="anim-pop fixed inset-x-2 top-16 z-50 flex max-h-[calc(100dvh-5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-panel [--origin:top_right] sm:inset-x-auto sm:right-3 sm:w-96 sm:max-h-[78vh]"
      >
        {/* header: search + filter chips */}
        <div className="shrink-0 border-b border-border p-3">
          <div className="relative mb-2.5">
            <Search size={16} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              ref={searchRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索标题和对话内容…"
              aria-label="搜索对话"
              autoComplete="off"
              className="field pl-8"
            />
          </div>
          <div className="flex gap-1 rounded-[10px] bg-panel2 p-0.5" role="group" aria-label="筛选">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setFilter(t.key)}
                aria-pressed={filter === t.key}
                className={cn(
                  'press h-8 flex-1 rounded-md px-2 text-xs font-medium tabular-nums [@media(pointer:coarse)]:h-10',
                  filter === t.key ? 'bg-panel text-text shadow-[0_0_0_1px_rgb(var(--c-border))]' : 'text-muted hover:text-text',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* list */}
        <div className="scroll-area min-h-0 flex-1 p-2">
          {isLoading && <div className="px-2 py-6 text-center text-sm text-muted">加载中…</div>}
          {!isLoading && sessions.length === 0 && (
            <div className="px-2 py-6 text-center text-sm text-muted">还没有对话</div>
          )}
          {!isLoading && sessions.length > 0 && filtered.length === 0 && (
            <div className="px-2 py-6 text-center text-sm text-muted">
              {searchingContent ? '正在搜索对话内容…' : '没有匹配的对话'}
            </div>
          )}
          {content.isError && needle && (
            <div className="px-2 pb-2 text-xs text-danger">对话内容搜索失败，只显示标题匹配，稍后再试</div>
          )}
          <ul className="space-y-0.5">
            {filtered.map((s) => {
              const b = bucket(s.updatedAt);
              const header = b !== lastBucket ? ((lastBucket = b), b) : null;
              const isCurrent = pathname === `/s/${s.slug}`;
              const hit = needle ? hits.get(s.id) : undefined;
              const editing = editingId === s.id;
              return (
                <li key={s.id}>
                  {header && (
                    <div className="px-2 pb-1 pt-3 text-2xs font-medium text-muted first:pt-1">
                      {header}
                    </div>
                  )}
                  <div
                    className={cn(
                      'group rounded-xl px-2 py-2 transition-colors',
                      isCurrent ? 'bg-panel2' : 'hover:bg-panel2/70 has-[>div>button:active]:bg-panel2',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {editing ? (
                        <div className="min-w-0 flex-1">
                          <input
                            ref={editRef}
                            value={draft}
                            maxLength={120}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit(s);
                              if (e.key === 'Escape') {
                                e.stopPropagation(); // cancels the rename only, not the whole panel
                                cancelEdit();
                              }
                            }}
                            onBlur={() => commitEdit(s)}
                            aria-label="新的对话名称"
                            autoComplete="off"
                            className="field h-8 px-2"
                          />
                          <div className="mt-1 text-2xs text-muted">
                            回车保存 · Esc 取消 · 清空后保存则由 AI 重新生成标题
                          </div>
                        </div>
                      ) : (
                        <button className="min-w-0 flex-1 text-left" onClick={() => go(s)}>
                          <div className="flex items-center gap-1.5 text-sm">
                            {/* One 14px slot for either marker, so titles (and the meta below) line up. */}
                            <span className="grid w-3.5 shrink-0 place-items-center" aria-hidden>
                              {s.status === 'completed' ? (
                                <CheckCircle2 size={14} className="text-success" />
                              ) : (
                                <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
                              )}
                            </span>
                            <span className="truncate" title={s.title}>
                              <Highlight text={s.title} needle={needle} />
                            </span>
                          </div>
                          <div className="mt-0.5 pl-5 text-xs text-muted">
                            {relativeTime(s.updatedAt)}
                            {hit && ` · ${hit.matchCount} 条消息匹配`}
                          </div>
                        </button>
                      )}
                      {!editing && (
                        <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                          <button
                            className="act h-8 w-8"
                            title="重命名"
                            aria-label={`重命名「${s.title}」`}
                            onClick={() => startEdit(s)}
                          >
                            <Pencil size={14} aria-hidden />
                          </button>
                          <button
                            className="act act--danger h-8 w-8"
                            title="删除"
                            aria-label={`删除「${s.title}」`}
                            onClick={() => setConfirm(s)}
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </div>
                      )}
                    </div>
                    {hit && !editing && (
                      <div className="mt-1 space-y-0.5 pl-5">
                        {hit.matches.slice(0, 2).map((m) => (
                          <button
                            key={m.messageId}
                            onClick={() => go(s, m.messageId)}
                            title="跳到这条消息"
                            className="block w-full rounded-md px-1.5 py-1 text-left text-xs leading-snug text-muted transition-colors hover:bg-panel hover:text-text active:bg-panel"
                          >
                            <span className="line-clamp-2">
                              <span className="mr-1 text-muted">{m.role === 'user' ? '我:' : 'AI:'}</span>
                              <Highlight text={m.snippet} needle={needle} />
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="删除对话？"
        className="sm:max-w-sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button variant="danger" disabled={del.isPending} onClick={() => confirm && del.mutate(confirm.id)}>
              {del.isPending ? '删除中…' : '删除对话'}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          「<span className="text-text">{confirm?.title}</span>」的消息、记忆与沙盘文件会被永久删除，无法恢复。
        </p>
      </Modal>
    </>
  );
}

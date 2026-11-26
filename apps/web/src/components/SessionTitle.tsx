'use client';
import { useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import type { ListSessionsResponse } from '@chapi/shared';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';

/**
 * The current conversation's name, centered in the top bar. Reads the same
 * session title the history menu shows: a rename there (or an AI-generated
 * title) arrives as `session.updated` and updates the store, so this follows
 * automatically. Renaming here writes the history list's query cache too, so
 * the two always match. An empty name asks the AI for a new one (same as history).
 */
export function SessionTitle() {
  const pathname = usePathname() ?? '';
  const session = useStore((s) => s.session);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Enter/Esc end the edit before the input's blur fires — don't save twice.
  const openRef = useRef(false);

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => api.renameSession(id, title),
    onSuccess: ({ session: updated }) => {
      useStore.setState((s) => ({
        session: s.session?.id === updated.id ? updated : s.session,
        sessions: s.sessions.map((x) => (x.id === updated.id ? updated : x)),
      }));
      qc.setQueryData<ListSessionsResponse>(['sessions'], (old) =>
        old ? { sessions: old.sessions.map((x) => (x.id === updated.id ? updated : x)) } : old,
      );
      if (updated.titleSource === 'auto') {
        setTimeout(() => qc.invalidateQueries({ queryKey: ['sessions'] }), 8000);
      }
    },
  });

  const m = pathname.match(/^\/s\/([^/]+)/);
  const slug = m ? decodeURIComponent(m[1]) : null;
  if (!slug || !session || session.slug !== slug) return null;

  const start = () => {
    setDraft(session.title);
    openRef.current = true;
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
    setEditing(false);
    const next = draft.trim();
    if (save && next !== session.title) rename.mutate({ id: session.id, title: next });
  };

  return (
    <div className="pointer-events-none flex h-14 min-w-0 flex-1 items-center justify-center xl:absolute xl:left-1/2 xl:top-0 xl:w-[min(36vw,560px)] xl:flex-none xl:-translate-x-1/2">
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') {
              e.stopPropagation(); // cancels the rename only (page-level Esc handlers stay out of it)
              finish(false);
            }
          }}
          onBlur={() => finish(true)}
          placeholder="留空 = 让 AI 重新起名"
          aria-label="会话名称"
          autoComplete="off"
          className="field pointer-events-auto h-9 text-center"
        />
      ) : (
        <button
          onClick={start}
          title={`${session.title}（点击重命名，与历史记录同步）`}
          className="act group pointer-events-auto h-9 max-w-full gap-1.5 px-2.5 text-sm font-medium text-text"
        >
          <span className="truncate">{session.title}</span>
          <Pencil size={14} aria-hidden className="text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-md:hidden" />
        </button>
      )}
    </div>
  );
}

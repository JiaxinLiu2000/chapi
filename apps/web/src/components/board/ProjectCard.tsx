'use client';
import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, FolderInput, Loader2, RefreshCw } from 'lucide-react';
import type { ProjectDTO, SessionDTO } from '@chapi/shared';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cn, relativeTime } from '@/lib/utils';
import { formatPTFull } from './ScheduleLabel';

export const UNASSIGNED = 'unassigned';

const toastError = (title: string, e: unknown) =>
  useStore.setState({ toast: { level: 'error', title, body: e instanceof Error ? e.message : String(e), ts: Date.now() } });

/**
 * A project: name, the AI summary, session count and last activity. Opens in
 * place to its sessions, each movable to another project. `project` null = 「未归类」.
 */
export function ProjectCard({
  project,
  unassignedCount = 0,
  projects,
}: {
  project: ProjectDTO | null;
  unassignedCount?: number;
  projects: ProjectDTO[];
}) {
  const qc = useQueryClient();
  const id = project?.id ?? UNASSIGNED;
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const count = project ? project.sessionCount : unassignedCount;
  const sessions = useQuery({
    queryKey: ['board', 'project-sessions', id],
    queryFn: () => api.projectSessions(id),
    enabled: open,
  });

  const refresh = async () => {
    if (!project) return;
    setRefreshing(true);
    try {
      await api.refreshProjectSummary(project.id);
      await qc.invalidateQueries({ queryKey: ['board', 'projects'] });
    } catch (e) {
      toastError('刷新总结失败', e);
    } finally {
      setRefreshing(false);
    }
  };

  const listId = `project-sessions-${id}`;
  return (
    <li className="flex min-w-0 flex-col rounded-xl border border-border bg-panel">
      <div className="flex flex-1 flex-col px-4 pb-2 pt-3">
        <h3 className={cn('line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]', !project && 'text-muted')} title={project?.name}>
          {project ? project.name : '未归类'}
        </h3>
        {project ? (
          project.summary ? (
            <p
              className="mt-1.5 line-clamp-4 text-sm leading-relaxed [overflow-wrap:anywhere]"
              title={project.summaryAt ? `总结于 ${formatPTFull(project.summaryAt)}` : undefined}
            >
              {project.summary}
            </p>
          ) : (
            <p className="mt-1.5 text-sm text-muted">{count > 0 ? '还没有总结，点「刷新总结」生成' : '这个项目还没有会话'}</p>
          )
        ) : (
          <p className="mt-1.5 text-sm text-muted">AI 没能归到任何项目的会话。可以逐个「移到…」某个项目。</p>
        )}
        <p className="mt-auto pt-3 text-2xs text-muted">
          <span className="tabular-nums">{count}</span> 个会话
          {project?.lastActivityAt && (
            <>
              {' '}
              · 最近活动{' '}
              <time dateTime={project.lastActivityAt} title={formatPTFull(project.lastActivityAt)}>
                {relativeTime(project.lastActivityAt)}
              </time>
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-1 px-2 pb-2">
        <button
          type="button"
          className={cn('btn btn--ghost btn--sm', open && 'is-active')}
          aria-expanded={open}
          aria-controls={listId}
          disabled={count === 0}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronRight size={14} aria-hidden className={cn('transition-transform duration-150 ease-ui', open && 'rotate-90')} />
          会话
        </button>
        {project && (
          <button type="button" className="btn btn--ghost btn--sm ml-auto" onClick={refresh} disabled={refreshing || count === 0}>
            {refreshing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
            {refreshing ? '生成中…' : '刷新总结'}
          </button>
        )}
      </div>
      {open && (
        <div id={listId} className="anim-drop border-t border-border">
          {sessions.isLoading && <div className="px-4 py-3 text-xs text-muted" role="status">加载中…</div>}
          {sessions.error && <div className="px-4 py-3 text-xs text-danger">读取失败：{String((sessions.error as Error).message)}</div>}
          {sessions.data && (
            <ul className="scroll-area max-h-72 py-1">
              {sessions.data.sessions.map((s) => (
                <SessionRow key={s.id} s={s} currentId={project?.id ?? null} projects={projects} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function SessionRow({ s, currentId, projects }: { s: SessionDTO; currentId: string | null; projects: ProjectDTO[] }) {
  return (
    <li className="flex min-w-0 items-center gap-2 py-0.5 pl-4 pr-1.5">
      <Link href={`/s/${s.slug}`} className="min-w-0 flex-1 truncate text-sm hover:text-accent" title={s.title}>
        {s.title}
      </Link>
      <time className="shrink-0 text-2xs tabular-nums text-muted" dateTime={s.updatedAt} title={formatPTFull(s.updatedAt)}>
        {relativeTime(s.updatedAt)}
      </time>
      <MoveMenu sessionId={s.id} title={s.title} currentId={currentId} projects={projects} />
    </li>
  );
}

/**
 * 「移到…」: a menu of the other projects (+ 未归类). Positioned `fixed` from the
 * button so the scrolling session list can't clip it; closes on outside click,
 * Esc, scroll or resize.
 */
function MoveMenu({ sessionId, title, currentId, projects }: { sessionId: string; title: string; currentId: string | null; projects: ProjectDTO[] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = 240;
    const up = r.bottom + 280 > window.innerHeight && r.top > 280;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    setPos(up ? { bottom: window.innerHeight - r.top + 4, left } : { top: r.bottom + 4, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        btn.current?.focus();
      }
    };
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // Opening moves focus to the current project's item; ↑/↓/Home/End move (menu pattern).
  useEffect(() => {
    if (!open || !pos) return;
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    (items.find((el) => el.dataset.current === 'true') ?? items[0])?.focus({ preventScroll: true });
  }, [open, pos]);
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown' ? (i + 1) % items.length
      : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    // preventScroll: a focus scroll would reach the page, and any page scroll closes this menu.
    const el = items[next];
    const box = menu.current;
    if (!el || !box) return;
    el.focus({ preventScroll: true });
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
  };

  const move = async (to: ProjectDTO | null) => {
    setOpen(false);
    if ((to?.id ?? null) === currentId) return;
    setBusy(true);
    try {
      await api.setSessionProject(sessionId, to?.id ?? null);
      await qc.invalidateQueries({ queryKey: ['board'] });
      useStore.setState({ toast: { level: 'success', title: `已移到「${to?.name ?? '未归类'}」`, body: title, ts: Date.now() } });
    } catch (e) {
      toastError('移动失败', e);
    } finally {
      setBusy(false);
    }
  };

  const options: (ProjectDTO | null)[] = [...projects, null];
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={cn('act h-8 shrink-0 px-1.5 text-xs', open && 'bg-panel2 text-text')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        title="改归属的项目"
      >
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <FolderInput size={14} aria-hidden />}
        <span className="max-sm:sr-only">移到…</span>
      </button>
      {open && pos && (
        <div
          ref={menu}
          role="menu"
          aria-label="移到项目"
          onKeyDown={onMenuKey}
          className={cn(
            'anim-pop scroll-area fixed z-50 max-h-[280px] w-60 rounded-xl border border-border bg-panel p-1',
            pos.bottom !== undefined ? '[--origin:bottom_right]' : '[--origin:top_right]',
          )}
          style={pos}
        >
          {options.map((p) => {
            const current = (p?.id ?? null) === currentId;
            return (
              <button
                key={p?.id ?? UNASSIGNED}
                type="button"
                role="menuitem"
                data-current={current ? 'true' : undefined}
                onClick={() => move(p)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-panel2 active:bg-panel2',
                  current && 'font-medium',
                  !p && 'text-muted',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{p ? p.name : '未归类'}</span>
                <Check size={14} aria-hidden className={cn('text-accent', current ? 'opacity-100' : 'opacity-0')} />
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

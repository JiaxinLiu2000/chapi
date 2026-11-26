'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import type { BoardSessionCard } from '@chapi/shared';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cn, relativeTime } from '@/lib/utils';
import { formatPTFull } from './ScheduleLabel';

const WAITING_LABEL = { question: '等你回答', approval: '等你审批' } as const;

/**
 * One session on the "today" board. The title is a stretched link (the whole card
 * opens the session); the stale run's 「关闭」 sits above it so it stays clickable.
 */
export function SessionCard({ card }: { card: BoardSessionCard }) {
  const qc = useQueryClient();
  const [closing, setClosing] = useState(false);

  const dismiss = async () => {
    if (!card.automationRunId) return;
    setClosing(true);
    try {
      await api.dismissAutomationRun(card.automationRunId);
      await qc.invalidateQueries({ queryKey: ['board'] });
    } catch (e) {
      useStore.setState({ toast: { level: 'error', title: '关闭失败', body: e instanceof Error ? e.message : String(e), ts: Date.now() } });
      setClosing(false);
    }
  };

  return (
    <li className="group relative rounded-lg border border-border bg-panel px-3 py-2.5 transition-[border-color,transform] duration-150 ease-ui hover:border-text/25 has-[a:active]:scale-[0.99]">
      <div className="flex items-start gap-2">
        {card.state === 'running' && (
          <Loader2 size={14} role="img" aria-label="运行中" className="mt-[3px] shrink-0 animate-spin text-primary" />
        )}
        <Link
          href={`/s/${card.slug}`}
          className="line-clamp-2 min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-accent focus-visible:after:-outline-offset-2"
          title={card.title}
        >
          {card.title}
        </Link>
      </div>
      {card.progress && <p className="mt-1 truncate text-xs text-muted" title={card.progress}>{card.progress}</p>}
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted">
        {card.stale ? (
          <span className="tone tone-amber shrink-0 rounded px-1.5 py-px">已过期，未完成</span>
        ) : card.waitingKind ? (
          <span className="tone tone-amber shrink-0 rounded px-1.5 py-px">{WAITING_LABEL[card.waitingKind]}</span>
        ) : card.state === 'paused' ? (
          <span className="tone tone-neutral shrink-0 rounded px-1.5 py-px">已暂停</span>
        ) : null}
        <span className="min-w-0 truncate">{card.projectName ?? '未归类'}</span>
        <span aria-hidden>·</span>
        <time className="shrink-0 tabular-nums" dateTime={card.updatedAt} title={formatPTFull(card.updatedAt)}>
          {relativeTime(card.updatedAt)}
        </time>
        {card.stale && card.automationRunId && (
          <button
            type="button"
            onClick={dismiss}
            disabled={closing}
            className={cn('act relative z-10 -my-1.5 ml-auto h-8 shrink-0 px-1.5 text-xs', closing && 'opacity-60')}
            title="不再处理这次运行，标记为已结束"
          >
            {closing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <X size={14} aria-hidden />}
            关闭
          </button>
        )}
      </div>
    </li>
  );
}

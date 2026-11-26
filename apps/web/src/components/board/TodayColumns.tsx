'use client';
import { useQuery } from '@tanstack/react-query';
import type { BoardSessionCard } from '@chapi/shared';
import { api } from '@/lib/api';
import { SessionCard } from './SessionCard';

const COLUMNS: { key: 'running' | 'waiting' | 'done'; title: string; empty: string }[] = [
  { key: 'running', title: '运行中', empty: '现在没有在跑的会话' },
  { key: 'waiting', title: '等你处理', empty: '没有等你回答或审批的' },
  { key: 'done', title: '今天已完成', empty: '今天还没有结束的会话' },
];

/** Today's sessions in three columns: side by side from lg, stacked below. */
export function TodayColumns() {
  // Run state isn't a global WS event, so poll lightly on top of the live invalidation.
  const { data, isLoading, error } = useQuery({ queryKey: ['board', 'today'], queryFn: api.boardToday, refetchInterval: 15000 });

  if (isLoading) return <div className="text-sm text-muted" role="status">加载中…</div>;
  if (error) return <div className="text-sm text-danger">读取失败：{String(error instanceof Error ? error.message : error)}</div>;
  if (!data) return null;

  return (
    <div className="grid gap-6 lg:grid-cols-3 lg:gap-4">
      {COLUMNS.map((c) => (
        <Column key={c.key} title={c.title} empty={c.empty} cards={data[c.key]} />
      ))}
    </div>
  );
}

function Column({ title, empty, cards }: { title: string; empty: string; cards: BoardSessionCard[] }) {
  return (
    <section className="flex min-w-0 flex-col" aria-label={title}>
      <h2 className="mb-2 text-xs font-medium text-muted">
        {title} <span className="tabular-nums">· {cards.length}</span>
      </h2>
      {cards.length === 0 ? (
        <p className="rounded-lg bg-panel2/60 px-3 py-4 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="scroll-area -mr-2 space-y-2 pr-2 lg:max-h-[calc(100dvh-17rem)]">
          {cards.map((card) => (
            <SessionCard key={card.id} card={card} />
          ))}
        </ul>
      )}
    </section>
  );
}

'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Link2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Markdown } from '@/components/Markdown';
import { cn, relativeTime } from '@/lib/utils';

export default function WikiPage() {
  const { data, isLoading } = useQuery({ queryKey: ['wiki'], queryFn: api.listWiki });
  const [activeId, setActiveId] = useState<string | null>(null);
  const entries = data?.entries ?? [];
  const current = entries.find((e) => e.id === activeId) ?? entries[0];

  return (
    <main className="mx-auto flex h-[calc(100vh-3.5rem)] max-w-6xl">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-border p-3">
        <div className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold">
          <BookOpen size={16} className="text-accent" /> AI Wiki
        </div>
        {isLoading && <div className="px-1 text-sm text-muted">加载中…</div>}
        {!isLoading && entries.length === 0 && (
          <div className="px-1 text-sm text-muted">
            知识库为空。完成任务并点击「出色完成」后，AI 会把可复用的经验沉淀到这里。
          </div>
        )}
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id}>
              <button
                onClick={() => setActiveId(e.id)}
                className={cn(
                  'w-full rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-panel2',
                  current?.id === e.id && 'bg-panel2',
                )}
              >
                <div className="line-clamp-1">{e.title}</div>
                <div className="text-xs text-muted">{relativeTime(e.updatedAt)}</div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex-1 overflow-y-auto p-6">
        {current ? (
          <article className="mx-auto max-w-2xl">
            <h1 className="mb-1 text-xl font-semibold">{current.title}</h1>
            {current.tags.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                {current.tags.map((t) => (
                  <span key={t} className="rounded-full bg-panel2 px-2 py-0.5 text-xs text-muted">
                    {t}
                  </span>
                ))}
              </div>
            )}
            <Markdown content={current.bodyMd} />
            {current.sourceRefs.length > 0 && (
              <div className="mt-6 border-t border-border pt-3">
                <div className="mb-2 text-xs font-semibold text-muted">来源（可验证）</div>
                <ul className="space-y-1 text-xs">
                  {current.sourceRefs.map((s, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-muted">
                      <Link2 size={12} />
                      <span className="font-mono">{s.kind}</span>
                      <span className="break-all">{s.ref}</span>
                      {s.note && <span className="text-muted/70">— {s.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted">选择左侧条目查看</div>
        )}
      </section>
    </main>
  );
}

'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Link2, Search, Tag } from 'lucide-react';
import { api } from '@/lib/api';
import { Markdown } from '@/components/Markdown';
import { cn, relativeTime } from '@/lib/utils';

export default function WikiPage() {
  const { data, isLoading } = useQuery({ queryKey: ['wiki'], queryFn: api.listWiki });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const entries = data?.entries ?? [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(needle) ||
        e.tags.some((t) => t.toLowerCase().includes(needle)),
    );
  }, [entries, q]);

  const current = filtered.find((e) => e.id === activeId) ?? filtered[0] ?? null;

  return (
    <main className="flex h-[calc(100vh-3.5rem)]">
      {/* sidebar */}
      <aside className="flex w-80 shrink-0 flex-col border-r border-border bg-panel/30">
        <div className="border-b border-border px-4 py-3.5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <BookOpen size={16} className="text-accent" /> AI Wiki
            {entries.length > 0 && (
              <span className="ml-auto rounded-full bg-panel2 px-2 py-0.5 text-xs font-normal text-muted">
                {entries.length}
              </span>
            )}
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted/60" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索标题或标签…"
              className="w-full rounded-lg border border-border bg-panel2 py-2 pl-8 pr-3 text-sm outline-none transition placeholder:text-muted/50 focus:border-accent/60"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {isLoading && <div className="px-1 py-2 text-sm text-muted">加载中…</div>}
          {!isLoading && entries.length === 0 && (
            <div className="px-1 py-2 text-sm leading-relaxed text-muted">
              知识库为空。完成任务并点击「归档」后，AI 会把可复用的经验沉淀到这里。
            </div>
          )}
          {!isLoading && entries.length > 0 && filtered.length === 0 && (
            <div className="px-1 py-2 text-sm text-muted">没有匹配「{q}」的条目。</div>
          )}
          <ul className="space-y-1.5">
            {filtered.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => setActiveId(e.id)}
                  className={cn(
                    'w-full rounded-xl border px-3 py-2.5 text-left transition',
                    current?.id === e.id
                      ? 'border-accent/40 bg-panel2'
                      : 'border-transparent hover:border-border hover:bg-panel2/60',
                  )}
                >
                  <div className="line-clamp-2 text-sm font-medium leading-snug">{e.title}</div>
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-muted/70">
                    <span>{relativeTime(e.updatedAt)}</span>
                    {e.tags.length > 0 && (
                      <span className="flex items-center gap-1 truncate">
                        <Tag size={10} />
                        {e.tags.slice(0, 2).join('、')}
                        {e.tags.length > 2 && ` +${e.tags.length - 2}`}
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* content */}
      <section className="flex-1 overflow-y-auto">
        {current ? (
          <article className="mx-auto max-w-3xl px-10 py-10">
            <h1 className="text-2xl font-bold leading-tight tracking-tight">{current.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>更新于 {relativeTime(current.updatedAt)}</span>
              {current.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-panel2 px-2.5 py-0.5 text-xs font-medium text-muted"
                >
                  {t}
                </span>
              ))}
            </div>

            <div className="mt-7 text-[15px] leading-relaxed">
              <Markdown content={current.bodyMd} />
            </div>

            {current.sourceRefs.length > 0 && (
              <div className="mt-10 rounded-xl border border-border bg-panel/40 p-4">
                <div className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted">
                  来源（可验证）
                </div>
                <ul className="space-y-2 text-xs">
                  {current.sourceRefs.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-muted">
                      <Link2 size={13} className="mt-0.5 shrink-0 text-muted/60" />
                      <span className="shrink-0 rounded bg-panel2 px-1.5 py-0.5 font-mono text-[11px]">
                        {s.kind}
                      </span>
                      <span className="break-all">{s.ref}</span>
                      {s.note && <span className="text-muted/70">— {s.note}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted">
            {isLoading ? '加载中…' : '选择左侧条目查看，或完成任务后让 AI 沉淀经验到这里。'}
          </div>
        )}
      </section>
    </main>
  );
}

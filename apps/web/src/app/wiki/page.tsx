'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, Network, Pencil, Plus, Search, ThumbsDown, ThumbsUp } from 'lucide-react';
import { KNOWLEDGE_KIND_LABEL, type KnowledgeKind, type WikiEntryDTO } from '@chapi/shared';
import { api } from '@/lib/api';
import { KnowledgeDetail, ScoreBadge } from '@/components/KnowledgeDetail';
import { KnowledgeEditor } from '@/components/KnowledgeEditor';
import { KIND_COLORS, nodeColor } from '@/components/WikiGraphCanvas';
import { cn, relativeTime } from '@/lib/utils';
import { useUrlParam } from '@/lib/urlState';

type Filter = 'all' | KnowledgeKind;

export default function WikiPage() {
  const { data, isLoading } = useQuery({ queryKey: ['wiki'], queryFn: api.listWiki });
  // The open entry lives in `?entry=<id>`; an id that isn't in the list falls back to none.
  const [entryParam, setActiveId] = useUrlParam('entry');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [topic, setTopic] = useState('');
  const [editing, setEditing] = useState<WikiEntryDTO | null | 'new'>(null);
  const entries = data?.entries ?? [];
  const activeId = entryParam && entries.some((e) => e.id === entryParam) ? entryParam : null;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries
      .filter((e) => filter === 'all' || e.kind === filter)
      .filter((e) => !topic || e.topics.includes(topic))
      .filter(
        (e) =>
          !needle ||
          e.title.toLowerCase().includes(needle) ||
          e.situation.toLowerCase().includes(needle) ||
          e.solution.toLowerCase().includes(needle) ||
          e.bodyMd.toLowerCase().includes(needle) ||
          e.aliases.some((a) => a.toLowerCase().includes(needle)) ||
          e.tags.some((t) => t.toLowerCase().includes(needle)),
      )
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  }, [entries, q, filter, topic]);

  const topics = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of entries) for (const t of e.topics) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const current = filtered.find((e) => e.id === activeId) ?? filtered[0] ?? null;
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: entries.length };
    for (const e of entries) m[e.kind] = (m[e.kind] ?? 0) + 1;
    return m;
  }, [entries]);

  const openByTitle = (target: string) => {
    const t = target.trim().toLowerCase();
    const hit =
      entries.find((e) => e.title.toLowerCase() === t) ??
      entries.find((e) => e.relPath.toLowerCase().endsWith(`/${t}.md`)) ??
      entries.find((e) => e.aliases.some((a) => a.toLowerCase() === t));
    if (hit) {
      setQ('');
      setFilter('all');
      setActiveId(hit.id);
    }
  };

  return (
    <main id="main" tabIndex={-1} className="flex h-[calc(100dvh-3.5rem)] outline-none">
      {/* phones: the list, or the open entry with a back button (never both squeezed) */}
      <aside
        className={cn(
          'flex w-full shrink-0 flex-col border-r border-border bg-panel md:w-80 lg:w-96',
          activeId && 'max-md:hidden',
        )}
        aria-label="知识点列表"
      >
        <div className="space-y-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <BookOpen size={16} aria-hidden className="text-muted" />
            <h1 className="text-sm font-medium">知识库</h1>
            <span className="text-xs tabular-nums text-muted">{entries.length}</span>
            <button onClick={() => setEditing('new')} className="btn btn--ghost btn--sm ml-auto">
              <Plus size={16} aria-hidden /> 新增知识点
            </button>
            <Link href="/wiki/graph" className="btn btn--ghost btn--sm -mr-2">
              <Network size={16} aria-hidden /> 图谱
            </Link>
          </div>
          <div className="no-scrollbar flex gap-1 overflow-x-auto" role="group" aria-label="按类型筛选">
            {(['all', 'skill', 'preference', 'data'] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={cn(
                  'press flex h-8 shrink-0 items-center [@media(pointer:coarse)]:h-10 gap-1.5 rounded-md px-2.5 text-xs',
                  filter === f ? 'bg-panel2 font-medium text-text' : 'text-muted hover:text-text',
                )}
              >
                {f !== 'all' && <span className="h-2 w-2 rounded-full" aria-hidden style={{ background: KIND_COLORS[f] }} />}
                {f === 'all' ? '全部' : KNOWLEDGE_KIND_LABEL[f]}
                <span className="tabular-nums text-muted">{counts[f] ?? 0}</span>
              </button>
            ))}
          </div>
          <select
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            aria-label="按内容分类筛选"
            className="field h-9 py-0 text-xs"
          >
            <option value="">全部内容分类</option>
            {topics.map(([t, n]) => (
              <option key={t} value={t}>
                {t}（{n}）
              </option>
            ))}
          </select>
          <div className="relative">
            <Search size={16} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="搜索知识点"
              autoComplete="off"
              placeholder="搜索标题、内容、标签或别名…"
              className="field pl-8"
            />
          </div>
        </div>

        <div className="scroll-area min-h-0 flex-1 p-2">
          {isLoading && <div className="px-1 py-2 text-sm text-muted">加载中…</div>}
          {!isLoading && entries.length === 0 && (
            <div className="px-2 py-3 text-sm leading-relaxed text-muted">知识库还是空的。学习代理会在任务推进中自动学习，也可以点「新增知识点」手动添加。</div>
          )}
          {!isLoading && entries.length > 0 && filtered.length === 0 && <div className="px-2 py-3 text-sm text-muted">没有匹配的知识点</div>}
          <ul className="space-y-0.5">
            {filtered.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => setActiveId(e.id)}
                  aria-current={current?.id === e.id ? 'true' : undefined}
                  className={cn(
                    'w-full rounded-lg px-3 py-2.5 text-left transition-colors active:bg-panel2',
                    current?.id === e.id ? 'bg-panel2' : 'hover:bg-panel2/60',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" aria-hidden style={{ background: nodeColor(e.kind, e.polarity) }} />
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-sm font-medium leading-snug">{e.title}</div>
                      <div className="mt-1 flex min-w-0 items-center gap-2 text-2xs text-muted">
                        <span className="shrink-0 tabular-nums">
                          {e.kind === 'data' ? '置信度' : '权重'} <span className="text-text/80">{e.score}</span>
                        </span>
                        {e.kind === 'preference' &&
                          (e.polarity === 'negative' ? (
                            <ThumbsDown size={12} role="img" aria-label="负面偏好" className="text-danger" />
                          ) : (
                            <ThumbsUp size={12} role="img" aria-label="正面偏好" className="text-success" />
                          ))}
                        {e.topics[0] && <span className="min-w-0 truncate">{e.topics.join(' · ')}</span>}
                        <span className="shrink-0">{relativeTime(e.updatedAt)}</span>
                        {e.tags.length > 0 && <span className="truncate">#{e.tags.slice(0, 2).join(' #')}</span>}
                      </div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <section className={cn('scroll-area min-w-0 flex-1', !activeId && 'max-md:hidden')}>
        {current ? (
          <article className="anim-fade mx-auto max-w-3xl px-4 py-5 sm:px-8 sm:py-8 xl:px-10 xl:py-10" key={current.id}>
            <button onClick={() => setActiveId(null)} className="btn btn--ghost btn--sm -ml-2 mb-3 md:hidden">
              <ArrowLeft size={16} aria-hidden /> 返回列表
            </button>
            <div className="flex items-start gap-3">
              <h2 className="min-w-0 flex-1 text-lg font-medium leading-tight sm:text-xl">{current.title}</h2>
              <button onClick={() => setEditing(current)} className="btn btn--secondary btn--sm shrink-0">
                <Pencil size={14} aria-hidden /> 编辑
              </button>
            </div>
            <div className="mb-6 mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
              <ScoreBadge e={current} />
              <span>更新于 {relativeTime(current.updatedAt)}</span>
              {current.relPath && <span className="min-w-0 break-all font-mono text-2xs text-muted">{current.relPath}</span>}
            </div>
            <KnowledgeDetail entry={current} onOpenTitle={openByTitle} />
          </article>
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-muted">{isLoading ? '加载中…' : '选择左侧的知识点查看'}</div>
        )}
      </section>

      <KnowledgeEditor
        knownTopics={topics.map(([t]) => t)}
        open={editing !== null}
        entry={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(e) => setActiveId(e.id)}
        onDeleted={() => setActiveId(null)}
      />
    </main>
  );
}

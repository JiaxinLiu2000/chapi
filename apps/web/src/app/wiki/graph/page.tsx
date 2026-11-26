'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, List, Network, Pencil, Plus, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { KNOWLEDGE_KIND_LABEL, type KnowledgeKind, type WikiEntryDTO } from '@chapi/shared';
import { api } from '@/lib/api';
import { KnowledgeDetail, ScoreBadge } from '@/components/KnowledgeDetail';
import { KnowledgeEditor } from '@/components/KnowledgeEditor';
import { KIND_COLORS, NEGATIVE_COLOR, WikiGraphCanvas } from '@/components/WikiGraphCanvas';
import { cn, relativeTime } from '@/lib/utils';
import { readQuery, replaceQuery } from '@/lib/urlState';

/** Obsidian deep link to a note file (opens it if the vault is registered in Obsidian). */
function obsidianUrl(vaultPath: string, relPath: string): string {
  const abs = `${vaultPath.replace(/[\\/]+$/, '')}/${relPath}`.replace(/\\/g, '/');
  return `obsidian://open?path=${encodeURIComponent(abs)}`;
}

const KINDS: KnowledgeKind[] = ['skill', 'preference', 'data'];

export default function WikiGraphPage() {
  const qc = useQueryClient();
  const { data: graph, isLoading } = useQuery({ queryKey: ['wiki-graph'], queryFn: api.wikiGraph });
  const { data: list } = useQuery({ queryKey: ['wiki'], queryFn: api.listWiki });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [topicFilter, setTopicFilter] = useState<Set<string>>(new Set()); // empty = all categories
  const [tagFilter, setTagFilter] = useState('');
  const [negativeOnly, setNegativeOnly] = useState(false);
  const [q, setQ] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<WikiEntryDTO | null | 'new'>(null);

  // Filters live in the URL: ?hide=skill,data &topics=a,b &tag=x &neg=1 (read after mount,
  // written on every change; unknown kinds/categories are dropped).
  const [urlReady, setUrlReady] = useState(false);
  useEffect(() => {
    const split = (k: string) => (readQuery(k) ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    setHiddenKinds(new Set(split('hide').filter((k) => (KINDS as string[]).includes(k))));
    setTopicFilter(new Set(split('topics')));
    setTagFilter(readQuery('tag') ?? '');
    setNegativeOnly(readQuery('neg') === '1');
    setUrlReady(true);
  }, []);
  useEffect(() => {
    if (!urlReady) return;
    replaceQuery({
      hide: [...hiddenKinds].join(','),
      topics: [...topicFilter].join(','),
      tag: tagFilter.trim(),
      neg: negativeOnly ? '1' : null,
    });
  }, [urlReady, hiddenKinds, topicFilter, tagFilter, negativeOnly]);
  // A category from the URL that the graph doesn't have would show nothing: drop it.
  useEffect(() => {
    if (!graph) return;
    const known = new Set([...graph.topics.map((t) => t.name), '未分类']);
    setTopicFilter((cur) => ([...cur].every((t) => known.has(t)) ? cur : new Set([...cur].filter((t) => known.has(t)))));
  }, [graph]);

  const entries = list?.entries ?? [];
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const nodes = graph?.nodes ?? [];

  const highlight = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return null;
    return new Set(
      entries
        .filter(
          (e) =>
            e.title.toLowerCase().includes(needle) ||
            e.tags.some((t) => t.toLowerCase().includes(needle)) ||
            e.aliases.some((a) => a.toLowerCase().includes(needle)) ||
            e.situation.toLowerCase().includes(needle) ||
            e.solution.toLowerCase().includes(needle),
        )
        .map((e) => e.id),
    );
  }, [q, entries]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1);
    return m;
  }, [nodes]);

  const allTags = useMemo(() => [...new Set(nodes.flatMap((n) => n.tags))].sort(), [nodes]);

  // Filters → the ids to show (null = everything). Category first, then tag, then kind.
  const shown = useMemo(() => {
    const tag = tagFilter.trim().toLowerCase();
    if (!topicFilter.size && !tag && !hiddenKinds.size && !negativeOnly) return null;
    return new Set(
      nodes
        .filter((n) => !topicFilter.size || (n.topics.length ? n.topics : ['未分类']).some((t) => topicFilter.has(t)))
        .filter((n) => !tag || n.tags.some((t) => t.toLowerCase() === tag) || n.topics.some((t) => t.toLowerCase() === tag))
        .filter((n) => !hiddenKinds.has(n.kind))
        .filter((n) => !negativeOnly || (n.kind === 'preference' && n.polarity === 'negative'))
        .map((n) => n.id),
    );
  }, [nodes, topicFilter, tagFilter, hiddenKinds, negativeOnly]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const linkInfo = useMemo(() => {
    if (!graph || !selectedId) return { outgoing: [], incoming: [] };
    const node = (id: string) => nodes.find((n) => n.id === id);
    const pick = (ids: string[]) =>
      ids.map(node).filter((n): n is NonNullable<typeof n> => Boolean(n)).map((n) => ({ id: n.id, title: n.title, kind: n.kind }));
    return {
      outgoing: pick(graph.links.filter((l) => l.source === selectedId).map((l) => l.target)),
      incoming: pick(graph.links.filter((l) => l.target === selectedId).map((l) => l.source)),
    };
  }, [graph, selectedId, nodes]);

  const openByTitle = (target: string) => {
    const t = target.trim().toLowerCase();
    const hit =
      entries.find((e) => e.title.toLowerCase() === t) ??
      entries.find((e) => e.relPath.toLowerCase().endsWith(`/${t}.md`)) ??
      entries.find((e) => e.aliases.some((a) => a.toLowerCase() === t));
    if (hit) setSelectedId(hit.id);
  };

  const sync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await api.wikiSync();
      setSyncMsg(
        r.created || r.updated || r.deleted || r.exported
          ? `已同步：新增 ${r.created} · 更新 ${r.updated} · 删除 ${r.deleted} · 导出 ${r.exported}`
          : '已是最新',
      );
      await Promise.all([qc.invalidateQueries({ queryKey: ['wiki-graph'] }), qc.invalidateQueries({ queryKey: ['wiki'] })]);
    } catch (e) {
      setSyncMsg(`同步失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const flip = (set: (f: (h: Set<string>) => Set<string>) => void, c: string) =>
    set((h) => {
      const next = new Set(h);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Esc closes the open detail (and the filter sheet on small screens).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing !== null) return;
      if (filtersOpen) setFiltersOpen(false);
      else setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtersOpen, editing]);
  const filtering = shown !== null;
  const clearFilters = () => {
    setTopicFilter(new Set());
    setTagFilter('');
    setHiddenKinds(new Set());
    setNegativeOnly(false);
  };

  // Floating controls sit on opaque surfaces (no glass) so they read over the graph.
  const btn = 'btn btn--secondary btn--sm';

  return (
    <main id="main" tabIndex={-1} className="flex h-[calc(100dvh-3.5rem)] outline-none">
      <section className="relative min-w-0 flex-1 overflow-hidden bg-bg">
        <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-center gap-2 [&>*]:pointer-events-auto">
          <div className="flex h-9 items-center gap-2 rounded-lg border border-border bg-panel px-3">
            <Network size={16} aria-hidden className="text-muted" />
            <h1 className="text-sm font-medium">知识图谱</h1>
            <span className="text-xs tabular-nums text-muted max-sm:hidden">
              {nodes.length} 个知识点 · {graph?.links.length ?? 0} 条链接
            </span>
          </div>
          <button
            className={cn(btn, 'lg:hidden', filtersOpen && 'bg-panel2 text-text')}
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            aria-controls="graph-filters"
          >
            <SlidersHorizontal size={16} aria-hidden /> 筛选{filtering ? ' ·' : ''}
          </button>
          <div className="relative order-last w-full basis-full sm:order-none sm:w-64 sm:basis-auto">
            <Search size={16} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="搜索知识点"
              autoComplete="off"
              placeholder="搜索标题、标签、内容…"
              className="field h-9 py-0 pl-8"
            />
          </div>
          {highlight && (
            <span className="rounded-md bg-panel px-2 py-1 text-xs tabular-nums text-muted" role="status">
              命中 {highlight.size} 个
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {syncMsg && (
              <span className="rounded-md bg-panel px-2 py-1 text-xs text-muted max-md:hidden" role="status">
                {syncMsg}
              </span>
            )}
            <button onClick={() => setEditing('new')} className={btn} aria-label="新增知识点">
              <Plus size={16} aria-hidden /> <span className="max-md:hidden">新增知识点</span>
            </button>
            <button
              onClick={sync}
              disabled={syncing}
              title="把在 Obsidian 里的修改同步进 Chapi（平时保存后会自动同步）"
              className={btn}
              aria-label="同步 Obsidian"
            >
              <RefreshCw size={16} aria-hidden className={cn(syncing && 'animate-spin')} />{' '}
              <span className="max-md:hidden">同步 Obsidian</span>
            </button>
            <Link href="/wiki" className={btn} aria-label="列表">
              <List size={16} aria-hidden /> <span className="max-md:hidden">列表</span>
            </Link>
          </div>
        </div>

        <div
          id="graph-filters"
          className={cn(
            'absolute bottom-3 left-3 top-[104px] z-10 w-[min(18rem,calc(100%-1.5rem))] flex-col rounded-xl border border-border bg-panel p-3 text-xs sm:top-[60px]',
            filtersOpen ? 'anim-pop flex [--origin:top_left]' : 'hidden lg:flex',
          )}
        >
          <div className="mb-2 flex h-8 items-center gap-2">
            <span className="label">内容分类（点选只看这些）</span>
            {filtering && (
              <button onClick={clearFilters} className="act -mr-1.5 ml-auto h-8 px-1.5 text-accent">
                显示全部
              </button>
            )}
          </div>
          <ul className="scroll-area min-h-0 flex-1 space-y-0.5">
            {(graph?.topics ?? []).map((t) => (
              <li key={t.name}>
                <button
                  onClick={() => flip(setTopicFilter, t.name)}
                  aria-pressed={topicFilter.has(t.name)}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-panel2 active:bg-panel2',
                    topicFilter.has(t.name) && 'bg-accent/10 font-medium text-text',
                    topicFilter.size > 0 && !topicFilter.has(t.name) && 'text-muted',
                  )}
                >
                  <span className="min-w-0 truncate">{t.name}</span>
                  <span className="ml-auto tabular-nums text-muted">{t.count}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-border pt-2">
            <input
              list="graph-tags"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder="按标签筛选…"
              aria-label="按标签筛选"
              autoComplete="off"
              className="field h-8 px-2 py-0 text-xs"
            />
            <datalist id="graph-tags">
              {allTags.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </div>
          <div className="mt-2 border-t border-border pt-2">
            <div className="label mb-1">类型（点击隐藏或显示）</div>
            {KINDS.map((k) => (
              <button
                key={k}
                onClick={() => flip(setHiddenKinds, k)}
                aria-pressed={!hiddenKinds.has(k)}
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left transition-[background-color,opacity] hover:bg-panel2 active:bg-panel2',
                  hiddenKinds.has(k) && 'opacity-40',
                )}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" aria-hidden style={{ background: KIND_COLORS[k] }} />
                <span>{KNOWLEDGE_KIND_LABEL[k]}</span>
                <span className="text-muted">{k === 'data' ? '大小 = 置信度' : '大小 = 权重'}</span>
                <span className="ml-auto tabular-nums text-muted">{counts.get(k) ?? 0}</span>
              </button>
            ))}
            <button
              onClick={() => setNegativeOnly((v) => !v)}
              aria-pressed={negativeOnly}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-panel2 active:bg-panel2',
                negativeOnly && 'bg-danger/10 font-medium text-text',
              )}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" aria-hidden style={{ background: NEGATIVE_COLOR }} />
              <span>负面偏好（不要这样做）</span>
              <span className="ml-auto tabular-nums text-muted">{negativeOnly ? '只看这些' : nodes.filter((n) => n.polarity === 'negative').length}</span>
            </button>
          </div>
          <div className="mt-2 border-t border-border pt-2 text-2xs leading-relaxed text-muted">
            先按内容分类聚拢，再按类型；节点越大权重/置信度越高。拖动节点 · 拖空白平移 · 滚轮缩放 · 点击查看
          </div>
        </div>

        {isLoading && <div className="grid h-full place-items-center text-sm text-muted">加载中…</div>}
        {!isLoading && nodes.length === 0 && <div className="grid h-full place-items-center text-sm text-muted">知识库还是空的</div>}
        {graph && nodes.length > 0 && (
          <WikiGraphCanvas graph={graph} shown={shown} highlight={highlight} selectedId={selectedId} onSelect={setSelectedId} />
        )}
      </section>

      {selected && (
        <aside
          key={selected.id}
          aria-label="知识点详情"
          className="anim-sheet-right fixed inset-0 top-14 z-30 flex flex-col bg-panel md:static md:z-auto md:w-[400px] md:shrink-0 md:animate-none md:border-l md:border-border xl:w-[440px]"
        >
          <div className="flex items-start gap-1 border-b border-border py-3 pl-5 pr-2">
            <div className="min-w-0 flex-1 pt-1">
              <h2 className="text-[15px] font-medium leading-snug sm:text-base">{selected.title}</h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                <ScoreBadge e={selected} />
                <span>更新于 {relativeTime(selected.updatedAt)}</span>
              </div>
            </div>
            <button onClick={() => setEditing(selected)} className="btn btn--ghost btn--icon btn--sm" title="编辑或删除" aria-label="编辑或删除">
              <Pencil size={16} aria-hidden />
            </button>
            <button onClick={() => setSelectedId(null)} className="btn btn--ghost btn--icon btn--sm" title="关闭" aria-label="关闭详情">
              <X size={16} aria-hidden />
            </button>
          </div>
          <div className="scroll-area min-h-0 flex-1 px-5 py-4">
            <KnowledgeDetail entry={selected} onOpenTitle={openByTitle} links={{ ...linkInfo, onOpen: setSelectedId }} />
          </div>
          {graph && selected.relPath && (
            <div className="pb-safe border-t border-border px-3 pt-2 md:pb-2">
              <a
                href={obsidianUrl(graph.vaultPath, selected.relPath)}
                className="act h-9 w-full justify-start gap-1.5 px-2 text-xs"
                title={`${graph.vaultPath}/${selected.relPath}`}
              >
                <ExternalLink size={14} aria-hidden />
                <span className="shrink-0 whitespace-nowrap">在 Obsidian 中打开</span>
                <span className="min-w-0 truncate font-mono text-2xs text-muted">{selected.relPath}</span>
              </a>
            </div>
          )}
        </aside>
      )}

      <KnowledgeEditor
        knownTopics={(graph?.topics ?? []).map((t) => t.name)}
        open={editing !== null}
        entry={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(e) => setSelectedId(e.id)}
        onDeleted={() => setSelectedId(null)}
      />
    </main>
  );
}

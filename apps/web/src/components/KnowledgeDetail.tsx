'use client';
import { Link2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { KNOWLEDGE_KIND_LABEL, KNOWLEDGE_SECTION_LABEL, type KnowledgeKind, type WikiEntryDTO } from '@chapi/shared';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';
import { KIND_COLORS, nodeColor } from './WikiGraphCanvas';

/** Change-history stamps in local time (the raw ISO string is UTC). */
const historyTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function ScoreBadge({ e }: { e: Pick<WikiEntryDTO, 'kind' | 'score' | 'polarity' | 'topics'> }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {e.topics.map((t) => (
        <span key={t} className="rounded-full bg-panel2 px-2 py-0.5 text-2xs font-medium text-text">
          {t}
        </span>
      ))}
      <span className="rounded-full px-2 py-0.5 text-2xs font-medium text-bg" style={{ background: nodeColor(e.kind, e.polarity) }}>
        {KNOWLEDGE_KIND_LABEL[e.kind]}
      </span>
      <span className="text-2xs text-muted">
        {e.kind === 'data' ? '置信度' : '权重'} <span className="font-medium tabular-nums text-text">{e.score}</span>
      </span>
      {e.kind === 'preference' && (
        <span className={cn('flex items-center gap-1 text-2xs', e.polarity === 'negative' ? 'text-danger' : 'text-success')}>
          {e.polarity === 'negative' ? <ThumbsDown size={12} aria-hidden /> : <ThumbsUp size={12} aria-hidden />}
          {e.polarity === 'negative' ? '避免' : '期望'}
        </span>
      )}
    </span>
  );
}

/** Full view of one knowledge point (used by the graph panel and the list page). */
export function KnowledgeDetail({
  entry,
  onOpenTitle,
  links,
}: {
  entry: WikiEntryDTO;
  onOpenTitle: (t: string) => void;
  links?: { outgoing: Array<{ id: string; title: string; kind: KnowledgeKind }>; incoming: Array<{ id: string; title: string; kind: KnowledgeKind }>; onOpen: (id: string) => void };
}) {
  const [l1, l2] = KNOWLEDGE_SECTION_LABEL[entry.kind];
  return (
    <div className="text-sm">
      {entry.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {entry.tags.map((t) => (
            <span key={t} className="rounded-full bg-panel2 px-2 py-0.5 text-2xs text-muted">
              #{t}
            </span>
          ))}
        </div>
      )}
      {entry.aliases.length > 0 && (
        <div className="mb-3 text-xs text-muted">
          <span className="font-medium">别名/问法：</span>
          {entry.aliases.join(' · ')}
        </div>
      )}
      <div className="space-y-3">
        <section className="rounded-xl border border-border p-4">
          <div className="mb-1.5 text-xs font-medium text-muted">{l1}</div>
          <Markdown content={entry.situation || '（未填写）'} onWikiLink={onOpenTitle} />
        </section>
        <section className="rounded-xl border border-l-[3px] border-border border-l-accent p-4">
          <div className="mb-1.5 text-xs font-medium text-accent">
            {l2}
            {entry.kind === 'data' && entry.observedAt && <span className="ml-2 font-normal tabular-nums text-muted">数据时间 {entry.observedAt.slice(0, 10)}</span>}
          </div>
          <Markdown content={entry.solution || '（未填写）'} onWikiLink={onOpenTitle} />
        </section>
        {entry.bodyMd && (
          <section className="px-1">
            <Markdown content={entry.bodyMd} onWikiLink={onOpenTitle} />
          </section>
        )}
      </div>

      {links && (links.outgoing.length > 0 || links.incoming.length > 0) && (
        <div className="mt-5 grid gap-3 text-xs">
          {[
            { label: '链接到', items: links.outgoing },
            { label: '反向链接', items: links.incoming },
          ].map(
            (g) =>
              g.items.length > 0 && (
                <div key={g.label}>
                  <div className="mb-1.5 font-medium text-muted">
                    {g.label}（{g.items.length}）
                  </div>
                  <ul className="space-y-1">
                    {g.items.map((n) => (
                      <li key={n.id}>
                        <button onClick={() => links.onOpen(n.id)} className="act -mx-1.5 min-h-8 justify-start px-1.5 py-1 text-left text-accent hover:text-accent">
                          <span className="h-2 w-2 shrink-0 rounded-full" aria-hidden style={{ background: KIND_COLORS[n.kind] }} />
                          {n.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
          )}
        </div>
      )}

      {entry.sourceRefs.length > 0 && (
        <div className="mt-5 rounded-xl border border-border p-4">
          <div className="mb-2 text-xs font-medium text-muted">来源（可验证）</div>
          <ul className="space-y-1.5 text-xs">
            {entry.sourceRefs.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-muted">
                <Link2 size={14} aria-hidden className="mt-0.5 text-muted" />
                <span className="shrink-0 rounded bg-panel2 px-1.5 py-0.5 font-mono text-2xs">{s.tier ?? s.kind}</span>
                {/^https?:/.test(s.ref) ? (
                  <a href={s.ref} target="_blank" rel="noreferrer" className="break-all text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent">
                    {s.note || s.ref}
                  </a>
                ) : (
                  <span className="break-all">{s.ref}</span>
                )}
                {s.date && <span className="shrink-0 tabular-nums">{s.date}</span>}
                {typeof s.confidence === 'number' && <span className="shrink-0">· {s.confidence}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {entry.history.length > 0 && (
        <details className="mt-4 text-xs text-muted">
          <summary className="cursor-pointer select-none rounded-md py-1 transition-colors hover:text-text">变更历史（{entry.history.length}）</summary>
          <ul className="anim-drop mt-2 space-y-1">
            {[...entry.history].reverse().map((h, i) => (
              <li key={i}>
                <time className="font-mono text-2xs tabular-nums" dateTime={h.at}>
                  {historyTime.format(new Date(h.at))}
                </time> · {h.op}
                {h.delta ? ` ${h.delta > 0 ? '+' : ''}${h.delta}` : ''}
                {typeof h.score === 'number' ? ` → ${h.score}` : ''}
                {h.note ? ` · ${h.note}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

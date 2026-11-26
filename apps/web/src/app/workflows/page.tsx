'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, CircleCheck, FilePen, Workflow } from 'lucide-react';
import type { WorkflowDetailDTO, WorkflowNodeDef, WorkflowSummaryDTO } from '@chapi/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * SOP catalog. Each SOP opens to its stages in full: sub-steps, memory mode, done
 * criteria, evidence fields, inputs/outputs and the SOP text itself. A pending draft
 * is flagged on the list, with what it changes; only the user confirms it.
 */
export default function WorkflowsPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['workflows'], queryFn: api.listWorkflows });
  const list = data ?? [];
  const needsYou = list.filter((w) => w.status === 'draft' || w.pendingDraftVersion);
  const rest = list.filter((w) => !needsYou.includes(w));

  return (
    <main id="main" tabIndex={-1} className="page-scroll outline-none mx-auto w-full max-w-4xl px-4 py-6">
      <div className="mb-1 flex items-center gap-2">
        <Workflow size={18} aria-hidden className="text-muted" />
        <h1 className="text-base font-medium">SOP 工作流</h1>
      </div>
      <p className="mb-6 text-sm text-muted">
        已确认的 SOP 会出现在 AI 的目录里，请求对得上时会按 SOP 逐阶段执行。AI 可以起草和修改（也可以在对话里让主 AI 改），确认必须由你来点。
      </p>
      {isLoading && <div className="text-sm text-muted" role="status">加载中…</div>}
      {error && <div className="text-sm text-danger">读取失败：{String(error)}</div>}
      {!isLoading && !list.length && <div className="text-sm text-muted">还没有 SOP</div>}
      {needsYou.length > 0 && <Section title="待你确认" items={needsYou} />}
      {rest.length > 0 && <Section title="已确认" items={rest} />}
    </main>
  );
}

function Section({ title, items }: { title: string; items: WorkflowSummaryDTO[] }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-xs font-medium text-muted">
        {title} <span className="tabular-nums">· {items.length}</span>
      </h2>
      <ul className="space-y-2">
        {items.map((w) => (
          <WorkflowCard key={w.id} w={w} />
        ))}
      </ul>
    </section>
  );
}

function WorkflowCard({ w }: { w: WorkflowSummaryDTO }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['workflow', w.slug], queryFn: () => api.getWorkflow(w.slug), enabled: open });
  const d = detail.data;
  const draft = d?.versions.filter((v) => v.state === 'draft').at(-1);
  const confirmed = d?.versions.find((v) => v.version === w.confirmedVersion);
  const [view, setView] = useState<'draft' | 'confirmed'>('draft');
  const shown = view === 'draft' ? (draft ?? confirmed) : (confirmed ?? draft);
  const stages = shown?.graph.nodes.filter((n) => n.type === 'step') ?? [];

  const confirm = async (detailNow: WorkflowDetailDTO) => {
    const v = detailNow.versions.filter((x) => x.state === 'draft').at(-1);
    if (!v) return;
    if (!window.confirm(`确认「${w.name}」v${v.version}？确认后 AI 就按这个版本执行。`)) return;
    setBusy(true);
    setErr(null);
    try {
      await api.confirmWorkflow(w.slug);
      await qc.invalidateQueries({ queryKey: ['workflows'] });
      await qc.invalidateQueries({ queryKey: ['workflow', w.slug] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors duration-150 ease-ui hover:bg-panel2/50 active:bg-panel2',
          open ? 'rounded-t-[11px]' : 'rounded-[11px]', // inside the card's 1px border
        )}
      >
        <ChevronRight size={16} className={cn('mt-0.5 shrink-0 text-muted transition-transform duration-150 ease-ui', open && 'rotate-90')} aria-hidden />
        {w.status === 'confirmed' ? (
          <CircleCheck size={16} className="mt-0.5 shrink-0 text-success" role="img" aria-label="已确认" />
        ) : (
          <FilePen size={16} className="mt-0.5 shrink-0 text-warn" role="img" aria-label="草稿" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
            {w.name}
            {w.confirmedVersion ? <span className="text-xs font-normal text-muted">已确认 v{w.confirmedVersion}</span> : <Badge tone="warn">草稿</Badge>}
            {w.pendingDraftVersion && <Badge tone="warn">v{w.pendingDraftVersion} 待确认</Badge>}
          </span>
          {w.whenToUse && <span className="mt-0.5 block text-pretty text-xs text-muted">何时用：{w.whenToUse}</span>}
          {w.aliases.length > 0 && <span className="mt-0.5 block text-pretty text-xs text-muted">对话里这样说会触发：{w.aliases.join(' / ')}</span>}
        </span>
      </button>

      {open && (
        <div className="anim-drop border-t border-border px-3 py-3 text-sm">
          {detail.isLoading && <div className="text-xs text-muted">加载中…</div>}
          {d && (
            <>
              {draft && confirmed && (
                <div className="mb-3 flex items-center gap-1 text-xs" role="group" aria-label="查看版本">
                  <ViewTab on={view === 'draft'} onClick={() => setView('draft')}>草稿 v{draft.version}（待确认）</ViewTab>
                  <ViewTab on={view === 'confirmed'} onClick={() => setView('confirmed')}>已确认 v{confirmed.version}（正在使用）</ViewTab>
                </div>
              )}
              {draft && d.pendingChanges && d.pendingChanges.length > 0 && (
                <div className="mb-3 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-xs">
                  <div className="mb-1 font-medium">草稿 v{draft.version} 相对正在使用的版本改了：</div>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {d.pendingChanges.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  {draft.note && <div className="mt-1 text-muted">说明：{draft.note}</div>}
                </div>
              )}
              <div className="mb-2 text-xs text-muted">
                {shown?.state === 'draft' ? `草稿 v${shown.version}` : `v${shown?.version}`} · {stages.length} 个阶段 ·{' '}
                {stages.reduce((s, n) => s + (n.substeps?.length ?? 0), 0)} 个子步骤
                {d.sourceRef && <> · 来源：{d.sourceRef}</>}
              </div>
              <ol className="space-y-2">
                {stages.map((s, i) => (
                  <StageCard key={s.id} n={s} index={i + 1} />
                ))}
              </ol>
              {draft && (
                <div className="mt-3 flex items-center gap-3">
                  <button type="button" disabled={busy} onClick={() => confirm(d)} className={cn('btn btn--primary btn--sm', busy && 'opacity-60')}>
                    {busy ? '确认中…' : `确认 v${draft.version}`}
                  </button>
                  <span className="text-pretty text-xs text-muted">确认后 AI 按这个版本执行；也可以在对话里让主 AI 继续改。</span>
                </div>
              )}
              {err && <div className="mt-2 text-xs text-danger">确认失败：{err}</div>}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function StageCard({ n, index }: { n: WorkflowNodeDef; index: number }) {
  const body = (n.instructions ?? '').split('【本阶段】\n')[1]?.split('\n\n【')[0] ?? n.instructions ?? '';
  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="tabular-nums text-muted">{index}.</span>
        <span className="font-medium">{n.title}</span>
        <Badge tone={n.memory === 'none' ? 'muted' : 'accent'}>{n.memory === 'none' ? '纯工具 · 不用记忆' : '只带工具用法'}</Badge>
        <span className="ml-auto text-2xs text-muted">id: {n.id}</span>
      </div>
      {n.substeps && n.substeps.length > 0 && (
        <Block title="子步骤">
          <ol className="space-y-0.5">
            {n.substeps.map((s, j) => (
              <li key={s.id} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-muted">
                  {index}.{j + 1}
                </span>
                <span>{s.title}</span>
              </li>
            ))}
          </ol>
        </Block>
      )}
      <Block title="完成标准（主 AI 逐条审核）">
        <ol className="list-decimal space-y-0.5 pl-4">
          {(n.doneCriteria ?? []).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
      </Block>
      <Block title="副 AI 必须提交的证据">
        <ul className="space-y-0.5">
          {(n.evidence ?? []).map((f) => (
            <li key={f.key}>
              <code className="text-xs">{f.key}</code>
              <span className="text-xs text-muted">
                {' '}
                · {f.type}
                {f.required === false ? ' · 可选' : ''}
                {f.saveAs ? ` · 存为 ${f.saveAs}` : ''}
              </span>
              {f.desc && <span className="text-xs"> — {f.desc}</span>}
            </li>
          ))}
        </ul>
      </Block>
      {(n.inputs?.length || n.outputs?.length) && (
        <Block title="输入 / 输出">
          {n.inputs?.map((x) => (
            <div key={`i-${x.name}`} className="text-xs">
              输入：{x.name}
              {x.from ? `（来自 ${x.from}）` : ''}
              {x.desc ? ` — ${x.desc}` : ''}
            </div>
          ))}
          {n.outputs?.map((x) => (
            <div key={`o-${x.name}`} className="text-xs">
              输出：{x.name}
              {x.file ? ` → ${x.file}` : ''}
              {x.desc ? ` — ${x.desc}` : ''}
            </div>
          ))}
        </Block>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted">SOP 原文（本阶段）</summary>
        <pre className="mt-1 whitespace-pre-wrap rounded bg-panel2 p-2 font-sans text-xs leading-relaxed">{body}</pre>
        {n.instructions && n.instructions !== body && (
          <details className="mt-1">
            <summary className="cursor-pointer text-2xs text-muted">副 AI 实际收到的完整说明（含表格与数据源、统一口径）</summary>
            <pre className="mt-1 whitespace-pre-wrap rounded bg-panel2 p-2 font-sans text-2xs leading-relaxed">{n.instructions}</pre>
          </details>
        )}
      </details>
    </li>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <div className="mb-0.5 text-2xs font-medium text-muted">{title}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'warn' | 'accent' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-2xs font-normal',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'accent' && 'bg-accent/10 text-accent',
        tone === 'muted' && 'bg-panel2 text-muted',
      )}
    >
      {children}
    </span>
  );
}

function ViewTab({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={cn('press h-8 rounded-md border px-2', on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-muted hover:text-text')}>
      {children}
    </button>
  );
}

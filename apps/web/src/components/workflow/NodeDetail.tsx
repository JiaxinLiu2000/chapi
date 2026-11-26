'use client';
import { CircleCheck, CircleDashed, CircleMinus, X } from 'lucide-react';
import type { WorkflowRunDTO } from '@chapi/shared';
import { cn } from '@/lib/utils';
import { StageIcon, inferIcon } from './icons';
import { STATUS_LABEL, nodeRunOf, runSteps, shortTitle, toneOf } from './model';

/** One stage, everything needed to review it: sub-steps, evidence, the main AI's verdicts. */
export function NodeDetail({ run, nodeId, onClose }: { run: WorkflowRunDTO; nodeId: string; onClose: () => void }) {
  const steps = runSteps(run);
  const idx = steps.findIndex((n) => n.id === nodeId);
  const node = steps[idx];
  const nr = nodeRunOf(run, nodeId);
  if (!node) return null;
  const tone = toneOf(nr?.status);
  const pct = nr?.progress ?? 0;
  const evidence = Object.entries(nr?.evidence ?? {});
  return (
    <aside className="flex h-full w-full flex-col bg-panel" aria-label={`阶段详情：${node.title}`}>
      <header className="flex items-start gap-3 px-4 pb-3 pt-4">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-panel2">
          <StageIcon iconKey={inferIcon(node)} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">
            {run.workflowName} · 第 {idx + 1}/{steps.length} 阶段
          </div>
          <h3 className="text-sm font-medium leading-snug">{shortTitle(node.title)}</h3>
          <div
            className={cn(
              'mt-0.5 text-xs',
              tone === 'active' ? 'text-accent' : tone === 'done' ? 'text-success' : tone === 'review' ? 'text-warn' : tone === 'problem' ? 'text-danger' : 'text-muted',
            )}
          >
            {STATUS_LABEL[nr?.status ?? 'pending']}
            {nr && nr.attempts > 1 ? ` · 第 ${nr.attempts} 次执行` : ''} · {pct}%
          </div>
        </div>
        <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-panel2" aria-label="关闭阶段详情">
          <X size={16} />
        </button>
      </header>
      <div className="mx-4 h-1 overflow-hidden rounded-full bg-panel2" aria-hidden>
        <div className="h-full w-full origin-left bg-accent transition-transform duration-500 ease-ui" style={{ transform: `scaleX(${Math.max(0, Math.min(100, pct)) / 100})` }} />
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {node.substeps && node.substeps.length > 0 && (
          <Section title="子步骤">
            <ol className="space-y-1.5">
              {node.substeps.map((s, j) => {
                const st = nr?.substeps.find((x) => x.id === s.id);
                const done = tone === 'done' || st?.status === 'done';
                const na = st?.status === 'na';
                return (
                  <li key={s.id} className="flex gap-2">
                    {done ? (
                      <CircleCheck size={15} className="mt-0.5 shrink-0 text-success" role="img" aria-label="已完成" />
                    ) : na ? (
                      <CircleMinus size={15} className="mt-0.5 shrink-0 text-muted" role="img" aria-label="不适用" />
                    ) : (
                      <CircleDashed size={15} className="mt-0.5 shrink-0 text-muted" role="img" aria-label="未完成" />
                    )}
                    <span className="min-w-0">
                      <span className="tabular-nums text-muted">
                        {idx + 1}.{j + 1}
                      </span>{' '}
                      <span className={cn(!done && !na && 'text-muted')}>{s.title}</span>
                      {st?.note && <span className="block text-xs text-muted">{na ? `不适用：${st.note}` : st.note}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </Section>
        )}

        {nr?.summary && (
          <Section title="副 AI 总结">
            <p className="whitespace-pre-wrap leading-relaxed">{nr.summary}</p>
          </Section>
        )}

        {evidence.length > 0 && (
          <Section title="提交的证据">
            <dl className="space-y-1.5">
              {evidence.map(([k, v]) => {
                const def = node.evidence?.find((f) => f.key === k);
                return (
                  <div key={k} className="rounded-lg bg-panel2 px-3 py-2">
                    <dt className="text-xs text-muted">{def?.desc ? `${def.desc}（${k}）` : k}</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap break-words tabular-nums">{typeof v === 'string' ? v : JSON.stringify(v, null, 1)}</dd>
                  </div>
                );
              })}
            </dl>
          </Section>
        )}

        <Section title={nr?.review ? '主 AI 审核' : '完成标准'}>
          <ol className="space-y-1.5">
            {(node.doneCriteria ?? []).map((c, i) => {
              const v = nr?.review?.perCriterion.find((x) => x.criterion === c || x.criterion.replace(/\s/g, '') === `第${i + 1}条`);
              return (
                <li key={c} className="flex gap-2">
                  {v ? (
                    v.verdict === 'met' ? (
                      <CircleCheck size={15} className="mt-0.5 shrink-0 text-success" role="img" aria-label="满足" />
                    ) : (
                      <CircleMinus size={15} className="mt-0.5 shrink-0 text-muted" role="img" aria-label="不适用" />
                    )
                  ) : (
                    <CircleDashed size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                  )}
                  <span className="min-w-0">
                    {c}
                    {v && <span className="block text-xs text-muted">{v.reason}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          {nr?.review?.decision === 'redo' && nr.review.feedback && (
            <p className="mt-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-text">返工意见：{nr.review.feedback}</p>
          )}
        </Section>

        <details className="text-xs">
          <summary className="cursor-pointer text-muted">SOP 原文（本阶段）</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-panel2 p-3 font-sans leading-relaxed">
            {(node.instructions ?? '').split('【本阶段】\n')[1]?.split('\n\n【')[0] ?? node.instructions}
          </pre>
        </details>
      </div>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-medium text-muted">{title}</h4>
      {children}
    </section>
  );
}

'use client';
import { Fragment } from 'react';
import { ChevronRight } from 'lucide-react';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { StageIcon, inferIcon } from './icons';
import { STATUS_LABEL, nodeRunOf, runProgress, runSteps, shortTitle, toneOf } from './model';

const CHIP: Record<string, string> = {
  idle: 'bg-panel2 opacity-60',
  active: 'bg-accent/10 ring-2 ring-accent',
  review: 'bg-warn/10 ring-2 ring-warn',
  done: 'bg-success/10',
  problem: 'bg-danger/10 ring-2 ring-danger',
};

/** The live card a workflow run leaves in the chat; opens the canvas or one stage for review. */
export function RunCard({ runId }: { runId: string }) {
  const run = useStore((s) => s.workflowRuns.find((r) => r.id === runId));
  const open = useStore((s) => s.openWorkflowPanel);
  const select = useStore((s) => s.selectWorkflowNode);
  if (!run) {
    return <div className="rounded-2xl bg-panel px-4 py-3 text-sm text-muted">工作流运行（记录不可用）</div>;
  }
  const steps = runSteps(run);
  const pct = runProgress(run);
  const cur = run.cursor ? steps.find((n) => n.id === run.cursor!.nodeId) : undefined;
  const curRun = cur ? nodeRunOf(run, cur.id) : undefined;
  const state =
    run.status === 'done'
      ? '全部阶段完成'
      : run.status === 'cancelled'
        ? '已停止'
        : cur
          ? `正在：${shortTitle(cur.title)} · ${STATUS_LABEL[curRun?.status ?? 'pending']}`
          : '';
  return (
    <div className="w-full max-w-[min(100%,560px)] rounded-2xl bg-panel px-4 py-3" aria-label={`工作流 ${run.workflowName}`}>
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{run.workflowName}</span>
        <span className="shrink-0 text-xs text-muted">
          v{run.version}
          {run.label ? ` · ${run.label}` : ''}
        </span>
        <span className="ml-auto shrink-0 text-sm tabular-nums">{run.status === 'cancelled' ? '—' : `${pct}%`}</span>
      </div>
      <ol className="mt-3 flex flex-wrap items-center gap-y-2" aria-label="阶段">
        {steps.map((n, i) => {
          const nr = nodeRunOf(run, n.id);
          const tone = toneOf(nr?.status);
          return (
            <Fragment key={n.id}>
              {i > 0 && <span className={cn('h-0.5 w-3 rounded-full', toneOf(nr?.status) === 'idle' ? 'bg-panel2' : 'bg-accent/60')} aria-hidden />}
              <li>
                <button
                  type="button"
                  onClick={() => select(run.id, n.id)}
                  className={cn('press grid h-8 w-8 place-items-center rounded-lg hover:outline hover:outline-1 hover:-outline-offset-1 hover:outline-text/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent', CHIP[tone])}
                  title={`${i + 1}. ${shortTitle(n.title)} · ${STATUS_LABEL[nr?.status ?? 'pending']} · ${nr?.progress ?? 0}%`}
                  aria-label={`${i + 1}. ${shortTitle(n.title)}，${STATUS_LABEL[nr?.status ?? 'pending']}，查看详情`}
                >
                  <StageIcon iconKey={inferIcon(n)} size={16} />
                </button>
              </li>
            </Fragment>
          );
        })}
      </ol>
      <div className="mt-3 flex items-center gap-3">
        <span className={cn('min-w-0 flex-1 truncate text-xs', run.status === 'done' ? 'text-success' : 'text-muted')}>{state}</span>
        <button type="button" onClick={() => open(run.id)} className="btn btn--secondary btn--sm shrink-0">
          查看流程 <ChevronRight size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}

'use client';
import { Circle, CircleCheck, CircleDot, CirclePause, CircleX, PanelRightOpen, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { PlanTaskDTO, WorkflowRunDTO } from '@chapi/shared';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { planProgress, planSteps, runProgress } from './workflow/model';

const ROW_ICON: Record<string, { icon: LucideIcon; cls: string; label: string }> = {
  pending: { icon: Circle, cls: 'text-muted', label: '未开始' },
  in_progress: { icon: CircleDot, cls: 'text-accent', label: '进行中' },
  done: { icon: CircleCheck, cls: 'text-success', label: '已完成' },
  failed: { icon: CircleX, cls: 'text-danger', label: '失败' },
  problem: { icon: TriangleAlert, cls: 'text-warn', label: '有问题' },
  blocked: { icon: CirclePause, cls: 'text-warn', label: '受阻' },
};

/** The current run's engine-owned plan rows (stages + sub-steps), in order. */
export function runRows(run: WorkflowRunDTO | undefined, plan: PlanTaskDTO[]): PlanTaskDTO[] {
  if (!run) return [];
  const ids = new Set(run.nodeRuns.map((n) => n.id));
  return plan.filter((t) => t.locked && t.nodeRunId && ids.has(t.nodeRunId.split(':')[0]!)).sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * The running SOP in the task flow: one title cell (name, version, overall %, filled to
 * that %) that opens the canvas on the right, then each stage (1, 2, …) and its sub-steps
 * (1.1, 1.2, … indented) as cells whose background fills with their own progress.
 */
export function WorkflowPanel() {
  const runs = useStore((s) => s.workflowRuns);
  const plan = useStore((s) => s.plan);
  const panel = useStore((s) => s.workflowPanel);
  const open = useStore((s) => s.openWorkflowPanel);
  const close = useStore((s) => s.closeWorkflowPanel);
  const run = runs[runs.length - 1];
  if (!run) return null;
  const rows = runRows(run, plan);
  const overall = run.status === 'cancelled' ? 0 : runProgress(run);
  const toggle = () => (panel.open ? close() : open(run.id));

  let i = 0;
  let j = 0;
  const numbered = rows.map((t) => {
    if (t.depth === 0) {
      i += 1;
      j = 0;
      return { t, label: `${i}` };
    }
    j += 1;
    return { t, label: `${i}.${j}` };
  });

  return (
    <div className="mb-3 space-y-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={panel.open}
        className="group relative flex w-full items-center gap-2 overflow-hidden rounded-lg bg-panel2 px-2.5 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        title={panel.open ? '收起流程图' : '在右侧打开流程图'}
      >
        <Fill pct={overall} strong />
        <span className="relative min-w-0 flex-1 truncate font-medium">
          {run.workflowName}
          <span className="ml-1.5 font-normal text-muted">v{run.version}</span>
        </span>
        <span className="relative shrink-0 tabular-nums">{run.status === 'cancelled' ? '已停止' : `${overall}%`}</span>
        <PanelRightOpen size={15} className={cn('relative shrink-0 text-muted transition-colors group-hover:text-accent', panel.open && 'text-accent')} aria-hidden />
      </button>
      <ul className="space-y-1">
        {numbered.map(({ t, label }) => (
          <Row key={t.id} t={t} label={label} runId={run.id} />
        ))}
      </ul>
    </div>
  );
}

function Fill({ pct, strong = false, pulse = false }: { pct: number; strong?: boolean; pulse?: boolean }) {
  return (
    <span
      className={cn('pointer-events-none absolute inset-y-0 left-0 w-full origin-left transition-transform duration-500 ease-ui', strong ? 'bg-accent/15' : 'bg-accent/10', pulse && 'motion-safe:animate-pulse')}
      style={{ transform: `scaleX(${Math.max(0, Math.min(100, pct)) / 100})` }}
      aria-hidden
    />
  );
}

function Row({ t, label, runId }: { t: PlanTaskDTO; label: string; runId: string }) {
  const select = useStore((s) => s.selectWorkflowNode);
  const meta = ROW_ICON[t.status] ?? ROW_ICON.pending!;
  const Icon = meta.icon;
  const sub = t.depth > 0;
  const pct = t.progress ?? (t.status === 'done' ? 100 : 0);
  const active = t.status === 'in_progress';
  const text = t.text.replace(/^【SOP】/, '');
  const nodeRunId = t.nodeRunId?.split(':')[0];
  const nodeId = useStore((s) => s.workflowRuns.find((r) => r.id === runId)?.nodeRuns.find((n) => n.id === nodeRunId)?.nodeId);
  return (
    <li className={cn(sub && 'ml-5')}>
      <button
        type="button"
        onClick={() => nodeId && select(runId, nodeId)}
        className={cn(
          'relative flex w-full items-start gap-1.5 overflow-hidden rounded-lg bg-panel2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          sub ? 'px-2 py-1 text-xs' : 'px-2 py-1.5 text-sm',
        )}
        aria-label={`${label} ${text}，${meta.label}，${pct}%，查看详情`}
      >
        <Fill pct={pct} strong={active} />
        <Icon size={sub ? 13 : 15} className={cn('relative mt-[3px] shrink-0', meta.cls)} aria-hidden />
        <span className={cn('relative shrink-0 tabular-nums text-muted', sub ? 'leading-5' : 'leading-snug')}>{label}</span>
        <span
          className={cn(
            'relative min-w-0 flex-1',
            sub ? 'leading-5' : 'leading-snug',
            active && 'font-medium',
            t.status === 'done' && 'text-muted',
            t.status === 'failed' && 'text-danger',
          )}
        >
          {text}
          {t.reason && <span className="mt-0.5 block text-2xs font-normal text-muted line-clamp-2">{t.reason}</span>}
        </span>
        {!sub && active && <span className="relative shrink-0 text-2xs tabular-nums text-accent">{pct}%</span>}
      </button>
    </li>
  );
}

/**
 * The conversation's own task flow (the main AI's set_plan) in the same cells as a
 * workflow: a title cell (task, done/total %, opens the canvas) and numbered steps
 * filled with their progress — done is full; a running step has no sub-steps to
 * measure, so it shows half, pulsing.
 */
export function PlanPanel({ withTitle }: { withTitle: boolean }) {
  const plan = useStore((s) => s.plan);
  const title = useStore((s) => s.session?.title ?? '任务流');
  const panel = useStore((s) => s.workflowPanel);
  const open = useStore((s) => s.openWorkflowPanel);
  const close = useStore((s) => s.closeWorkflowPanel);
  const steps = planSteps(plan);
  if (!steps.length) return withTitle ? <div className="px-1 text-xs text-muted">尚无计划</div> : null;
  const pct = planProgress(steps);
  const done = steps.filter((x) => x.tone === 'done').length;
  return (
    <div className="mb-3 space-y-1">
      {withTitle ? (
        <button
          type="button"
          onClick={() => (panel.open ? close() : open(null))}
          aria-expanded={panel.open}
          className="group relative flex w-full items-center gap-2 overflow-hidden rounded-lg bg-panel2 px-2.5 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          title={panel.open ? '收起流程图' : '在右侧打开流程图'}
        >
          <Fill pct={pct} strong />
          <span className="relative min-w-0 flex-1 truncate font-medium">{title}</span>
          <span className="relative shrink-0 tabular-nums text-muted">
            {done}/{steps.length}
          </span>
          <span className="relative shrink-0 tabular-nums">{pct}%</span>
          <PanelRightOpen size={15} className={cn('relative shrink-0 text-muted transition-colors group-hover:text-accent', panel.open && 'text-accent')} aria-hidden />
        </button>
      ) : (
        <div className="px-1 pt-1 text-xs text-muted">辅助步骤</div>
      )}
      <ol className="space-y-1">
        {steps.map((st, i) => {
          const t = plan.find((x) => x.id === st.id)!;
          const meta = ROW_ICON[st.status] ?? ROW_ICON.pending!;
          const Icon = meta.icon;
          const active = st.tone === 'active';
          return (
            <li key={st.id}>
              <div
                className="relative flex w-full items-start gap-1.5 overflow-hidden rounded-lg bg-panel2 px-2 py-1.5 text-sm"
                aria-label={`${i + 1} ${st.title}，${meta.label}`}
              >
                <Fill pct={st.progress} strong={active} pulse={active} />
                <Icon size={15} className={cn('relative mt-[3px] shrink-0', meta.cls)} aria-hidden />
                <span className="relative shrink-0 leading-snug tabular-nums text-muted">{i + 1}</span>
                <span className={cn('relative min-w-0 flex-1 leading-snug', active && 'font-medium', st.status === 'done' && 'text-muted', st.status === 'failed' && 'text-danger')}>
                  {st.title}
                  {t.reason && st.status !== 'done' && <span className="mt-0.5 block text-2xs font-normal text-muted line-clamp-2">{t.reason}</span>}
                </span>
                {active && <span className="relative shrink-0 text-2xs text-accent">进行中</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

'use client';
import { useMemo, useState } from 'react';
import { PanelRightClose } from 'lucide-react';
import { api } from '@/lib/api';
import { scheduleUndoable } from '@/lib/undoable';
import { useStore } from '@/lib/store';
import { NodeDetail } from './NodeDetail';
import { WorkflowCanvas, type PlanLine } from './WorkflowCanvas';
import { planProgress, planSteps, runProgress } from './model';

/**
 * Right-hand panel: the session's workflow runs as one live canvas (and the picked
 * stage's detail) — or, in a conversation without a workflow, its own task flow.
 */
export function WorkflowDock({ width }: { width: number }) {
  const runs = useStore((s) => s.workflowRuns);
  const plan = useStore((s) => s.plan);
  const title = useStore((s) => s.session?.title ?? '任务流');
  const panel = useStore((s) => s.workflowPanel);
  const close = useStore((s) => s.closeWorkflowPanel);
  const select = useStore((s) => s.selectWorkflowNode);
  // The run the user just stopped: shown as stopped at once, sent after the undo window.
  const [stoppedId, setStoppedId] = useState<string | null>(null);
  const steps = useMemo(() => planSteps(plan), [plan]);
  const planLine: PlanLine | undefined = useMemo(() => (steps.length ? { title, steps } : undefined), [steps, title]);
  if (!runs.length && !planLine) return null;

  const latest = runs[runs.length - 1];
  const focus = runs.find((r) => r.id === panel.runId) ?? latest;
  const live = runs.find((r) => ['running', 'waiting_user', 'blocked'].includes(r.status));
  const detailRun = panel.nodeId ? runs.find((r) => r.id === (panel.runId ?? latest?.id)) : undefined;

  const cancel = () => {
    if (!live) return;
    const { sessionId, id } = live;
    const reason = '用户在流程图上停止了工作流';
    setStoppedId(id);
    scheduleUndoable({
      label: '已停止',
      commit: () => api.cancelWorkflowRun(sessionId, id, reason),
      flush: () => api.cancelWorkflowRun(sessionId, id, reason, true),
      revert: () => setStoppedId(null),
      onError: (err) => {
        setStoppedId(null);
        useStore.setState({ toast: { level: 'error', title: '停止失败', body: err instanceof Error ? err.message : String(err), ts: Date.now() } });
      },
    });
  };
  const stopped = !!live && stoppedId === live.id;

  const heading = !focus ? title : runs.length > 1 ? `${runs.length} 个工作流` : focus.workflowName;
  const sub = !focus
    ? `任务流 · ${steps.filter((x) => x.tone === 'done').length}/${steps.length} 步 · ${planProgress(steps)}%`
    : runs.length > 1
      ? runs.map((r) => `${r.workflowName} ${runProgress(r)}%`).join(' → ')
      : `v${focus.version}${focus.label ? ` · ${focus.label}` : ''} · ${runProgress(focus)}%`;

  return (
    <section className="hidden h-[calc(100dvh-3.5rem)] shrink-0 flex-col bg-panel lg:flex" style={{ width }} aria-label="任务流程图">
      <header className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{heading}</h2>
          <p className="truncate text-xs text-muted">{sub}</p>
        </div>
        {live &&
          (stopped ? (
            <span className="flex h-8 items-center px-2 text-xs text-muted" role="status">
              已停止
            </span>
          ) : (
            <button type="button" onClick={cancel} className="btn btn--ghost btn--sm text-muted hover:text-danger">
              停止
            </button>
          ))}
        <button type="button" onClick={close} className="btn btn--ghost btn--icon btn--sm" aria-label="收起流程图">
          <PanelRightClose size={16} aria-hidden />
        </button>
      </header>
      <div className="relative min-h-0 flex-1">
        <WorkflowCanvas
          runs={runs}
          plan={runs.length ? undefined : planLine}
          focusRunId={panel.runId}
          selected={{ runId: panel.runId, nodeId: panel.nodeId }}
          onSelect={(runId, nodeId) => select(runId, panel.nodeId === nodeId && panel.runId === runId ? null : nodeId)}
        />
        {detailRun && panel.nodeId && (
          <div className="absolute inset-y-0 right-0 z-20 w-[min(360px,90%)]">
            <NodeDetail run={detailRun} nodeId={panel.nodeId} onClose={() => select(detailRun.id, null)} />
          </div>
        )}
      </div>
    </section>
  );
}

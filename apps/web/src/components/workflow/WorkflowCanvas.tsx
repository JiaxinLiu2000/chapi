'use client';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Check, Flag, Maximize2, Minus, Play, Plus } from 'lucide-react';
import type { WorkflowRunDTO } from '@chapi/shared';
import { cn } from '@/lib/utils';
import { StageIcon, inferIcon } from './icons';
import { STATUS_LABEL, nodeRunOf, runSteps, shortTitle, snakeLayout, toneOf, type NodeTone, type PlanStep } from './model';

/**
 * The live canvas: every workflow run of the session laid out left → right and chained
 * (run 1's end feeds run 2's start). Stage tiles carry their app icon, a progress ring
 * and their %, connectors fill as the run advances. Click a tile for its detail.
 */

const STEP_X = 150; // horizontal pitch between tiles
const NODE_W = 128; // node box width (tile is centred in it)

type StageData = {
  runId: string;
  nodeId: string;
  index: number;
  title: string;
  iconKey: string;
  progress: number;
  status: string;
  tone: NodeTone;
  selected: boolean;
  statusLabel?: string;
};
type BoundData = { kind: 'start' | 'end'; runId: string; caption: string; sub?: string; done: boolean };
type StageNode = Node<StageData, 'stage'>;
type BoundNode = Node<BoundData, 'bound'>;
type FlowNode = StageNode | BoundNode;
type ProgressEdgeT = Edge<{ progress: number; active: boolean; chain?: boolean }, 'progress'>;

const TONE_RING: Record<NodeTone, string> = {
  idle: 'rgb(var(--c-border))',
  active: 'rgb(var(--c-accent))',
  review: 'rgb(var(--c-warn))',
  done: 'rgb(var(--c-success))',
  problem: 'rgb(var(--c-danger))',
};

/** Invisible connection points on both sides (ids: ls/lt left source/target, rs/rt right). */
function SideHandles({ inset, y }: { inset: number; y: number }) {
  const cls = '!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent';
  return (
    <>
      <Handle id="lt" type="target" position={Position.Left} className={cls} style={{ left: inset, top: y }} />
      <Handle id="ls" type="source" position={Position.Left} className={cls} style={{ left: inset, top: y }} />
      <Handle id="rt" type="target" position={Position.Right} className={cls} style={{ right: inset, left: 'auto', top: y }} />
      <Handle id="rs" type="source" position={Position.Right} className={cls} style={{ right: inset, left: 'auto', top: y }} />
    </>
  );
}

const StageTile = memo(function StageTile({ data }: NodeProps<StageNode>) {
  const pct = Math.round(data.progress);
  const ring = TONE_RING[data.tone];
  return (
    <div className="flex w-[128px] cursor-pointer flex-col items-center text-center" title={`${data.title} · ${data.statusLabel ?? STATUS_LABEL[data.status] ?? data.status}`}>
      <SideHandles inset={34} y={28} />
      <div
        className={cn(
          'relative grid h-14 w-14 place-items-center rounded-2xl bg-panel transition-transform',
          data.selected && 'scale-105',
          data.tone === 'idle' && 'opacity-80',
        )}
      >
        {/* progress ring: a rounded square stroked to `pct` of its perimeter */}
        <svg className="pointer-events-none absolute inset-0" viewBox="0 0 56 56" aria-hidden>
          <rect x="1" y="1" width="54" height="54" rx="15" fill="none" stroke="rgb(var(--c-border))" strokeWidth="1.5" />
          <rect
            x="1"
            y="1"
            width="54"
            height="54"
            rx="15"
            fill="none"
            stroke={ring}
            strokeWidth={data.selected ? 3 : 2}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - Math.max(data.tone === 'idle' ? 0 : 0.02, pct / 100)}
            strokeLinecap="round"
            style={{ transition: 'stroke-dashoffset 500ms ease' }}
          />
        </svg>
        <StageIcon iconKey={data.iconKey} size={24} />
        {data.tone === 'done' && (
          <span className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-success text-bg" aria-label="已完成">
            <Check size={11} strokeWidth={3} />
          </span>
        )}
        {(data.tone === 'review' || data.tone === 'problem') && (
          <span className={cn('absolute -right-1 -top-1 h-3 w-3 rounded-full', data.tone === 'review' ? 'bg-warn' : 'bg-danger')} aria-hidden />
        )}
      </div>
      <div className={cn('mt-2 line-clamp-2 px-1 text-[13px] leading-snug', data.tone === 'idle' ? 'text-muted' : 'text-text', data.selected && 'font-medium')}>
        <span className="text-muted">{data.index}</span> {data.title}
      </div>
      <div
        className={cn(
          'mt-0.5 text-xs tabular-nums',
          data.tone === 'active' ? 'text-accent' : data.tone === 'review' ? 'text-warn' : data.tone === 'problem' ? 'text-danger' : 'text-muted',
        )}
      >
        {data.tone === 'idle' ? '' : data.tone === 'done' ? '100%' : data.tone === 'active' ? (data.runId === 'plan' ? '进行中' : `${pct}%`) : (data.statusLabel ?? STATUS_LABEL[data.status])}
      </div>
    </div>
  );
});

const BoundMark = memo(function BoundMark({ data }: NodeProps<BoundNode>) {
  return (
    <div className="flex w-[128px] flex-col items-center text-center">
      <SideHandles inset={44} y={20} />
      <div className={cn('grid h-10 w-10 place-items-center rounded-full', data.done ? 'bg-success/15 text-success' : 'bg-panel text-muted')}>
        {data.kind === 'start' ? <Play size={16} /> : <Flag size={16} />}
      </div>
      <div className="mt-2 line-clamp-2 px-1 text-[13px] leading-snug text-muted">{data.caption}</div>
      {data.sub && <div className="mt-0.5 line-clamp-1 max-w-full px-1 text-2xs text-muted">{data.sub}</div>}
    </div>
  );
});

function ProgressEdge(p: EdgeProps<ProgressEdgeT>) {
  const [path] = getSmoothStepPath({ ...p, borderRadius: 14 });
  const pct = Math.max(0, Math.min(1, p.data?.progress ?? 0));
  return (
    <>
      <BaseEdge
        id={p.id}
        path={path}
        markerEnd={p.markerEnd}
        style={{ stroke: 'rgb(var(--c-border))', strokeWidth: 1.5, strokeDasharray: p.data?.chain ? '4 4' : undefined }}
      />
      <path
        d={path}
        fill="none"
        stroke="rgb(var(--c-accent))"
        strokeWidth={2}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - pct}
        style={{ transition: 'stroke-dashoffset 500ms ease' }}
      />
      {p.data?.active && (
        <circle r={3} fill="rgb(var(--c-accent))">
          <animateMotion dur="1.4s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
}

const nodeTypes = { stage: StageTile, bound: BoundMark };
const edgeTypes = { progress: ProgressEdge };

type Item =
  | { kind: 'stage'; id: string; data: StageData; inProgress: number; started: boolean; done: boolean; active: boolean }
  | { kind: 'bound'; id: string; data: BoundData };

const ROW_H = 150;

export interface PlanLine {
  title: string;
  steps: PlanStep[];
}

const PLAN_STATUS_LABEL: Record<string, string> = { pending: '未开始', in_progress: '进行中', done: '已完成', problem: '有问题', blocked: '受阻', failed: '失败', error: '出错' };

function build(runs: WorkflowRunDTO[], selected: { runId: string | null; nodeId: string | null }, width: number, plan?: PlanLine) {
  // 1. the line: start → stages → end for each run, runs chained in order
  //    (no runs: the conversation's own task flow as one line)
  const items: Item[] = [];
  if (!runs.length && plan?.steps.length) {
    items.push({ kind: 'bound', id: 'plan:start', data: { kind: 'start', runId: 'plan', caption: plan.title, sub: '任务流', done: true } });
    plan.steps.forEach((st, i) => {
      items.push({
        kind: 'stage',
        id: `plan:${st.id}`,
        data: {
          runId: 'plan',
          nodeId: st.id,
          index: i + 1,
          title: st.title,
          iconKey: inferIcon({ title: st.title }),
          progress: st.progress,
          status: st.status,
          tone: st.tone,
          selected: false,
          statusLabel: PLAN_STATUS_LABEL[st.status] ?? st.status,
        },
        inProgress: st.progress,
        started: st.status !== 'pending',
        done: st.tone === 'done',
        active: st.tone === 'active',
      });
    });
    const allDone = plan.steps.every((x) => x.tone === 'done');
    items.push({ kind: 'bound', id: 'plan:end', data: { kind: 'end', runId: 'plan', caption: allDone ? '已完成' : '完成', done: allDone } });
  }
  for (const run of runs) {
    items.push({
      kind: 'bound',
      id: `${run.id}:start`,
      data: { kind: 'start', runId: run.id, caption: run.workflowName, sub: [`v${run.version}`, run.label].filter(Boolean).join(' · '), done: true },
    });
    runSteps(run).forEach((n, i) => {
      const nr = nodeRunOf(run, n.id);
      const tone = toneOf(nr?.status);
      const progress = nr?.progress ?? 0;
      items.push({
        kind: 'stage',
        id: `${run.id}:${n.id}`,
        data: {
          runId: run.id,
          nodeId: n.id,
          index: i + 1,
          title: shortTitle(n.title),
          iconKey: inferIcon(n),
          progress,
          status: nr?.status ?? 'pending',
          tone,
          selected: selected.runId === run.id && selected.nodeId === n.id,
        },
        inProgress: progress,
        started: (nr?.status ?? 'pending') !== 'pending',
        done: tone === 'done',
        active: tone === 'active',
      });
    });
    const done = run.status === 'done';
    items.push({
      kind: 'bound',
      id: `${run.id}:end`,
      data: { kind: 'end', runId: run.id, caption: done ? '已交付审批' : run.status === 'cancelled' ? '已取消' : '提交审批', done },
    });
  }

  // 2. snake it: rows alternate direction, as many per row as the panel width allows
  const { slots } = snakeLayout(items.length, width, STEP_X, ROW_H, NODE_W);
  const nodes: FlowNode[] = items.map((it, i) => {
    const slot = slots[i]!;
    return it.kind === 'stage'
      ? ({ id: it.id, type: 'stage', position: { x: slot.x, y: slot.y }, data: it.data, draggable: false } as StageNode)
      : ({ id: it.id, type: 'bound', position: { x: slot.x, y: slot.y + 8 }, data: it.data, draggable: false } as BoundNode);
  });

  // 3. connectors: along a row they leave from the side the row flows to; at a row
  //    end they leave from the outer side and come back into the next row from that
  //    same side (a bracket around the outside, clear of the labels).
  const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'rgb(var(--c-border))' };
  const edges: ProgressEdgeT[] = [];
  for (let i = 0; i + 1 < items.length; i++) {
    const a = items[i]!;
    const b = items[i + 1]!;
    const sa = slots[i]!;
    const sb = slots[i + 1]!;
    const out = sa.dir === 1 ? 'r' : 'l';
    const into = sa.row === sb.row ? (sa.dir === 1 ? 'l' : 'r') : out;
    const chain = a.kind === 'bound' && a.data.kind === 'end'; // run → next run
    let progress = 0;
    let active = false;
    if (chain) progress = 1;
    else if (b.kind === 'stage') {
      progress = !b.started ? 0 : b.done ? 1 : Math.max(0.15, b.inProgress / 100);
      active = b.active;
    } else if (b.kind === 'bound' && b.data.kind === 'end') progress = b.data.done ? 1 : 0;
    edges.push({
      id: `${a.id}->${b.id}`,
      source: a.id,
      target: b.id,
      sourceHandle: `${out}s`,
      targetHandle: `${into}t`,
      type: 'progress',
      markerEnd: chain ? undefined : marker,
      data: { progress, active, chain },
    });
  }
  return { nodes, edges };
}

function ZoomBar() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const btn = 'press grid h-8 w-8 place-items-center rounded-lg text-text hover:bg-panel2 active:bg-panel2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
  return (
    <div className="absolute bottom-3 right-3 z-10 flex items-center gap-0.5 rounded-xl bg-panel p-1" role="toolbar" aria-label="画布缩放">
      <span className="px-2 text-xs tabular-nums text-muted">{Math.round(zoom * 100)}%</span>
      <button type="button" className={btn} onClick={() => zoomIn({ duration: 150 })} aria-label="放大">
        <Plus size={16} />
      </button>
      <button type="button" className={btn} onClick={() => zoomOut({ duration: 150 })} aria-label="缩小">
        <Minus size={16} />
      </button>
      <button type="button" className={btn} onClick={() => fitView({ padding: 0.2, duration: 250 })} aria-label="适应窗口">
        <Maximize2 size={15} />
      </button>
    </div>
  );
}

function Canvas({
  runs,
  plan,
  selected,
  focusRunId,
  onSelect,
}: {
  runs: WorkflowRunDTO[];
  plan?: PlanLine;
  selected: { runId: string | null; nodeId: string | null };
  focusRunId: string | null;
  onSelect: (runId: string, nodeId: string) => void;
}) {
  const [width, setWidth] = useState(680);
  const [height, setHeight] = useState(600);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e!.contentRect.width);
      // relayout only when the number of tiles per row would change (avoid churn while dragging)
      setWidth((prev) => (Math.floor((prev - 48 - NODE_W) / STEP_X) === Math.floor((w - 48 - NODE_W) / STEP_X) ? prev : w));
      setHeight((prev) => (Math.abs(prev - e!.contentRect.height) < 40 ? prev : Math.round(e!.contentRect.height)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { nodes, edges } = useMemo(() => build(runs, selected, width, plan), [runs, selected, width, plan]);
  const { fitView } = useReactFlow();
  const runKey = runs.map((r) => `${r.id}:${r.nodeRuns.length}`).join('|') + `|plan:${plan?.steps.length ?? 0}`;
  // The node the view is about: the picked stage, else the focused run's current stage
  // (or its start when it hasn't begun / is finished).
  const focusRun = runs.find((r) => r.id === focusRunId) ?? runs[runs.length - 1];
  const anchorId = focusRun
    ? selected.nodeId && selected.runId === focusRun.id
      ? `${focusRun.id}:${selected.nodeId}`
      : focusRun.cursor && focusRun.status !== 'done'
        ? `${focusRun.id}:${focusRun.cursor.nodeId}`
        : null
    : null;
  useEffect(() => {
    // Snaked rows always fit the width at 100%. Show the whole canvas when its rows also fit
    // the panel height at a readable zoom (≥ 85%); only a canvas taller than that narrows to
    // the focused run, or to the rows around its current stage.
    const rows = nodes.length ? Math.max(...nodes.map((n) => n.position.y)) / ROW_H + 1 : 1;
    const fitsWhole = (rows * ROW_H + 40) * 0.85 <= height;
    let ids: { id: string }[] | undefined;
    if (!fitsWhole && focusRun) {
      const own = nodes.filter((n) => n.id.startsWith(`${focusRun.id}:`));
      const at = anchorId ? own.findIndex((n) => n.id === anchorId) : -1;
      ids = (at >= 0 ? own.slice(Math.max(0, at - 3), at + 4) : own).map((n) => ({ id: n.id }));
    }
    const t = setTimeout(() => fitView({ padding: 0.1, duration: 250, nodes: ids, maxZoom: 1, minZoom: 0.85 }), 30);
    return () => clearTimeout(t);
    // refit when the runs, the focus or the current stage change — not on every progress tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, focusRun?.id, anchorId, width, height, fitView]);
  return (
    <div ref={box} className="h-full w-full">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.3}
      maxZoom={1.8}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => {
        if (n.type === 'stage' && (n.data as StageData).runId !== 'plan') onSelect((n.data as StageData).runId, (n.data as StageData).nodeId);
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="rgb(var(--c-border))" />
      <ZoomBar />
    </ReactFlow>
    </div>
  );
}

export function WorkflowCanvas(props: Parameters<typeof Canvas>[0]) {
  return (
    <ReactFlowProvider>
      <div className="relative h-full w-full bg-panel2">
        <Canvas {...props} />
      </div>
    </ReactFlowProvider>
  );
}

// exported for the inline chat card
export { NODE_W };

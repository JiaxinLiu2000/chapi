'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Brain,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDot,
  CirclePause,
  CircleX,
  Clock,
  Coins,
  Lock,
  Cpu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Timer,
  TriangleAlert,
  Undo2,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { AgentRunDTO, PlanTaskDTO } from '@chapi/shared';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { cn, formatDuration, formatTokens } from '@/lib/utils';
import { PlanPanel, WorkflowPanel, runRows } from './WorkflowProgressLine';

/**
 * Live "active time" that ticks each second while the AI is actively running and
 * freezes when it pauses (idle, or waiting on a user question/approval). Re-anchors
 * to the authoritative server value whenever it updates.
 */
function useLiveElapsed(baseMs: number, ticking: boolean): number {
  const [, force] = useState(0);
  const anchor = useRef({ base: baseMs, at: Date.now() });
  useEffect(() => {
    anchor.current = { base: baseMs, at: Date.now() };
    force((n) => n + 1);
  }, [baseMs, ticking]);
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return ticking ? anchor.current.base + (Date.now() - anchor.current.at) : baseMs;
}

const runStateLabel: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  paused: '等待中',
  done: '已完成',
  error: '错误',
};

// Only "running" is live, so only it breathes.
const runStateColor: Record<string, string> = {
  idle: 'bg-muted/60',
  running: 'bg-success animate-pulse',
  paused: 'bg-warn',
  done: 'bg-accent',
  error: 'bg-danger',
};

// plan-task status → line icon + text role colour (one set, one size)
const PLAN_ICON: Record<string, { icon: LucideIcon; cls: string; label: string }> = {
  pending: { icon: Circle, cls: 'text-muted/70', label: '待办' },
  in_progress: { icon: CircleDot, cls: 'text-accent', label: '进行中' },
  done: { icon: CircleCheck, cls: 'text-success', label: '完成' },
  failed: { icon: CircleX, cls: 'text-danger', label: '失败' },
  problem: { icon: TriangleAlert, cls: 'text-warn', label: '有问题' },
  blocked: { icon: CirclePause, cls: 'text-warn', label: '受阻' },
  replaced: { icon: Undo2, cls: 'text-muted', label: '已换方案' },
  error: { icon: Undo2, cls: 'text-muted', label: '已换方案' },
};

// tag → theme tone (matches server describeActivity tags); tones live in globals.css
const TAG_TONE: Record<string, string> = {
  读取: 'sky',
  检索: 'sky',
  查找: 'sky',
  列目录: 'sky',
  查Wiki: 'sky',
  查文档: 'sky',
  找工具: 'sky',
  写入: 'amber',
  编辑: 'amber',
  写Wiki: 'amber',
  PDF: 'amber',
  交付: 'amber',
  命令: 'neutral',
  联网搜索: 'teal',
  抓取网页: 'teal',
  浏览器: 'green',
  Google: 'red',
  Gmail: 'red',
  Canva: 'rose',
  提问: 'accent',
  审批: 'accent',
  通知: 'accent',
  规划: 'slate',
  子任务: 'slate',
};

function TagChip({ tag }: { tag: string }) {
  return (
    <span className={`tone tone-${TAG_TONE[tag] ?? 'neutral'} shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium`}>
      {tag}
    </span>
  );
}

const PLAN_DONE_STATUSES = new Set(['done', 'replaced', 'error']);
const AGENT_DONE_STATUSES = new Set(['done', 'idle', 'interrupted', 'error']);

/** Section heading: one style for every group in the monitor. */
function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between px-1">
      <span className="label">{children}</span>
      {aside && <span className="text-2xs tabular-nums text-muted">{aside}</span>}
    </div>
  );
}

/**
 * Collapsed-by-default bar for finished items (完成的任务/代理/质检). Click to expand
 * a list ordered newest-to-oldest, so what's still active stays visually on top.
 */
function CompletedGroup({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="act h-8 w-full justify-start px-1.5 text-xs"
      >
        <ChevronDown
          size={14}
          aria-hidden
          className={cn('transition-transform duration-150 ease-ui', !open && '-rotate-90')}
        />
        已完成 <span className="tabular-nums">{count}</span>
      </button>
      {open && <div className="anim-drop mt-1 space-y-1 border-l border-border pl-2.5">{children}</div>}
    </div>
  );
}

function PlanTaskRow({ t }: { t: PlanTaskDTO }) {
  const active = t.status === 'in_progress';
  const meta = PLAN_ICON[t.status] ?? PLAN_ICON.pending!;
  const Icon = meta.icon;
  const struck = t.status === 'replaced' || t.status === 'error';
  return (
    <li className={cn('flex items-start gap-2 rounded-md px-1.5 py-1.5 text-sm', active && 'bg-accent/10')}>
      <Icon size={16} className={cn('mt-[2px]', meta.cls)} role="img" aria-label={meta.label} />
      <span
        className={cn(
          'min-w-0 leading-snug',
          active && 'font-medium',
          (t.status === 'done' || struck) && 'text-muted',
          t.status === 'failed' && 'text-danger',
          t.status === 'problem' && 'text-warn',
        )}
      >
        <span className={cn(struck && 'line-through')}>{t.text}</span>
        {t.locked && <Lock size={11} className="ml-1 inline align-[-1px] text-muted" role="img" aria-label="SOP 锁定步骤" />}
        {t.reason && t.status !== 'done' && (
          <span className="mt-0.5 block text-2xs font-normal text-muted" title={t.reason}>
            {t.status === 'replaced' ? '换方案：' : t.status === 'blocked' ? '受阻：' : t.status === 'failed' ? '失败：' : '问题：'}
            <span className="line-clamp-2 inline">{t.reason}</span>
          </span>
        )}
      </span>
    </li>
  );
}

function AgentRow({ a, currentStage }: { a: AgentRunDTO; currentStage?: string | null }) {
  const isMain = a.name === 'main';
  const isQuality = a.name === '质检';
  const isLearning = a.name === '学习';
  const sessionId = useStore((st) => st.sessionId);
  const running = a.status === 'running';
  const scheduled = a.status === 'scheduled';
  // main agent shows the CURRENT plan stage; others show their task title
  const subtitle = isMain ? (currentStage ?? a.title) : a.title;

  // live countdown for scheduled tasks
  const [, force] = useState(0);
  useEffect(() => {
    if (!scheduled) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [scheduled]);
  const remainSec =
    scheduled && a.scheduledFor ? Math.max(0, Math.ceil((new Date(a.scheduledFor).getTime() - Date.now()) / 1000)) : 0;
  const mmss = `${Math.floor(remainSec / 60)}:${String(remainSec % 60).padStart(2, '0')}`;

  const statusText = running
    ? '运行中'
    : scheduled
      ? '定时'
      : a.status === 'idle'
        ? '空闲'
        : a.status === 'interrupted'
          ? '已中断'
          : a.status === 'error'
            ? '出错'
            : '已结束';

  return (
    <div className="rounded-xl border border-border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Cpu size={14} aria-hidden className={running || scheduled ? 'text-success' : 'text-muted'} />
          <span className="shrink-0">
            {isMain ? '主代理' : isQuality ? '质检' : isLearning ? '学习' : scheduled ? '定时检查' : '子代理'}
          </span>
          {!isMain && !isQuality && !isLearning && !scheduled && (
            <span className="truncate text-2xs font-normal text-muted">{a.name}</span>
          )}
        </div>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-2xs',
            running ? 'bg-success/15 text-success' : scheduled ? 'bg-warn/15 text-warn' : 'bg-panel2 text-muted',
          )}
        >
          {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" aria-hidden />}
          {statusText}
        </span>
      </div>

      {subtitle && (
        <div className="mt-1 line-clamp-2 text-xs leading-snug text-text/90" title={subtitle}>
          {subtitle}
        </div>
      )}

      {/* sub-agent work summary, shown once it has finished */}
      {!isMain && !running && (!scheduled || isQuality) && a.summary && (
        <div className="mt-2 border-l-2 border-success/50 pl-2 text-2xs leading-snug text-muted" title={a.summary}>
          <span className="font-medium text-success">总结 </span>
          <span className="line-clamp-3 whitespace-pre-wrap align-top">{a.summary}</span>
        </div>
      )}

      {scheduled && !isQuality && (
        <div className="mt-2 flex items-center gap-1 text-xs font-medium tabular-nums text-warn">
          <Timer size={14} aria-hidden /> 还有 {remainSec} 秒执行
        </div>
      )}

      {isQuality && (
        <div className="mt-2 flex items-center justify-between gap-2 text-2xs">
          <span className={cn('flex min-w-0 items-center gap-1', scheduled ? 'font-medium text-warn' : 'text-muted')}>
            {scheduled && <Timer size={12} aria-hidden />}
            <span className="truncate tabular-nums">
              {scheduled ? `下次质检 ${mmss}` : running ? '正在评估…' : a.title || '未开启定时质检'}
            </span>
          </span>
          {!running && sessionId && (
            <button
              className="btn btn--secondary btn--sm shrink-0 !px-2 !text-2xs"
              onClick={() => getSocket().send({ type: 'quality.run', sessionId })}
              title="立即运行一次质检（不影响定时周期）"
            >
              立即质检
            </button>
          )}
        </div>
      )}

      {running && a.currentTool ? (
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          <TagChip tag={a.currentTool} />
          {a.currentActivity && (
            <span className="truncate text-2xs text-muted" title={a.currentActivity}>
              {a.currentActivity}
            </span>
          )}
        </div>
      ) : null}

      {(a.elapsedMs > 0 || a.tokens > 0) && (
        <div className="mt-2 flex items-center gap-3 text-2xs tabular-nums text-muted">
          {a.elapsedMs > 0 && (
            <span className="flex items-center gap-1">
              <Clock size={12} aria-hidden />
              {formatDuration(a.elapsedMs)}
            </span>
          )}
          {a.tokens > 0 && (
            <span className="flex items-center gap-1">
              <Coins size={12} aria-hidden />
              {formatTokens(a.tokens)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-2xs text-muted">
        <Icon size={12} aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 font-mono text-[14px] tabular-nums text-text">{value}</div>
    </div>
  );
}

/** Everything the monitor shows (shared by the sidebar and the drawer). */
function MonitorBody() {
  const usage = useStore((s) => s.usage);
  const fullPlan = useStore((s) => s.plan);
  const workflowRuns = useStore((s) => s.workflowRuns);
  // The running SOP's stages/sub-steps render in the workflow block; the rest below as usual.
  const wfRowIds = new Set(runRows(workflowRuns[workflowRuns.length - 1], fullPlan).map((t) => t.id));
  const plan = fullPlan.filter((t) => !wfRowIds.has(t.id));
  const agents = useStore((s) => s.agents);
  const runState = useStore((s) => s.runState);
  const questions = useStore((s) => s.questions);
  const approvals = useStore((s) => s.approvals);

  const done = plan.filter((t) => t.status === 'done').length;
  const currentStage = fullPlan.find((t) => t.status === 'in_progress' && t.depth === 0)?.text.replace(/^【SOP】/, '') ?? null;

  // Active plan tasks stay visible (in-progress first); finished ones collapse.
  const activePlanTasks = plan
    .filter((t) => !PLAN_DONE_STATUSES.has(t.status))
    .slice()
    .sort((a, b) => {
      const rank = (t: PlanTaskDTO) => (t.status === 'in_progress' ? 0 : 1);
      return rank(a) - rank(b) || a.ordinal - b.ordinal;
    });
  const donePlanTasks = plan
    .filter((t) => PLAN_DONE_STATUSES.has(t.status))
    .slice()
    .sort((a, b) => b.ordinal - a.ordinal);

  const mainAgent = agents.find((a) => a.name === 'main');
  const otherAgents = agents.filter((a) => a.name !== 'main');
  const activeAgents = otherAgents.filter((a) => !AGENT_DONE_STATUSES.has(a.status));
  const doneAgents = otherAgents
    .filter((a) => AGENT_DONE_STATUSES.has(a.status))
    .slice()
    .sort((a, b) => {
      const at = Date.parse(a.endedAt ?? a.startedAt ?? '') || 0;
      const bt = Date.parse(b.endedAt ?? b.startedAt ?? '') || 0;
      return bt - at;
    });
  // tick while actively running; pause when idle or waiting on the user (HITL)
  const ticking = runState === 'running' && questions.length === 0 && approvals.length === 0;
  const liveMs = useLiveElapsed(usage?.activeMs ?? 0, ticking);

  return (
    <div className="space-y-5">
      {/* status + stats: one surface, no boxes inside */}
      <section className="rounded-xl border border-border p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <span className={cn('h-2 w-2 rounded-full', runStateColor[runState])} aria-hidden />
          {runStateLabel[runState] ?? runState}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <Stat icon={Clock} label="运行耗时" value={formatDuration(liveMs)} />
          <Stat icon={MessageSquare} label="Claude 调用" value={String(usage?.claudeCalls ?? 0)} />
          <Stat icon={Wrench} label="工具调用" value={String(usage?.toolCallCount ?? 0)} />
          <Stat icon={Brain} label="学习次数" value={String(usage?.learnings ?? 0)} />
        </div>
      </section>

      <section>
        <SectionLabel aside={plan.length > 0 ? `${done}/${plan.length}` : undefined}>任务流</SectionLabel>
        <WorkflowPanel />
        <PlanPanel withTitle={wfRowIds.size === 0} />
      </section>

      {agents.length > 0 && (
        <section>
          <SectionLabel>代理状态</SectionLabel>
          <div className="space-y-2">
            {mainAgent && <AgentRow key={mainAgent.id} a={mainAgent} currentStage={currentStage} />}
            {activeAgents.map((a) => (
              <AgentRow key={a.id} a={a} />
            ))}
          </div>
          <CompletedGroup count={doneAgents.length}>
            <div className="space-y-2">
              {doneAgents.map((a) => (
                <AgentRow key={a.id} a={a} />
              ))}
            </div>
          </CompletedGroup>
        </section>
      )}
    </div>
  );
}

/**
 * Session monitor: a collapsible sidebar from `lg` up; below that a drawer
 * opened from the run bar (`monitorOpen` in the store).
 */
export function MonitorCard() {
  const [collapsed, setCollapsed] = useState(false);
  const drawerOpen = useStore((s) => s.monitorOpen);
  const setDrawer = useStore((s) => s.setMonitorOpen);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('chapi:monitorCollapsed') === '1');
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem('chapi:monitorCollapsed', next ? '1' : '0');
      } catch {
        /* storage unavailable */
      }
      return next;
    });

  // Drawer: focus moves into it (and back to the opener on close); Esc closes;
  // it never stays open once the sidebar takes over.
  const drawerClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    drawerClose.current?.focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    const mq = window.matchMedia('(min-width: 1024px)');
    const onMq = () => mq.matches && setDrawer(false);
    window.addEventListener('keydown', onKey);
    mq.addEventListener('change', onMq);
    return () => {
      window.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onMq);
    };
  }, [drawerOpen, setDrawer]);

  return (
    <>
      {/* lg+: sidebar (no width animation — content fades in when it opens) */}
      <aside
        className={cn(
          'hidden h-[calc(100dvh-3.5rem)] shrink-0 flex-col border-r border-border bg-panel lg:flex',
          collapsed ? 'w-12' : 'w-72 2xl:w-80',
        )}
        aria-label="任务监控"
      >
        <div className={cn('flex h-11 shrink-0 items-center px-2', collapsed ? 'justify-center' : 'justify-between pl-4')}>
          {!collapsed && <span className="label">监控</span>}
          <button
            onClick={toggle}
            className="btn btn--ghost btn--icon btn--sm"
            aria-label={collapsed ? '展开监控' : '折叠监控'}
            title={collapsed ? '展开监控' : '折叠监控'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen size={16} aria-hidden /> : <PanelLeftClose size={16} aria-hidden />}
          </button>
        </div>
        {!collapsed && (
          <div className="scroll-area anim-fade min-h-0 flex-1 px-3 pb-4">
            <MonitorBody />
          </div>
        )}
      </aside>

      {/* < lg: drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 top-14 z-40 lg:hidden">
          <div className="anim-fade absolute inset-0 bg-scrim/40" onClick={() => setDrawer(false)} aria-hidden />
          <aside
            className="anim-sheet-left absolute inset-y-0 left-0 flex w-[min(88vw,340px)] flex-col border-r border-border bg-panel"
            role="dialog"
            aria-modal="true"
            aria-label="任务监控"
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border pl-4 pr-2">
              <span className="text-sm font-medium">任务监控</span>
              <button ref={drawerClose} onClick={() => setDrawer(false)} className="btn btn--ghost btn--icon" aria-label="关闭监控">
                <X size={18} aria-hidden />
              </button>
            </div>
            <div className="scroll-area pb-safe min-h-0 flex-1 px-3 pt-3">
              <MonitorBody />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

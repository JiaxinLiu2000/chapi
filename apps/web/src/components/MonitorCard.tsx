'use client';
import { Activity, Clock, Coins, Cpu } from 'lucide-react';
import type { AgentRunDTO } from '@chapi/shared';
import { useStore } from '@/lib/store';
import { cn, formatCost, formatDuration, formatTokens } from '@/lib/utils';

const runStateLabel: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  paused: '等待中',
  done: '已完成',
  error: '错误',
};

const runStateColor: Record<string, string> = {
  idle: 'bg-muted',
  running: 'bg-success animate-pulse',
  paused: 'bg-warn',
  done: 'bg-accent',
  error: 'bg-danger',
};

function AgentRow({ a }: { a: AgentRunDTO }) {
  return (
    <div className="rounded-lg border border-border bg-panel2 p-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Cpu size={13} className="text-muted" />
          {a.name === 'main' ? '主代理' : a.name}
        </div>
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px]',
            a.status === 'running' ? 'bg-success/20 text-success' : 'bg-border text-muted',
          )}
        >
          {a.status === 'running' ? '运行中' : a.status === 'interrupted' ? '已中断' : '已结束'}
        </span>
      </div>
      {a.currentTool && (
        <div className="mt-1 text-xs text-muted">
          🔧 {a.currentTool}
          {a.currentActivity ? `: ${a.currentActivity}` : ''}
        </div>
      )}
      {a.elapsedMs > 0 && <div className="mt-0.5 text-[11px] text-muted/70">{formatDuration(a.elapsedMs)}</div>}
    </div>
  );
}

export function MonitorCard() {
  const usage = useStore((s) => s.usage);
  const plan = useStore((s) => s.plan);
  const agents = useStore((s) => s.agents);
  const runState = useStore((s) => s.runState);

  const done = plan.filter((t) => t.status === 'done').length;

  return (
    <aside className="hidden h-[calc(100vh-3.5rem)] w-72 shrink-0 overflow-y-auto border-r border-border bg-panel/50 p-3 lg:block">
      {/* status + stats */}
      <div className="rounded-xl border border-border bg-panel p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <span className={cn('h-2.5 w-2.5 rounded-full', runStateColor[runState])} />
          {runStateLabel[runState] ?? runState}
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Stat icon={<Clock size={13} />} label="运行耗时" value={formatDuration(usage?.activeMs ?? 0)} />
          <Stat icon={<Coins size={13} />} label="Token" value={formatTokens(usage?.totalTokens ?? 0)} />
          <Stat icon={<Activity size={13} />} label="成本" value={formatCost(usage?.costUsd ?? 0)} />
          <Stat icon={<Cpu size={13} />} label="代理" value={String(agents.length || 0)} />
        </div>
      </div>

      {/* plan */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between px-1 text-xs font-semibold text-muted">
          <span>任务流</span>
          {plan.length > 0 && (
            <span>
              {done}/{plan.length}
            </span>
          )}
        </div>
        {plan.length === 0 ? (
          <div className="px-1 text-xs text-muted/60">尚无计划</div>
        ) : (
          <ul className="space-y-1">
            {plan.map((t) => (
              <li key={t.id} className="flex items-start gap-1.5 text-sm">
                <span className="mt-0.5">
                  {t.status === 'done' ? '✅' : t.status === 'in_progress' ? '🔄' : t.status === 'error' ? '⚠️' : '⬜'}
                </span>
                <span
                  className={cn(
                    'leading-snug',
                    t.status === 'done' && 'text-muted',
                    t.status === 'error' && 'text-muted line-through',
                  )}
                >
                  {t.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* agents */}
      {agents.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 px-1 text-xs font-semibold text-muted">代理状态</div>
          <div className="space-y-1.5">
            {agents.map((a) => (
              <AgentRow key={a.id} a={a} />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-panel2 p-2">
      <div className="flex items-center gap-1 text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-0.5 font-mono text-sm text-text">{value}</div>
    </div>
  );
}

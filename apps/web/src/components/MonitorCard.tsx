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

// hard-coded tag -> color tone (matches server describeActivity tags)
const TAG_TONE: Record<string, { bg: string; fg: string }> = {
  读取: { bg: '#1e3a5f', fg: '#7cc4ff' },
  检索: { bg: '#1e3a5f', fg: '#7cc4ff' },
  查找: { bg: '#1e3a5f', fg: '#7cc4ff' },
  列目录: { bg: '#1e3a5f', fg: '#7cc4ff' },
  查Wiki: { bg: '#1e3a5f', fg: '#7cc4ff' },
  查文档: { bg: '#1e3a5f', fg: '#7cc4ff' },
  找工具: { bg: '#1e3a5f', fg: '#7cc4ff' },
  写入: { bg: '#4a3410', fg: '#f5b955' },
  编辑: { bg: '#4a3410', fg: '#f5b955' },
  写Wiki: { bg: '#4a3410', fg: '#f5b955' },
  PDF: { bg: '#4a3410', fg: '#f5b955' },
  交付: { bg: '#4a3410', fg: '#f5b955' },
  命令: { bg: '#3a2a4f', fg: '#c89bf5' },
  联网搜索: { bg: '#0e3b3b', fg: '#5fe3d0' },
  抓取网页: { bg: '#0e3b3b', fg: '#5fe3d0' },
  浏览器: { bg: '#10402a', fg: '#5fe39a' },
  Google: { bg: '#4a1f1f', fg: '#ff8a8a' },
  Canva: { bg: '#4a1f3a', fg: '#ff8ad0' },
  提问: { bg: '#2f2a5f', fg: '#a9a0ff' },
  审批: { bg: '#2f2a5f', fg: '#a9a0ff' },
  通知: { bg: '#2f2a5f', fg: '#a9a0ff' },
  规划: { bg: '#2a3340', fg: '#9db4cc' },
  子任务: { bg: '#2a3340', fg: '#9db4cc' },
};

function TagChip({ tag }: { tag: string }) {
  const tone = TAG_TONE[tag] ?? { bg: '#2a2a33', fg: '#b9b9c4' };
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ backgroundColor: tone.bg, color: tone.fg }}
    >
      {tag}
    </span>
  );
}

function AgentRow({ a }: { a: AgentRunDTO }) {
  const isMain = a.name === 'main';
  const running = a.status === 'running';
  return (
    <div className="rounded-lg border border-border bg-panel2 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <Cpu size={13} className={running ? 'text-success' : 'text-muted'} />
          <span>{isMain ? '主代理' : '子代理'}</span>
          {!isMain && <span className="truncate text-[10px] text-muted/60">{a.name}</span>}
        </div>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px]',
            running ? 'bg-success/20 text-success' : 'bg-border text-muted',
          )}
        >
          {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
          {running ? '运行中' : a.status === 'interrupted' ? '已中断' : a.status === 'error' ? '出错' : '已结束'}
        </span>
      </div>

      {a.title && (
        <div className="mt-1 line-clamp-2 text-xs leading-snug text-text/90" title={a.title}>
          {a.title}
        </div>
      )}

      {running && a.currentTool ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <TagChip tag={a.currentTool} />
          {a.currentActivity && (
            <span className="truncate text-[11px] text-muted" title={a.currentActivity}>
              {a.currentActivity}
            </span>
          )}
        </div>
      ) : null}

      <div className="mt-1.5 flex items-center gap-3 text-[10px] text-muted/60">
        {a.elapsedMs > 0 && (
          <span className="flex items-center gap-1">
            <Clock size={10} />
            {formatDuration(a.elapsedMs)}
          </span>
        )}
        {a.tokens > 0 && (
          <span className="flex items-center gap-1">
            <Coins size={10} />
            {formatTokens(a.tokens)}
          </span>
        )}
      </div>
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

'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Play, Plus } from 'lucide-react';
import type { AutomationDTO, AutomationRunStatus } from '@chapi/shared';
import { api, ApiError } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { AutomationEditor } from './AutomationEditor';
import { formatPT, formatPTFull, ScheduleLabel } from './ScheduleLabel';

const STATUS: Record<AutomationRunStatus, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: 'tone-slate' },
  running: { label: '运行中', tone: 'tone-sky' },
  waiting_user: { label: '等你处理', tone: 'tone-amber' },
  stale: { label: '已过期', tone: 'tone-amber' },
  done: { label: '完成', tone: 'tone-green' },
  failed: { label: '失败', tone: 'tone-red' },
  skipped: { label: '跳过', tone: 'tone-neutral' },
};
/** A past session linked as an earlier run (trigger 'history'): shown by its trigger, not "完成". */
const HISTORY = { label: '历史会话', tone: 'tone-slate' };

const toast = (level: 'error' | 'success' | 'info', title: string, body: string, sessionSlug?: string) =>
  useStore.setState({ toast: { level, title, body, ts: Date.now(), sessionSlug } });

/** The automation register: a table from md, a card list below. */
export function AutomationTable() {
  const { data, isLoading, error } = useQuery({ queryKey: ['board', 'automations'], queryFn: api.listAutomations });
  const [editing, setEditing] = useState<AutomationDTO | 'new' | null>(null);
  const list = data?.automations ?? [];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-sm text-muted">
          每次运行都开一个新会话。只有绑定了已确认 SOP 的任务才能设成自动，时间按太平洋时间（PT）。
        </p>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => setEditing('new')}>
          <Plus size={14} aria-hidden />
          新建任务
        </button>
      </div>

      {isLoading && <div className="text-sm text-muted" role="status">加载中…</div>}
      {error && <div className="text-sm text-danger">读取失败：{error instanceof Error ? error.message : String(error)}</div>}
      {data && list.length === 0 && <p className="rounded-lg bg-panel2/60 px-3 py-4 text-sm text-muted">还没有自动化任务</p>}

      {list.length > 0 && (
        <>
          {/* ≥ md: table */}
          <div className="scroll-x rounded-xl border border-border bg-panel max-md:hidden">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="whitespace-nowrap border-b border-border text-xs text-muted">
                  <th scope="col" className="py-2 pl-4 pr-3 font-medium">名称</th>
                  <th scope="col" className="px-3 py-2 font-medium">频率</th>
                  <th scope="col" className="px-3 py-2 font-medium">SOP</th>
                  <th scope="col" className="px-3 py-2 font-medium">模式</th>
                  <th scope="col" className="px-3 py-2 font-medium">上次运行</th>
                  <th scope="col" className="px-3 py-2 font-medium">下次运行</th>
                  <th scope="col" className="py-2 pl-3 pr-3 font-medium">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id} className="border-b border-border align-top last:border-b-0">
                    <td className="py-3 pl-4 pr-3">
                      <span className={cn('line-clamp-2 min-w-[8rem] font-medium [overflow-wrap:anywhere]', !a.enabled && 'text-muted')} title={a.name}>
                        {a.name}
                      </span>
                      {!a.enabled && <span className="text-2xs text-muted">已停用</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <ScheduleLabel spec={a.schedule} />
                    </td>
                    <td className="px-3 py-3">
                      <SopCell a={a} />
                    </td>
                    <td className="px-3 py-3">
                      <ModeSwitch a={a} />
                    </td>
                    <td className="px-3 py-3">
                      <LastRun a={a} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <NextRun a={a} />
                    </td>
                    <td className="py-2 pl-3 pr-3">
                      <div className="flex items-center justify-end gap-1">
                        <RunButton a={a} compact />
                        <EditButton onClick={() => setEditing(a)} name={a.name} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* < md: cards */}
          <ul className="space-y-2 md:hidden">
            {list.map((a) => (
              <li key={a.id} className="rounded-xl border border-border bg-panel px-4 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className={cn('line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]', !a.enabled && 'text-muted')}>{a.name}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      <ScheduleLabel spec={a.schedule} />
                      {!a.enabled && ' · 已停用'}
                    </div>
                  </div>
                  <ModeSwitch a={a} />
                </div>
                <dl className="mt-3 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                  <dt className="text-xs leading-5 text-muted">SOP</dt>
                  <dd className="min-w-0">
                    <SopCell a={a} />
                  </dd>
                  <dt className="text-xs leading-5 text-muted">上次运行</dt>
                  <dd className="min-w-0">
                    <LastRun a={a} />
                  </dd>
                  <dt className="text-xs leading-5 text-muted">下次运行</dt>
                  <dd className="min-w-0">
                    <NextRun a={a} />
                  </dd>
                </dl>
                <div className="mt-3 flex items-center justify-end gap-1">
                  <EditButton onClick={() => setEditing(a)} name={a.name} />
                  <RunButton a={a} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <AutomationEditor target={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function SopCell({ a }: { a: AutomationDTO }) {
  if (!a.workflowSlug) return <span className="tone tone-neutral whitespace-nowrap rounded px-1.5 py-0.5 text-2xs">未绑定 SOP</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <Link href="/workflows" className="line-clamp-2 min-w-0 text-accent [overflow-wrap:anywhere] hover:underline" title={a.workflowName ?? a.workflowSlug}>
        {a.workflowName ?? a.workflowSlug}
      </Link>
      {!a.workflowConfirmed && <span className="tone tone-amber rounded px-1.5 py-px text-2xs">未确认</span>}
    </span>
  );
}

function ModeSwitch({ a }: { a: AutomationDTO }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const canAuto = !!a.workflowSlug && a.workflowConfirmed;
  const on = a.mode === 'auto';
  const disabled = busy || (!canAuto && !on);

  const toggle = async () => {
    setBusy(true);
    try {
      await api.updateAutomation(a.id, { mode: on ? 'manual' : 'auto' });
      await qc.invalidateQueries({ queryKey: ['board', 'automations'] });
    } catch (e) {
      toast('error', '没能切换模式', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <label
      className={cn('inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-sm', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
      title={!canAuto && !on ? (a.workflowSlug ? '先确认 SOP' : '先整理成 SOP') : on ? '到点自动运行（点一下改回手动）' : '只在你点「立即运行」时运行'}
    >
      <input type="checkbox" role="switch" className="switch" checked={on} disabled={disabled} onChange={toggle} aria-label={`${a.name}：自动运行`} />
      <span className={cn(on ? 'text-text' : 'text-muted')}>{on ? '自动' : '手动'}</span>
    </label>
  );
}

function LastRun({ a }: { a: AutomationDTO }) {
  const r = a.lastRun;
  if (!r) return <span className="whitespace-nowrap text-muted">还没运行过</span>;
  const s = r.trigger === 'history' ? HISTORY : STATUS[r.status];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className={cn('tone whitespace-nowrap rounded px-1.5 py-px text-2xs', s.tone)} title={r.note ?? undefined}>
        {s.label}
      </span>
      {r.sessionSlug ? (
        <Link href={`/s/${r.sessionSlug}`} className="whitespace-nowrap text-accent hover:underline" title={formatPTFull(r.startedAt)}>
          {formatPT(r.startedAt)}
        </Link>
      ) : (
        <span className="whitespace-nowrap text-muted" title={formatPTFull(r.startedAt)}>
          {formatPT(r.startedAt)}
        </span>
      )}
      {r.note && (r.status === 'failed' || r.status === 'skipped') && (
        <span className="line-clamp-2 w-full max-w-[16rem] text-2xs text-muted [overflow-wrap:anywhere]" title={r.note}>
          {r.note}
        </span>
      )}
    </div>
  );
}

function NextRun({ a }: { a: AutomationDTO }) {
  if (!a.enabled) return <span className="text-muted">已停用</span>;
  if (a.mode !== 'auto') return <span className="text-muted">手动触发</span>;
  if (!a.nextRunAt) return <span className="text-muted">—</span>;
  return (
    <time dateTime={a.nextRunAt} title={formatPTFull(a.nextRunAt)} className="tabular-nums">
      {formatPT(a.nextRunAt)}
    </time>
  );
}

/** `compact`: icon-only below lg (the table at tablet width). */
function RunButton({ a, compact = false }: { a: AutomationDTO; compact?: boolean }) {
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const live = a.openRuns.some((r) => r.status === 'running' || r.status === 'queued');
  const spinning = starting || live;

  const run = async () => {
    setStarting(true);
    try {
      const { run } = await api.runAutomation(a.id);
      await qc.invalidateQueries({ queryKey: ['board'] });
      toast('success', `已开始「${a.name}」`, '新会话已经开好，可以在看板「今天」里跟进。', run.sessionSlug ?? undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const slug = typeof e.body.sessionSlug === 'string' ? e.body.sessionSlug : undefined;
        toast('error', '上次还没完成', slug ? `${e.message}\n可以先打开上次的会话看看。` : e.message, slug);
      } else {
        toast('error', '没能开始运行', e instanceof Error ? e.message : String(e));
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <button
      type="button"
      className={cn('btn btn--secondary btn--sm', compact && 'max-lg:w-8 max-lg:!px-0 [@media(pointer:coarse)]:max-lg:w-10')}
      onClick={run}
      disabled={spinning}
      title={live ? '这个任务正在运行' : compact ? '立即运行' : undefined}
    >
      {spinning ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Play size={14} aria-hidden />}
      <span className={cn(compact && 'max-lg:sr-only')}>{live ? '运行中' : '立即运行'}</span>
    </button>
  );
}

function EditButton({ onClick, name }: { onClick: () => void; name: string }) {
  return (
    <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClick} aria-label={`编辑「${name}」`} title="编辑">
      <Pencil size={14} aria-hidden />
    </button>
  );
}

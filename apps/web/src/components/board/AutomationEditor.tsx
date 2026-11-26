'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Trash2 } from 'lucide-react';
import { EFFORT_LEVELS, MODEL_OPTIONS, type AutomationDTO, type ScheduleSpec } from '@chapi/shared';
import { api, type AutomationInput } from '@/lib/api';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
import { useDiscardGuard } from '@/components/ui/useDiscardGuard';
import { effortLabel } from '@/components/ConfigSelectors';
import { describeSchedule, todayPT, WEEKDAY_NAMES } from './ScheduleLabel';

const KINDS: { value: ScheduleSpec['kind']; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '每个工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'biweekly', label: '每两周' },
  { value: 'monthly', label: '每月' },
];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

interface Draft {
  name: string;
  kind: ScheduleSpec['kind'];
  time: string;
  weekdays: number[];
  anchorDate: string;
  /** Monthly days (1–31); one or several. */
  days: number[];
  /** The task was saved with daysOfMonth — keep that form even for a single day (no spurious "schedule changed"). */
  daysForm: boolean;
  workflowSlug: string;
  prompt: string;
  inputs: string;
  projectId: string;
  model: string;
  effort: string;
  enabled: boolean;
}

function toDraft(a: AutomationDTO | null): Draft {
  const s = a?.schedule;
  return {
    name: a?.name ?? '',
    kind: s?.kind ?? 'weekdays',
    time: s?.time ?? '18:00',
    weekdays: s?.weekdays ?? [1],
    anchorDate: s?.anchorDate ?? todayPT(),
    days: s?.daysOfMonth?.length ? [...s.daysOfMonth] : [s?.dayOfMonth ?? 1],
    daysForm: !!s?.daysOfMonth?.length,
    workflowSlug: a?.workflowSlug ?? '',
    prompt: a?.prompt ?? '',
    inputs: Object.entries(a?.inputs ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    projectId: a?.projectId ?? '',
    model: a?.model ?? 'claude-opus-5-5',
    effort: a?.effort ?? 'high',
    enabled: a?.enabled ?? true,
  };
}

/** type="time" may give "9:05" or "09:05:00" depending on the browser → "HH:mm". */
function normTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : t.trim();
}

function toSchedule(d: Draft): ScheduleSpec {
  const s: ScheduleSpec = { kind: d.kind, time: normTime(d.time) };
  if (d.kind === 'weekly' || d.kind === 'biweekly') s.weekdays = [...d.weekdays].sort((x, y) => x - y);
  if (d.kind === 'biweekly') s.anchorDate = d.anchorDate;
  if (d.kind === 'monthly') {
    const days = [...new Set(d.days)].sort((x, y) => x - y);
    if (days.length > 1 || d.daysForm) s.daysOfMonth = days;
    else s.dayOfMonth = days[0] ?? 1;
  }
  return s;
}

/** "名称=值" per line → object; blank lines ignored. Returns an error string on a bad line. */
function parseInputs(text: string): Record<string, string> | null | string {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf('=');
    if (at <= 0) return `「${line}」要写成 名称=值。`;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

/** Create / edit one automation in the shared Modal. `target` null = closed. */
export function AutomationEditor({ target, onClose }: { target: AutomationDTO | 'new' | null; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = target && target !== 'new' ? target : null;
  const [d, setD] = useState<Draft>(() => toDraft(null));
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const open = target !== null;
  // What the form held when it opened: any difference = unsaved edits.
  const [initial, setInitial] = useState('');
  const dirty = open && JSON.stringify(d) !== initial;
  const { requestClose, confirm: discardConfirm } = useDiscardGuard(dirty, onClose);

  const workflows = useQuery({ queryKey: ['workflows'], queryFn: api.listWorkflows, enabled: open });
  const projects = useQuery({ queryKey: ['board', 'projects'], queryFn: api.boardProjects, enabled: open });

  useEffect(() => {
    if (!target) return;
    const start = toDraft(target === 'new' ? null : target);
    setD(start);
    setInitial(JSON.stringify(start));
    setErr(null);
    setBusy(null);
  }, [target]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const weekly = d.kind === 'weekly' || d.kind === 'biweekly';
  const sopOptions = (workflows.data ?? []).filter((w) => w.status !== 'archived');

  // Show the message and put the cursor on the field it's about.
  const fail = (msg: string, field: string) => {
    setErr(msg);
    const el = formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`);
    el?.focus();
  };

  const save = async () => {
    setErr(null);
    if (!d.name.trim()) return fail('请填写任务名', 'name');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normTime(d.time))) return fail('时间要写成 HH:mm', 'time');
    if (weekly && d.weekdays.length === 0) return fail('至少选一个星期几', 'weekday');
    if (d.kind === 'monthly' && d.days.length === 0) return fail('至少选一个日期', 'monthDay');
    if (!d.workflowSlug && !d.prompt.trim()) return fail('没有绑定 SOP 时，需要填写固定 prompt', 'prompt');
    const inputs = d.workflowSlug ? parseInputs(d.inputs) : null;
    if (typeof inputs === 'string') return fail(inputs, 'inputs');

    const body: AutomationInput = {
      name: d.name.trim(),
      schedule: toSchedule(d),
      workflowSlug: d.workflowSlug || null,
      prompt: d.prompt.trim() || null,
      inputs,
      projectId: d.projectId || null,
      model: d.model,
      effort: d.effort,
      enabled: d.enabled,
    };
    setBusy('save');
    try {
      if (editing) await api.updateAutomation(editing.id, body);
      else await api.createAutomation(body);
      await qc.invalidateQueries({ queryKey: ['board', 'automations'] });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!window.confirm(`删除「${editing.name}」？已经跑过的会话会保留。`)) return;
    setBusy('delete');
    try {
      await api.deleteAutomation(editing.id);
      await qc.invalidateQueries({ queryKey: ['board', 'automations'] });
      useStore.setState({ toast: { level: 'success', title: '已删除', body: editing.name, ts: Date.now() } });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
    <Modal
      open={open}
      onClose={requestClose}
      title={editing ? '编辑自动化任务' : '新建自动化任务'}
      footer={
        <>
          {editing && (
            <button type="button" className="btn btn--ghost mr-auto text-danger" onClick={remove} disabled={busy !== null}>
              {busy === 'delete' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}
              删除
            </button>
          )}
          <button type="button" className="btn btn--secondary" onClick={requestClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={busy !== null}>
            {busy === 'save' && <Loader2 size={16} className="animate-spin" aria-hidden />}
            {editing ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <form
        ref={formRef}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="任务名">
          {(id) => <input id={id} name="name" autoComplete="off" className="field" value={d.name} maxLength={60} onChange={(e) => set('name', e.target.value)} placeholder="例如：EOD 每日总结邮件…" />}
        </Field>

        <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
          <Field label="频率">
            {(id) => (
              <select id={id} name="kind" className="field" value={d.kind} onChange={(e) => set('kind', e.target.value as ScheduleSpec['kind'])}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="时间（PT）">
            {(id) => <input id={id} name="time" type="time" className="field tabular-nums" value={d.time} onChange={(e) => set('time', e.target.value)} />}
          </Field>
        </div>

        {weekly && (
          <fieldset>
            <legend className="label mb-1.5">星期几</legend>
            <div className="flex flex-wrap gap-1">
              {WEEK_ORDER.map((w) => {
                const on = d.weekdays.includes(w);
                return (
                  <button
                    key={w}
                    type="button"
                    name="weekday"
                    aria-pressed={on}
                    onClick={() => set('weekdays', on ? d.weekdays.filter((x) => x !== w) : [...d.weekdays, w])}
                    className={cn('btn btn--sm min-w-[3rem]', on ? 'btn--secondary border-accent text-accent' : 'btn--ghost')}
                  >
                    {WEEKDAY_NAMES[w]}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
        {d.kind === 'biweekly' && (
          <Field label="从哪一周算起" hint="这一天所在的那周算第一周，之后每隔一周运行">
            {(id) => <input id={id} name="anchorDate" type="date" className="field" value={d.anchorDate} onChange={(e) => set('anchorDate', e.target.value)} />}
          </Field>
        )}
        {d.kind === 'monthly' && (
          <fieldset>
            <legend className="label mb-1.5">每月几号（可多选）</legend>
            <div className="grid max-w-[22rem] grid-cols-7 gap-1">
              {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => {
                const on = d.days.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    name="monthDay"
                    aria-pressed={on}
                    aria-label={`${n} 号`}
                    onClick={() => set('days', on ? d.days.filter((x) => x !== n) : [...d.days, n])}
                    className={cn('btn btn--sm !px-0 tabular-nums', on ? 'btn--secondary border-accent text-accent' : 'btn--ghost')}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-muted">当月没有这一天时（如 31 号），在当月最后一天运行</p>
          </fieldset>
        )}
        <p className="-mt-2 text-xs text-muted">
          预览：
          {weekly && d.weekdays.length === 0
            ? '还没选星期几'
            : d.kind === 'monthly' && d.days.length === 0
              ? '还没选日期'
              : describeSchedule(toSchedule(d))}
        </p>

        <Field label="SOP" hint={d.workflowSlug ? '每次按当时最新的已确认版本执行' : '不绑定 SOP 的任务只能手动运行'}>
          {(id) => (
            <select id={id} name="workflowSlug" className="field" value={d.workflowSlug} onChange={(e) => set('workflowSlug', e.target.value)}>
              <option value="">不绑定，用固定 prompt</option>
              {sopOptions.map((w) => (
                <option key={w.slug} value={w.slug}>
                  {w.name}
                  {w.status === 'confirmed' && w.confirmedVersion ? '' : '（草稿，未确认）'}
                </option>
              ))}
            </select>
          )}
        </Field>

        {d.workflowSlug ? (
          <Field label="SOP 输入参数（可选）" hint="每行一个「名称=值」。可用占位符：{today} {yesterday} {prevWorkday}（上一个工作日）{MD} {MDYY} {weekStart} {weekEnd} {weekFri}（本周五），运行时换成 PT 日期。">
            {(id) => (
              <textarea id={id} name="inputs" rows={3} spellCheck={false} className="field resize-y font-mono text-xs" value={d.inputs} onChange={(e) => set('inputs', e.target.value)} placeholder="例如：column={MDYY} Updates…" />
            )}
          </Field>
        ) : (
          <Field label="固定 prompt" hint="作为新会话的第一条消息发出。同样可用 {today} {yesterday} {prevWorkday} {weekStart} {weekEnd} {weekFri} 等 PT 日期占位符。">
            {(id) => <textarea id={id} name="prompt" rows={5} className="field resize-y" value={d.prompt} onChange={(e) => set('prompt', e.target.value)} placeholder="例如：只回复 OK…" />}
          </Field>
        )}

        <Field label="归到项目">
          {(id) => (
            <select id={id} name="projectId" className="field" value={d.projectId} onChange={(e) => set('projectId', e.target.value)}>
              <option value="">不指定</option>
              {(projects.data?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="模型">
            {(id) => (
              <select id={id} name="model" className="field" value={d.model} onChange={(e) => set('model', e.target.value)}>
                {!MODEL_OPTIONS.some((m) => m.id === d.model) && <option value={d.model}>{d.model}</option>}
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="思考强度">
            {(id) => (
              <select id={id} name="effort" className="field" value={d.effort} onChange={(e) => set('effort', e.target.value)}>
                {EFFORT_LEVELS.map((e) => (
                  <option key={e} value={e}>
                    {effortLabel[e]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm">
          <span>
            启用
            <span className="block text-xs text-muted">停用后到点不会自动运行，仍可以手动「立即运行」</span>
          </span>
          <input type="checkbox" role="switch" name="enabled" className="switch" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        </label>

        {err && (
          <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
            {err}
          </p>
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
    {discardConfirm}
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label mb-1.5 block">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

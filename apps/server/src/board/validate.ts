import { EFFORT_LEVELS, type EffortLevel, type ScheduleSpec } from '@chapi/shared';

const KINDS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'] as const;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Validate a ScheduleSpec coming from the client (Chinese error messages). */
export function validateSchedule(raw: unknown): Checked<ScheduleSpec> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('频率格式不对。');
  const s = raw as Record<string, unknown>;
  const kind = s.kind as ScheduleSpec['kind'];
  if (!KINDS.includes(kind)) return bad('频率类型不对，只能是每天、工作日、每周、每两周或每月。');
  if (typeof s.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return bad('时间要写成 HH:mm，范围 00:00–23:59。');
  const out: ScheduleSpec = { kind, time: s.time };
  if (kind === 'weekly' || kind === 'biweekly') {
    const wd = s.weekdays;
    if (!Array.isArray(wd) || wd.length === 0 || !wd.every((n) => Number.isInteger(n) && n >= 0 && n <= 6)) {
      return bad('每周/每两周需要至少选一个星期几（0–6）。');
    }
    out.weekdays = [...new Set(wd as number[])].sort((a, b) => a - b);
  }
  if (kind === 'biweekly') {
    const a = s.anchorDate;
    if (typeof a !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a) || Number.isNaN(Date.parse(`${a}T00:00:00Z`))) {
      return bad('每两周需要起始日期（YYYY-MM-DD）。');
    }
    out.anchorDate = a;
  }
  if (kind === 'monthly') {
    const okDay = (d: unknown): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 31;
    if (s.daysOfMonth !== undefined) {
      const ds = s.daysOfMonth;
      if (!Array.isArray(ds) || ds.length === 0 || !ds.every(okDay)) return bad('每月需要至少选一个 1–31 的日期。');
      out.daysOfMonth = [...new Set(ds as number[])].sort((a, b) => a - b);
    } else {
      const d = s.dayOfMonth;
      if (!okDay(d)) return bad('每月需要填 1–31 的日期。');
      out.dayOfMonth = d;
    }
  }
  return { ok: true, value: out };
}

export function validateInputs(raw: unknown): Checked<Record<string, string> | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return bad('输入参数必须是 名称→文字 的对象。');
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') return bad('输入参数的值必须都是文字。');
  }
  return { ok: true, value: raw as Record<string, string> };
}

export function validateName(raw: unknown): Checked<string> {
  const n = typeof raw === 'string' ? raw.trim() : '';
  if (n.length < 1 || n.length > 60) return bad('任务名要 1–60 个字。');
  return { ok: true, value: n };
}

export function validateModel(raw: unknown): Checked<string> {
  const m = typeof raw === 'string' ? raw.trim() : '';
  if (m.length < 1 || m.length > 100) return bad('模型名要 1–100 个字符。');
  return { ok: true, value: m };
}

export function validateEffort(raw: unknown): Checked<EffortLevel> {
  if (typeof raw !== 'string' || !(EFFORT_LEVELS as readonly string[]).includes(raw)) {
    return bad(`思考强度只能是 ${EFFORT_LEVELS.join(' / ')}。`);
  }
  return { ok: true, value: raw as EffortLevel };
}

/** Key-order-insensitive JSON form, for "did the schedule actually change". */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function sameSchedule(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

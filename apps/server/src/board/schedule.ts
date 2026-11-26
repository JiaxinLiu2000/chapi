import type { ScheduleSpec } from '@chapi/shared';

/** Pure schedule math, all wall-clock in America/Los_Angeles. */

const TZ = 'America/Los_Angeles';
const DAY_MS = 86_400_000;

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

interface PtParts {
  y: number;
  m: number; // 1-12
  d: number;
}

function ptWallMs(ms: number): number {
  const p: Record<string, number> = {};
  const g = (k: string) => p[k] ?? 0;
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
}

function ptDate(date: Date): PtParts {
  const w = new Date(ptWallMs(date.getTime()));
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
}

/** PT wall clock -> UTC instant: guess an offset, then correct once (handles DST). */
function ptToUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let utc = wall - (ptWallMs(wall) - wall);
  utc = wall - (ptWallMs(utc) - utc);
  return new Date(utc);
}

/** Calendar-day number (days since epoch) for a PT date. */
const dayNum = (p: PtParts) => Math.round(Date.UTC(p.y, p.m - 1, p.d) / DAY_MS);
const fromDayNum = (n: number): PtParts => {
  const w = new Date(n * DAY_MS);
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
};
/** 0=Sun..6=Sat. 1970-01-01 was a Thursday. */
const weekdayOf = (n: number) => (((n + 4) % 7) + 7) % 7;
/** Day number of the Monday of n's Mon-Sun week. */
const mondayOf = (n: number) => n - ((weekdayOf(n) + 6) % 7);

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parseTime(time: string): [number, number] {
  const [h, m] = time.split(':').map(Number);
  return [h || 0, m || 0];
}

function anchorMonday(anchorDate: string): number {
  const [y, m, d] = anchorDate.split('-').map(Number);
  return mondayOf(dayNum({ y: y ?? 1970, m: m ?? 1, d: d ?? 1 }));
}

/** Days of the month a monthly spec fires on: daysOfMonth when set, else the single dayOfMonth. */
export function monthDays(spec: ScheduleSpec): number[] {
  const many = spec.daysOfMonth?.filter((n) => Number.isInteger(n) && n >= 1 && n <= 31) ?? [];
  const days = many.length ? many : [spec.dayOfMonth ?? 1];
  return [...new Set(days)].sort((a, b) => a - b);
}

function matchesDay(spec: ScheduleSpec, n: number): boolean {
  const wd = weekdayOf(n);
  switch (spec.kind) {
    case 'daily':
      return true;
    case 'weekdays':
      return wd >= 1 && wd <= 5;
    case 'weekly':
      return (spec.weekdays ?? []).includes(wd);
    case 'biweekly': {
      if (!spec.anchorDate || !(spec.weekdays ?? []).includes(wd)) return false;
      const weekIdx = (mondayOf(n) - anchorMonday(spec.anchorDate)) / 7;
      return weekIdx >= 0 && weekIdx % 2 === 0;
    }
    case 'monthly': {
      const p = fromDayNum(n);
      const last = daysInMonth(p.y, p.m);
      return monthDays(spec).some((day) => Math.min(day, last) === p.d);
    }
  }
}

function instantOn(spec: ScheduleSpec, n: number): Date {
  const p = fromDayNum(n);
  const [h, m] = parseTime(spec.time);
  return ptToUtc(p.y, p.m, p.d, h, m);
}

/** Next due instant strictly after `after`. */
export function nextDue(spec: ScheduleSpec, after: Date): Date {
  const start = dayNum(ptDate(after));
  for (let i = 0; i < 800; i++) {
    const n = start + i;
    if (!matchesDay(spec, n)) continue;
    const t = instantOn(spec, n);
    if (t.getTime() > after.getTime()) return t;
  }
  throw new Error('nextDue: no due time found for schedule');
}

/** Latest due instant <= `atOrBefore`, or null if none exists. */
export function lastDue(spec: ScheduleSpec, atOrBefore: Date): Date | null {
  const start = dayNum(ptDate(atOrBefore));
  for (let i = 0; i < 800; i++) {
    const n = start - i;
    if (!matchesDay(spec, n)) {
      // biweekly before its anchor week can never match: stop early
      if (spec.kind === 'biweekly' && spec.anchorDate) {
        if (n < anchorMonday(spec.anchorDate)) return null;
      }
      continue;
    }
    const t = instantOn(spec, n);
    if (t.getTime() <= atOrBefore.getTime()) return t;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (p: PtParts) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;

export function renderInputs(
  tpl: Record<string, string> | null,
  now: Date,
): Record<string, string> | undefined {
  if (!tpl) return undefined;
  const p = ptDate(now);
  const n = dayNum(p);
  const mon = mondayOf(n);
  // previous workday: Mon -> Fri (3 back), Sun -> Fri (2 back), otherwise the day before
  const wd = weekdayOf(n);
  const prevWorkday = n - (wd === 1 ? 3 : wd === 0 ? 2 : 1);
  const vars: Record<string, string> = {
    today: isoDate(p),
    MD: `${p.m}/${p.d}`,
    MDYY: `${p.m}/${p.d}/${pad(p.y % 100)}`,
    weekStart: isoDate(fromDayNum(mon)),
    weekEnd: isoDate(fromDayNum(mon + 6)),
    weekFri: isoDate(fromDayNum(mon + 4)),
    yesterday: isoDate(fromDayNum(n - 1)),
    prevWorkday: isoDate(fromDayNum(prevWorkday)),
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl)) {
    out[k] = v.replace(/\{(today|MDYY|MD|weekStart|weekEnd|weekFri|yesterday|prevWorkday)\}/g, (_, name: string) => vars[name] ?? '');
  }
  return out;
}

/** Same placeholders as renderInputs, inside free text (a no-SOP task's fixed prompt). */
export function renderTemplate(text: string, now: Date): string {
  return renderInputs({ t: text }, now)!.t!;
}

const WD_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function describeSchedule(spec: ScheduleSpec): string {
  const days = [...(spec.weekdays ?? [])]
    .sort((a, b) => a - b)
    .map((w) => WD_NAMES[w])
    .join('、');
  switch (spec.kind) {
    case 'daily':
      return `每天 ${spec.time}`;
    case 'weekdays':
      return `每个工作日 ${spec.time}`;
    case 'weekly':
      return `每周 ${days} ${spec.time}`;
    case 'biweekly':
      return `每两周 ${days} ${spec.time}`;
    case 'monthly':
      return `每月 ${monthDays(spec).join('、')} 日 ${spec.time}`;
  }
}

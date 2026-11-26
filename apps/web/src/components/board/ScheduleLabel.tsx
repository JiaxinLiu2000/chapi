import type { ScheduleSpec } from '@chapi/shared';

/** Same wording as the server's describeSchedule (apps/server/src/board/schedule.ts). */
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Monthly days: daysOfMonth when set, else the single dayOfMonth (same rule as the server). */
function monthDays(spec: ScheduleSpec): number[] {
  const many = spec.daysOfMonth?.filter((n) => Number.isInteger(n) && n >= 1 && n <= 31) ?? [];
  return [...new Set(many.length ? many : [spec.dayOfMonth ?? 1])].sort((a, b) => a - b);
}

export function describeSchedule(spec: ScheduleSpec): string {
  const days = [...(spec.weekdays ?? [])]
    .sort((a, b) => a - b)
    .map((w) => WEEKDAY_NAMES[w])
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

const TZ = 'America/Los_Angeles';
const ptParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
});
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parts(d: Date) {
  const p: Record<string, string> = {};
  for (const x of ptParts.formatToParts(d)) if (x.type !== 'literal') p[x.type] = x.value;
  return p;
}

/** "今天 18:00" / "明天 09:00" / "周三 10:00"（7 天内）/ "11/24 18:00" — always Pacific time. */
export function formatPT(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const p = parts(d);
  const time = `${p.hour}:${p.minute}`;
  const dayKey = (x: Record<string, string>) => Date.UTC(Number(x.year), Number(x.month) - 1, Number(x.day));
  const diffDays = Math.round((dayKey(p) - dayKey(parts(now))) / 86400000);
  if (diffDays === 0) return `今天 ${time}`;
  if (diffDays === 1) return `明天 ${time}`;
  if (diffDays === -1) return `昨天 ${time}`;
  if (diffDays > 1 && diffDays < 7) return `${WEEKDAY_NAMES[WD_EN.indexOf(p.weekday ?? '')] ?? ''} ${time}`;
  return `${p.month}/${p.day} ${time}`;
}

/** Full PT timestamp for tooltips: "2026/11/24 18:00 PT". */
export function formatPTFull(iso: string): string {
  const p = parts(new Date(iso));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute} PT`;
}

/** Today's PT date as YYYY-MM-DD (default anchor for a new biweekly schedule). */
export function todayPT(): string {
  const p = parts(new Date());
  return `${p.year}-${p.month!.padStart(2, '0')}-${p.day!.padStart(2, '0')}`;
}

export function ScheduleLabel({ spec, className }: { spec: ScheduleSpec; className?: string }) {
  return (
    <span className={className} title="太平洋时间（PT）">
      {describeSchedule(spec)}
    </span>
  );
}

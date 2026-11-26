import { describe, expect, it } from 'vitest';
import { describeSchedule, lastDue, nextDue, renderInputs } from './schedule.js';

const d = (s: string) => new Date(s);

describe('nextDue', () => {
  it('daily: later same day', () => {
    expect(nextDue({ kind: 'daily', time: '18:00' }, d('2026-11-24T10:00:00-08:00')).toISOString()).toBe(
      d('2026-11-24T18:00:00-08:00').toISOString(),
    );
  });

  it('daily: across spring-forward DST day', () => {
    expect(nextDue({ kind: 'daily', time: '18:00' }, d('2027-03-13T19:00:00-08:00')).toISOString()).toBe(
      d('2027-03-14T18:00:00-07:00').toISOString(),
    );
  });

  it('daily: across fall-back DST day (2026-11-01)', () => {
    expect(nextDue({ kind: 'daily', time: '18:00' }, d('2026-10-31T19:00:00-07:00')).toISOString()).toBe(
      d('2026-11-01T18:00:00-08:00').toISOString(),
    );
  });

  it('strictly after: exactly at a due instant returns the next one', () => {
    const at = d('2026-11-24T18:00:00-08:00');
    expect(nextDue({ kind: 'daily', time: '18:00' }, at).toISOString()).toBe(
      d('2026-11-25T18:00:00-08:00').toISOString(),
    );
  });

  it('weekdays: Friday evening -> next Monday', () => {
    // 2026-11-27 is a Friday
    expect(nextDue({ kind: 'weekdays', time: '18:00' }, d('2026-11-27T19:00:00-08:00')).toISOString()).toBe(
      d('2026-11-30T18:00:00-08:00').toISOString(),
    );
  });

  it('weekly: multiple weekdays', () => {
    // Tue 2026-11-24 10:00 -> Thu (4) 11-26 09:00
    expect(
      nextDue({ kind: 'weekly', time: '09:00', weekdays: [1, 4] }, d('2026-11-24T10:00:00-08:00')).toISOString(),
    ).toBe(d('2026-11-26T09:00:00-08:00').toISOString());
  });

  it('biweekly: skips the odd week', () => {
    const spec = { kind: 'biweekly' as const, weekdays: [3], anchorDate: '2026-11-18', time: '09:00' };
    expect(nextDue(spec, d('2026-11-19T12:00:00-08:00')).toISOString()).toBe(
      d('2026-12-02T09:00:00-08:00').toISOString(),
    );
  });

  it('biweekly: after is before the anchor week -> first fire is in week 0', () => {
    const spec = { kind: 'biweekly' as const, weekdays: [3], anchorDate: '2026-11-18', time: '09:00' };
    expect(nextDue(spec, d('2026-11-01T12:00:00-08:00')).toISOString()).toBe(
      d('2026-11-18T09:00:00-08:00').toISOString(),
    );
  });

  it('monthly: dayOfMonth 31 clamps to Feb 28', () => {
    const spec = { kind: 'monthly' as const, dayOfMonth: 31, time: '09:00' };
    expect(nextDue(spec, d('2027-02-01T00:00:00-08:00')).toISOString()).toBe(
      d('2027-02-28T09:00:00-08:00').toISOString(),
    );
  });
});

describe('lastDue', () => {
  it('daily: before today due -> yesterday', () => {
    expect(lastDue({ kind: 'daily', time: '18:00' }, d('2026-11-24T17:59:00-08:00'))?.toISOString()).toBe(
      d('2026-11-23T18:00:00-08:00').toISOString(),
    );
  });

  it('inclusive at the due instant', () => {
    expect(lastDue({ kind: 'daily', time: '18:00' }, d('2026-11-24T18:00:00-08:00'))?.toISOString()).toBe(
      d('2026-11-24T18:00:00-08:00').toISOString(),
    );
  });

  it('biweekly: before the anchor week -> null', () => {
    const spec = { kind: 'biweekly' as const, weekdays: [3], anchorDate: '2026-11-18', time: '09:00' };
    expect(lastDue(spec, d('2026-11-10T12:00:00-08:00'))).toBeNull();
  });

  it('biweekly: in odd week returns previous even-week fire', () => {
    const spec = { kind: 'biweekly' as const, weekdays: [3], anchorDate: '2026-11-18', time: '09:00' };
    expect(lastDue(spec, d('2026-11-26T12:00:00-08:00'))?.toISOString()).toBe(
      d('2026-11-18T09:00:00-08:00').toISOString(),
    );
  });

  it('monthly: clamps in short month', () => {
    const spec = { kind: 'monthly' as const, dayOfMonth: 31, time: '09:00' };
    expect(lastDue(spec, d('2027-03-05T00:00:00-08:00'))?.toISOString()).toBe(
      d('2027-02-28T09:00:00-08:00').toISOString(),
    );
  });
});

describe('renderInputs', () => {
  it('returns undefined for null', () => {
    expect(renderInputs(null, new Date())).toBeUndefined();
  });

  it('replaces {MDYY}', () => {
    expect(renderInputs({ col: '{MDYY} Updates' }, d('2026-11-25T12:00:00Z'))).toEqual({ col: '11/25/26 Updates' });
  });

  it('replaces today / MD / weekStart / weekEnd in PT', () => {
    // 2026-11-25T03:00Z is still Tue 11-24 in PT (Tuesday); week Mon 11-23 .. Sun 11-29
    expect(
      renderInputs({ a: '{today}', b: '{MD}', c: '{weekStart}', e: '{weekEnd}' }, d('2026-11-25T03:00:00Z')),
    ).toEqual({ a: '2026-11-24', b: '11/24', c: '2026-11-23', e: '2026-11-29' });
  });

  it('weekStart on a Sunday is the previous Monday', () => {
    expect(renderInputs({ c: '{weekStart}', e: '{weekEnd}' }, d('2026-11-29T12:00:00-08:00'))).toEqual({
      c: '2026-11-23',
      e: '2026-11-29',
    });
  });

  it('{weekFri} is the Friday of the PT Mon–Sun week, also in free text', async () => {
    const { renderTemplate } = await import('./schedule.js');
    // Fri 2026-11-27 19:30 PT (the Sales 周报 slot) → Mon 11-23 .. Fri 11-27
    expect(renderTemplate('本周一 {weekStart} 至本周五 {weekFri}', d('2026-11-27T19:30:00-08:00'))).toBe('本周一 2026-11-23 至本周五 2026-11-27');
    expect(renderInputs({ f: '{weekFri}' }, d('2026-11-29T12:00:00-08:00'))).toEqual({ f: '2026-11-27' });
  });
});

describe('renderInputs: yesterday / prevWorkday', () => {
  it('Tuesday -> yesterday Monday, prevWorkday Monday', () => {
    expect(renderInputs({ y: '{yesterday}', p: '{prevWorkday}' }, d('2026-11-24T10:00:00-08:00'))).toEqual({ y: '2026-11-23', p: '2026-11-23' });
  });

  it('Monday -> yesterday Sunday, prevWorkday last Friday', () => {
    expect(renderInputs({ y: '{yesterday}', p: '{prevWorkday}' }, d('2026-11-30T10:00:00-08:00'))).toEqual({ y: '2026-11-29', p: '2026-11-27' });
  });

  it('Sunday and Saturday -> prevWorkday Friday', () => {
    expect(renderInputs({ p: '{prevWorkday}' }, d('2026-11-29T10:00:00-08:00'))).toEqual({ p: '2026-11-27' });
    expect(renderInputs({ p: '{prevWorkday}' }, d('2026-11-28T10:00:00-08:00'))).toEqual({ p: '2026-11-27' });
  });

  it('uses the PT date (03:00Z Tuesday is still Monday in PT)', () => {
    expect(renderInputs({ y: '{yesterday}', p: '{prevWorkday}' }, d('2026-11-24T03:00:00Z'))).toEqual({ y: '2026-11-22', p: '2026-11-20' });
  });
});

describe('describeSchedule', () => {
  it('describes each kind', () => {
    expect(describeSchedule({ kind: 'daily', time: '18:00' })).toBe('每天 18:00');
    expect(describeSchedule({ kind: 'weekdays', time: '18:00' })).toBe('每个工作日 18:00');
    expect(describeSchedule({ kind: 'weekly', time: '09:00', weekdays: [1, 4] })).toBe('每周 周一、周四 09:00');
    expect(describeSchedule({ kind: 'biweekly', time: '09:00', weekdays: [3], anchorDate: '2026-11-18' })).toBe(
      '每两周 周三 09:00',
    );
    expect(describeSchedule({ kind: 'monthly', time: '09:00', dayOfMonth: 15 })).toBe('每月 15 日 09:00');
  });

  it('monthly with several days', () => {
    expect(describeSchedule({ kind: 'monthly', time: '09:00', daysOfMonth: [25, 10] })).toBe('每月 10、25 日 09:00');
    expect(describeSchedule({ kind: 'monthly', time: '09:00', daysOfMonth: [1] })).toBe('每月 1 日 09:00');
  });
});

describe('monthly daysOfMonth', () => {
  const spec = { kind: 'monthly' as const, daysOfMonth: [10, 25], time: '09:00' };

  it('nextDue: between the two days -> the 25th', () => {
    expect(nextDue(spec, d('2026-11-12T12:00:00-08:00')).toISOString()).toBe(d('2026-11-25T09:00:00-08:00').toISOString());
  });

  it('nextDue: after the 25th -> next month 10th', () => {
    expect(nextDue(spec, d('2026-11-25T09:00:00-08:00')).toISOString()).toBe(d('2026-12-10T09:00:00-08:00').toISOString());
  });

  it('lastDue: before the 10th -> previous month 25th', () => {
    expect(lastDue(spec, d('2026-12-05T12:00:00-08:00'))?.toISOString()).toBe(d('2026-11-25T09:00:00-08:00').toISOString());
  });

  it('days past the month end clamp to the last day (deduplicated)', () => {
    const s2 = { kind: 'monthly' as const, daysOfMonth: [15, 30, 31], time: '09:00' };
    expect(nextDue(s2, d('2027-02-16T00:00:00-08:00')).toISOString()).toBe(d('2027-02-28T09:00:00-08:00').toISOString());
    expect(nextDue(s2, d('2027-02-28T09:00:00-08:00')).toISOString()).toBe(d('2027-03-15T09:00:00-07:00').toISOString());
  });

  it('daysOfMonth wins over dayOfMonth when both are set', () => {
    const s3 = { kind: 'monthly' as const, dayOfMonth: 3, daysOfMonth: [20], time: '09:00' };
    expect(nextDue(s3, d('2026-11-01T00:00:00-08:00')).toISOString()).toBe(d('2026-11-20T09:00:00-08:00').toISOString());
  });
});

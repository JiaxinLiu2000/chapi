import { describe, expect, it } from 'vitest';
import { validateSchedule } from './validate.js';

describe('validateSchedule: monthly daysOfMonth', () => {
  it('accepts several days, dedupes and sorts them', () => {
    const r = validateSchedule({ kind: 'monthly', time: '09:00', daysOfMonth: [25, 10, 25] });
    expect(r).toEqual({ ok: true, value: { kind: 'monthly', time: '09:00', daysOfMonth: [10, 25] } });
  });

  it('keeps the old single dayOfMonth form', () => {
    expect(validateSchedule({ kind: 'monthly', time: '09:00', dayOfMonth: 15 })).toEqual({
      ok: true,
      value: { kind: 'monthly', time: '09:00', dayOfMonth: 15 },
    });
  });

  it('rejects empty, out-of-range or non-integer days', () => {
    for (const daysOfMonth of [[], [0], [32], [1.5], ['10'], 'x']) {
      const r = validateSchedule({ kind: 'monthly', time: '09:00', daysOfMonth });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects monthly with neither form', () => {
    expect(validateSchedule({ kind: 'monthly', time: '09:00' }).ok).toBe(false);
  });

  it('daysOfMonth is ignored for non-monthly kinds', () => {
    expect(validateSchedule({ kind: 'daily', time: '09:00', daysOfMonth: [3] })).toEqual({ ok: true, value: { kind: 'daily', time: '09:00' } });
  });
});

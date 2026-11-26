import { describe, expect, it } from 'vitest';
import type { EvidenceField } from '@chapi/shared';
import { checkEvidence, checkReview } from './validate.js';

const F: EvidenceField[] = [
  { key: 'needs_refind', type: 'int' },
  { key: 'report', type: 'path' },
  { key: 'note', type: 'string', required: false },
];

describe('checkEvidence', () => {
  it('coerces "4" to 4 for int', () => {
    const r = checkEvidence(F, { needs_refind: '4', report: '/x/a.csv' });
    expect(r).toEqual({ ok: true, value: { needs_refind: 4, report: '/x/a.csv' } });
  });

  it('reports every missing required field at once', () => {
    const r = checkEvidence(F, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(2);
      expect(r.errors.join('\n')).toContain('needs_refind');
      expect(r.errors.join('\n')).toContain('report');
    }
  });

  it('rejects 4.5 for int', () => {
    expect(checkEvidence(F, { needs_refind: 4.5, report: 'a' }).ok).toBe(false);
  });

  it('rejects "" for path', () => {
    expect(checkEvidence(F, { needs_refind: 1, report: '  ' }).ok).toBe(false);
  });

  it('allows optional field to be absent and keeps extra fields', () => {
    const r = checkEvidence(F, { needs_refind: 0, report: 'a', extra: [1] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.extra).toEqual([1]);
  });

  it('checks bool / list / number types', () => {
    const G: EvidenceField[] = [
      { key: 'b', type: 'bool' },
      { key: 'l', type: 'list' },
      { key: 'n', type: 'number' },
    ];
    expect(checkEvidence(G, { b: true, l: [], n: 1.5 }).ok).toBe(true);
    const bad = checkEvidence(G, { b: 'yes', l: 'x', n: 'NaN' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveLength(3);
  });

  it('rejects a non-object evidence', () => {
    expect(checkEvidence(F, 'hello').ok).toBe(false);
  });
});

describe('checkReview', () => {
  const C = ['每个缺口都查过 biscred', '仍缺的写明原因'];

  it('accepts a verdict for every criterion', () => {
    expect(
      checkReview(C, [
        { criterion: '每个缺口都查过 biscred', verdict: 'met', reason: '证据 biscred_checked=4 与名单一致' },
        { criterion: '仍缺的写明原因', verdict: 'na', reason: '本批没有仍缺的人' },
      ]),
    ).toEqual({ ok: true });
  });

  it('fails when a criterion has no verdict', () => {
    const r = checkReview(C, [{ criterion: '每个缺口都查过 biscred', verdict: 'met', reason: '已核对文件' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('仍缺的写明原因');
  });

  it('accepts "第2条" style keys', () => {
    expect(
      checkReview(C, [
        { criterion: '第1条', verdict: 'met', reason: '已核对文件' },
        { criterion: '第2条', verdict: 'met', reason: '已核对文件' },
      ]).ok,
    ).toBe(true);
  });

  it('rejects reason shorter than 4 chars', () => {
    const r = checkReview(C, [
      { criterion: '第1条', verdict: 'met', reason: 'ok' },
      { criterion: '第2条', verdict: 'met', reason: '已核对文件' },
    ]);
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown criterion', () => {
    const r = checkReview(C, [
      { criterion: '第1条', verdict: 'met', reason: '已核对文件' },
      { criterion: '第2条', verdict: 'met', reason: '已核对文件' },
      { criterion: '第3条', verdict: 'met', reason: '已核对文件' },
    ]);
    expect(r.ok).toBe(false);
  });
});

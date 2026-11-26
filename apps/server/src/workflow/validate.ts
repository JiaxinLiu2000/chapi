import type { CriterionVerdict, EvidenceField } from '@chapi/shared';

/** Validate a stage's submitted evidence against its declared fields; every problem at once. */
export function checkEvidence(
  fields: EvidenceField[],
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['evidence 必须是一个对象（字段名 → 值）'] };
  }
  const src = input as Record<string, unknown>;
  const value: Record<string, unknown> = { ...src };
  const errors: string[] = [];
  for (const f of fields) {
    const v = src[f.key];
    const absent = v === undefined || v === null || (typeof v === 'string' && !v.trim());
    if (absent) {
      if (f.required !== false) errors.push(`缺少必填字段 ${f.key}（${f.type}${f.desc ? `：${f.desc}` : ''}）`);
      delete value[f.key];
      continue;
    }
    const bad = (want: string) => errors.push(`字段 ${f.key} 应为 ${want}，收到 ${JSON.stringify(v).slice(0, 80)}`);
    switch (f.type) {
      case 'int': {
        const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v;
        if (typeof n === 'number' && Number.isInteger(n)) value[f.key] = n;
        else bad('整数');
        break;
      }
      case 'number': {
        const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
        if (typeof n === 'number' && Number.isFinite(n)) value[f.key] = n;
        else bad('数字');
        break;
      }
      case 'bool':
        if (typeof v !== 'boolean') bad('true/false');
        break;
      case 'list':
        if (!Array.isArray(v)) bad('列表（数组）');
        break;
      case 'string':
      case 'path':
        if (typeof v === 'string') value[f.key] = v.trim();
        else bad(f.type === 'path' ? '文件路径或链接（字符串）' : '文本');
        break;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

const MIN_REASON = 4;

/** The main AI's review must judge every done-criterion (by exact text or "第N条"), each with a reason. */
export function checkReview(criteria: string[], perCriterion: CriterionVerdict[]): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const norm = (s: string) => s.replace(/\s+/g, '');
  const indexOf = (key: string): number => {
    const m = /^第\s*(\d+)\s*条$/.exec(key.trim());
    if (m) {
      const i = Number(m[1]) - 1;
      return i >= 0 && i < criteria.length ? i : -1;
    }
    return criteria.findIndex((c) => norm(c) === norm(key));
  };
  const covered = new Set<number>();
  for (const v of perCriterion ?? []) {
    const i = indexOf(v.criterion ?? '');
    if (i < 0) {
      errors.push(`没有这条完成标准：「${v.criterion}」（用原文或"第N条"）`);
      continue;
    }
    covered.add(i);
    if (v.verdict !== 'met' && v.verdict !== 'na') errors.push(`第${i + 1}条的判断只能是 met 或 na`);
    if (norm(v.reason ?? '').length < MIN_REASON) errors.push(`第${i + 1}条「${criteria[i]}」需要写依据（至少 ${MIN_REASON} 个字）`);
  }
  criteria.forEach((c, i) => {
    if (!covered.has(i)) errors.push(`没有判断第${i + 1}条完成标准：「${c}」`);
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}

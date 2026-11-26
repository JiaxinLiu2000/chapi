import { describe, expect, it } from 'vitest';
import { buildDigest, detectStuck, dropRepeats, MAX_NOTES_PER_REVIEW, noteKey, parseVerdict, routeNote, similarKeys } from './quality.js';

describe('parseVerdict', () => {
  it('parses notes, sorts blockers first and caps the count', () => {
    const v = parseVerdict(
      'here you go: ' +
        JSON.stringify({
          score: 72,
          summary: 'ok-ish',
          notes: [
            { severity: 'nit', title: 'a', note: 'minor wording' },
            { severity: 'blocker', title: 'b', note: 'wrong building in row 3' },
            { severity: 'concern', title: 'c', note: 'source is 2 years old' },
            { severity: 'concern', title: 'd', note: 'missing unit count' },
          ],
        }),
    );
    expect(v).not.toBeNull();
    expect(v!.score).toBe(72);
    expect(v!.notes).toHaveLength(MAX_NOTES_PER_REVIEW);
    expect(v!.notes.map((n) => n.severity)).toEqual(['blocker', 'concern', 'concern']);
  });

  it('drops noise notes and maps legacy issues/high-medium-low', () => {
    const v = parseVerdict(
      JSON.stringify({
        score: 90,
        summary: 'fine',
        issues: [
          { severity: 'high', where: 'x.csv', problem: 'duplicated rows', fix: 'dedupe' },
          { severity: 'low', problem: 'LGTM' },
        ],
      }),
    );
    expect(v!.notes).toHaveLength(1);
    expect(v!.notes[0]).toMatchObject({ severity: 'blocker', where: 'x.csv', fix: 'dedupe' });
  });

  it('returns null for non-JSON output', () => {
    expect(parseVerdict('no json here')).toBeNull();
  });
});

describe('routeNote', () => {
  it('while working only blockers interrupt; concerns wait for the turn end; nits ride along', () => {
    expect(routeNote('blocker', true)).toBe('steer');
    expect(routeNote('concern', true)).toBe('turnEnd');
    expect(routeNote('nit', true)).toBe('aside');
  });
  it('nothing interrupts or starts a turn when the agent is not working', () => {
    for (const sev of ['nit', 'concern', 'blocker'] as const) expect(routeNote(sev, false)).toBe('preserve');
  });
});

describe('dropRepeats', () => {
  const prior = [{ key: noteKey('沙盘缺少审核修订版的生成脚本'), severity: 'concern' as const }];
  it('drops a reworded repeat at the same or lower severity', () => {
    const r = dropRepeats(
      [
        { title: '沙盘缺少审核修订版生成脚本！', severity: 'concern' as const },
        { title: '沙盘缺少审核修订版的生成脚本', severity: 'nit' as const },
      ],
      prior,
    );
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(2);
  });
  it('lets an escalation and a new issue through', () => {
    const r = dropRepeats(
      [
        { title: '沙盘缺少审核修订版的生成脚本', severity: 'blocker' as const },
        { title: '电话号码格式带了 +1 前缀', severity: 'concern' as const },
      ],
      prior,
    );
    expect(r.kept.map((n) => n.severity)).toEqual(['blocker', 'concern']);
  });
  it('similarKeys is not fooled by short overlaps', () => {
    expect(similarKeys(noteKey('数据未核实'), noteKey('数据格式'))).toBe(false);
  });
});

describe('detectStuck', () => {
  const call = (i: number, name: string, input: string, status?: string, error?: string) => ({ id: `t${i}`, name, input, status, error });
  it('flags the same call four times in a row', () => {
    const h = [1, 2, 3, 4].map((i) => call(i, 'Bash', 'curl https://x/status', 'success'));
    expect(detectStuck(h)?.signature).toMatch(/^repeat:Bash/);
    expect(detectStuck(h.slice(0, 3))).toBeNull();
  });
  it('flags the same error three times even with different inputs (numbers ignored)', () => {
    const h = [
      call(1, 'mcp__google_workspace__read_sheet_values', 'A1:B2', 'error', 'HttpError 403 quota exceeded for 12'),
      call(2, 'Read', 'x.md', 'success'),
      call(3, 'mcp__google_workspace__read_sheet_values', 'A1:B3', 'error', 'HttpError 403 quota exceeded for 13'),
      call(4, 'mcp__google_workspace__read_sheet_values', 'A1:B4', 'error', 'HttpError 403 quota exceeded for 14'),
    ];
    expect(detectStuck(h)?.reason).toContain('HttpError');
  });
  it('ignores waiting/bookkeeping tools', () => {
    const h = [1, 2, 3, 4].map((i) => call(i, 'mcp__chapi__ask_user', '{"q":"x"}'));
    expect(detectStuck(h)).toBeNull();
  });
});

describe('buildDigest', () => {
  const base = {
    goal: 'Find rent comps',
    laterAsks: [],
    plan: [],
    artifacts: [],
    messages: [],
    delivered: [],
    sandbox: '/tmp/sb',
    firstReview: false,
  };

  it('shows failed tool results by their first error line only', () => {
    const d = buildDigest({
      ...base,
      tools: [
        { name: 'Bash', input: 'python scrape.py', status: 'error', output: '\nTraceback: boom\nmore' },
        { name: 'Read', input: 'a.csv', status: 'done', output: 'x'.repeat(50) },
      ],
    });
    expect(d).toContain('Bash(python scrape.py) ✗ Traceback: boom');
    expect(d).not.toContain('more');
    expect(d).toContain('Read(a.csv) ✓ [50 字]');
  });

  it('stays within budget by dropping the oldest activity', () => {
    const messages = Array.from({ length: 80 }, (_, i) => ({
      role: 'assistant',
      type: 'assistant',
      text: `msg-${i} ` + 'y'.repeat(1400),
    }));
    const d = buildDigest({ ...base, messages, tools: [] });
    expect(d.length).toBeLessThan(40_000);
    expect(d).toContain('msg-79');
    expect(d).not.toContain('msg-0 ');
  });
});

describe('buildDigest extras', () => {
  const base = {
    goal: 'Update the tracker',
    laterAsks: [],
    plan: [],
    artifacts: [],
    messages: [],
    tools: [],
    delivered: [],
    sandbox: '/tmp/s',
    firstReview: false,
  };
  it('puts the gate, the guide and the in-progress note in front of the advisor', () => {
    const d = buildDigest({
      ...base,
      guide: '- 改表前先读当前内容',
      prefs: '## 用户的偏好与相关经验\n- RAW 模式',
      gate: { summary: '表格已更新 40 行', artifacts: ['- sheet「Tracker」https://x'] },
    });
    expect(d).toContain('交付前把关');
    expect(d).toContain('表格已更新 40 行');
    expect(d).toContain('改表前先读当前内容');
    expect(d).toContain('RAW 模式');
    expect(buildDigest({ ...base, inProgress: true })).toContain('仍在工作中');
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeTag, tagKey } from '../knowledge/tags.js';
import { isSystemInjected, parseProposals, scoreDataSources } from './learner.js';

describe('learning agent', () => {
  it('parses proposals and drops invalid ones', () => {
    const r = parseProposals(
      'ok ```json\n' +
        JSON.stringify({
          intent: 'correction',
          points: [
            { op: 'create', kind: 'preference', title: 'Tables: English headers', situation: 's', solution: 'x', tags: ['Google Sheets'] },
            { op: 'reinforce', kind: 'skill', title: 'x', targetId: 'abc' },
            { op: 'nonsense', kind: 'skill', title: 'bad op' },
            { op: 'create', kind: 'opinion', title: 'bad kind' },
            { op: 'create', kind: 'data', title: '' },
          ],
        }) +
        '\n```',
    );
    expect(r.intent).toBe('correction');
    expect(r.points.map((p) => p.op)).toEqual(['create', 'reinforce']);
    expect(r.points[1]!.targetId).toBe('abc');
  });

  it('sanitizes titles for file names', () => {
    const r = parseProposals(JSON.stringify({ points: [{ op: 'create', kind: 'skill', title: 'a/b: c?' }] }));
    expect(r.points[0]!.title).toBe('a-b- c-');
  });

  it('stacks confidence across different sources for the same data', () => {
    const one = scoreDataSources([{ url: 'https://www.zillow.com/a', publishedAt: '2026-10-10' }], 'fast');
    const two = scoreDataSources(
      [
        { url: 'https://www.zillow.com/a', publishedAt: '2026-10-10' },
        { url: 'https://www.apartments.com/b', publishedAt: '2026-10-12' },
      ],
      'fast',
    );
    expect(two.score).toBeGreaterThan(one.score);
    expect(two.refs).toHaveLength(2);
    expect(two.refs[0]).toMatchObject({ kind: 'web', tier: 'aggregator', date: '2026-10-10' });
    const user = scoreDataSources([{ url: 'user' }], undefined);
    expect(user.refs[0]!.kind).toBe('user');
  });

  it('recognizes platform-injected messages', () => {
    expect(isSystemInjected('[质检反馈] x')).toBe(true);
    expect(isSystemInjected('[定时任务] 现在执行')).toBe(true);
    expect(isSystemInjected('[工作流] 已启动「BI SOP」')).toBe(true);
    expect(isSystemInjected('帮我改一下表格')).toBe(false);
  });
});

describe('tag cache', () => {
  it('normalizes spellings that mean the same tag', () => {
    expect(normalizeTag('#Google Sheets')).toBe('google-sheets');
    expect(tagKey('Google Sheets')).toBe(tagKey('google_sheet'));
    expect(tagKey('google-sheets')).toBe(tagKey('googlesheet'));
    expect(tagKey('学生公寓')).toBe('学生公寓');
    expect(tagKey('apartments.com')).not.toBe(tagKey('apartment'));
  });
});

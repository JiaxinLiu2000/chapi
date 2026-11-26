import { describe, expect, it } from 'vitest';
import { cleanTitle, displayWidth, TITLE_MAX_WIDTH } from './title.js';

describe('displayWidth', () => {
  it('counts CJK as 2 and Latin as 1', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('联网搜索')).toBe(8);
    expect(displayWidth('AI 竞品')).toBe(7);
  });
});

describe('cleanTitle', () => {
  it('keeps a short title as-is', () => {
    expect(cleanTitle('美国地产活动汇总')).toBe('美国地产活动汇总');
  });

  it('takes the first line and strips prefixes, quotes and trailing periods', () => {
    expect(cleanTitle('\n标题：「Bisnow 参会者联系方式查找」。\n其他说明')).toBe('Bisnow 参会者联系方式查找');
    expect(cleanTitle('Title: "Moxie USC property list."')).toBe('Moxie USC property list');
    expect(cleanTitle('**洛杉矶项目进度调研**')).toBe('洛杉矶项目进度调研');
  });

  it('fits an overlong CJK title in the width budget without an ellipsis', () => {
    const t = cleanTitle('这是一个非常非常非常非常非常非常长的对话标题需要被截短才能放下');
    expect(displayWidth(t)).toBeLessThanOrEqual(TITLE_MAX_WIDTH);
    expect(t.endsWith('…')).toBe(false);
  });

  it('cuts overlong Latin titles at a word boundary', () => {
    const t = cleanTitle('Verify customer emails and build a deliverability report table');
    expect(displayWidth(t)).toBeLessThanOrEqual(TITLE_MAX_WIDTH);
    expect('Verify customer emails and build a deliverability report table'.startsWith(t)).toBe(true);
    expect(t).not.toMatch(/\s$/);
    expect(t.split(' ').every((w) => 'Verify customer emails and build a deliverability report table'.split(' ').includes(w))).toBe(true);
  });

  it('returns empty for an empty reply', () => {
    expect(cleanTitle('  \n ')).toBe('');
  });
});

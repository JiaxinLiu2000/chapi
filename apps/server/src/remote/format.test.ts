import { describe, expect, it } from 'vitest';
import { chunkText, discordSafe, parseApprovalReply, parseCommand, parseOptionPick, pushHeader, tagForIndex, toPlainText } from './format.js';

describe('parseOptionPick', () => {
  it('accepts bare and decorated numbers, full-width too', () => {
    expect(parseOptionPick('2', 3)).toEqual([1]);
    expect(parseOptionPick(' 选2 ', 3)).toEqual([1]);
    expect(parseOptionPick('第3个', 3)).toEqual([2]);
    expect(parseOptionPick('２', 3)).toEqual([1]);
    expect(parseOptionPick('1，3', 3)).toEqual([0, 2]);
    expect(parseOptionPick('1 3', 3)).toEqual([0, 2]);
  });
  it('rejects out-of-range or anything with extra words', () => {
    expect(parseOptionPick('4', 3)).toBeNull();
    expect(parseOptionPick('0', 3)).toBeNull();
    expect(parseOptionPick('2 但是改成周五', 3)).toBeNull();
    expect(parseOptionPick('第二个', 3)).toBeNull();
  });
});

describe('parseApprovalReply', () => {
  it('bare approve / reject words decide', () => {
    expect(parseApprovalReply('1')).toEqual({ decision: 'approve' });
    expect(parseApprovalReply('可以！')).toEqual({ decision: 'approve' });
    expect(parseApprovalReply('OK')).toEqual({ decision: 'approve' });
    expect(parseApprovalReply('2')).toEqual({ decision: 'reject' });
    expect(parseApprovalReply('驳回')).toEqual({ decision: 'reject' });
  });
  it('anything else is revise with the feedback text', () => {
    expect(parseApprovalReply('3 标题改短点')).toEqual({ decision: 'revise', feedback: '标题改短点' });
    expect(parseApprovalReply('修改：第二页数字不对')).toEqual({ decision: 'revise', feedback: '第二页数字不对' });
    expect(parseApprovalReply('可以，但是把标题改了')).toEqual({ decision: 'revise', feedback: '可以,但是把标题改了' });
  });
});

describe('parseCommand', () => {
  it('parses Chinese and English commands', () => {
    expect(parseCommand('/列表')).toEqual({ name: 'list' });
    expect(parseCommand('／帮助')).toEqual({ name: 'help' });
    expect(parseCommand('/切 2')).toEqual({ name: 'switch', index: 2 });
    expect(parseCommand('/切2')).toEqual({ name: 'switch', index: 2 });
    expect(parseCommand('/stop')).toEqual({ name: 'stop' });
    expect(parseCommand('/详细')).toEqual({ name: 'detail' });
    expect(parseCommand('/新 帮我查一下 1133 的租金')).toEqual({ name: 'new', text: '帮我查一下 1133 的租金' });
    expect(parseCommand('/xyz')).toEqual({ name: 'unknown', raw: '/xyz' });
  });
  it('ignores normal messages', () => {
    expect(parseCommand('帮我看看 /列表 是什么')).toBeNull();
    expect(parseCommand('hello')).toBeNull();
  });
});

describe('toPlainText', () => {
  it('strips markdown into WeChat-friendly text', () => {
    const md = '## 结论\n\n**租金上涨 3.2%**，见 [报告](https://x.com/r)。\n\n- 第一点\n- 第二点\n\n| 户型 | 租金 |\n|---|---|\n| 1B | $3,100 |';
    expect(toPlainText(md)).toBe('结论\n\n租金上涨 3.2%，见 报告 https://x.com/r。\n\n· 第一点\n· 第二点\n\n户型 · 租金\n1B · $3,100');
  });
});

describe('chunkText', () => {
  it('keeps short text whole and splits long text on paragraph breaks', () => {
    expect(chunkText('abc', 10)).toEqual(['abc']);
    const long = `${'a'.repeat(8)}\n\n${'b'.repeat(8)}`;
    expect(chunkText(long, 12)).toEqual(['a'.repeat(8), 'b'.repeat(8)]);
    expect(chunkText('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });
});

describe('discordSafe', () => {
  it('keeps bold/lists/links but flattens tables and headings', () => {
    const md = '## 结论\n**涨了 3%**\n\n- a\n- b\n\n| 户型 | 租金 |\n|---|---|\n| 1B | $3,100 |\n\n[表](https://x.com)';
    expect(discordSafe(md)).toBe('**结论**\n**涨了 3%**\n\n- a\n- b\n\n户型 · 租金\n1B · $3,100\n\n[表](https://x.com)');
  });
  it('commands also work with ! (Discord pops a picker on /)', () => {
    expect(parseCommand('!停')).toEqual({ name: 'stop' });
    expect(parseCommand('！状态')).toEqual({ name: 'status' });
  });
});

describe('tags and headers', () => {
  it('labels sessions A..Z, AA', () => {
    expect([0, 1, 25, 26, 27].map(tagForIndex)).toEqual(['A', 'B', 'Z', 'AA', 'AB']);
  });
  it('only shows a header when several sessions are connected', () => {
    expect(pushHeader('A', '短标题', false)).toBe('');
    expect(pushHeader('B', '一个非常非常非常非常长的对话标题', true)).toBe('[B·一个非常非常非常非常长的对话…] ');
  });
});

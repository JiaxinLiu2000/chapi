import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db/client.js';
import { Translator } from './translator.js';

type Call = { system?: string; prompt: string; model?: string; trigger?: string };

function fakeLlm(reply: (c: Call) => string | Promise<string>) {
  const calls: Call[] = [];
  const fn = (async (opts: Call) => {
    calls.push(opts);
    return reply(opts);
  }) as never;
  return { fn, calls };
}

describe('Translator', () => {
  let sessionId: string;
  const prefIds: string[] = [];

  beforeAll(async () => {
    const s = await prisma.session.create({
      data: { slug: `wx-tr-${Date.now()}`, title: '翻译测试', model: 'claude-opus-4-8', subagentModel: 'claude-sonnet-4-6', permissionProfile: 'web', status: 'active' },
    });
    sessionId = s.id;
    for (const [title, score, solution] of [
      ['微信推送：完成推送只说结论', 80, '完成推送控制在 80 字内，只说结论和数字'],
      ['微信推送：弱信号', 20, '这条权重太低不该出现'],
    ] as const) {
      const e = await prisma.wikiEntry.create({
        data: { slug: `wx-pref-${Date.now()}-${score}`, title, bodyMd: '', kind: 'preference', polarity: 'positive', score, solution, tags: ['微信推送'], sourceRefs: [], aliases: [], topics: [] },
      });
      prefIds.push(e.id);
    }
  });

  afterAll(async () => {
    await prisma.wikiEntry.deleteMany({ where: { id: { in: prefIds } } });
    await prisma.usageEvent.deleteMany({ where: { sessionId } });
    await prisma.session.delete({ where: { id: sessionId } });
  });

  it('uses the session sub-agent model and injects learned preferences (score ≥ 40 only)', async () => {
    const { fn, calls } = fakeLlm(() => '**完成**：租金涨了 3%');
    const out = await new Translator(fn).composeCompletion({ sessionId, title: 't', text: '很长的输出……' });
    expect(out).toBe('完成：租金涨了 3%');
    expect(calls[0]!.model).toBe('claude-sonnet-4-6');
    expect(calls[0]!.trigger).toBe('remote');
    expect(calls[0]!.system).toContain('完成推送控制在 80 字内');
    expect(calls[0]!.system).not.toContain('权重太低');
  });

  it('SKIP means nothing to push; a model error falls back to clipped plain text', async () => {
    expect(await new Translator(fakeLlm(() => 'SKIP').fn).composeCompletion({ sessionId, title: 't', text: '好的，我继续' })).toBeNull();
    const failing = fakeLlm(() => {
      throw new Error('boom');
    });
    expect(await new Translator(failing.fn).composeCompletion({ sessionId, title: 't', text: '## 标题\n内容' })).toBe('标题\n内容');
  });

  it('short questions skip the model; long ones must keep the option count', async () => {
    const none = fakeLlm(() => 'x');
    expect(await new Translator(none.fn).composeQuestion({ sessionId, question: '用哪个模板？', options: ['A', 'B'] })).toEqual({ question: '用哪个模板？', options: ['A', 'B'] });
    expect(none.calls).toHaveLength(0);

    const longQ = '这是一个非常长的问题'.repeat(10);
    const opts = ['选项一'.repeat(12), '选项二'.repeat(12)];
    const good = await new Translator(fakeLlm(() => '{"q":"短问题","o":["一","二"]}').fn).composeQuestion({ sessionId, question: longQ, options: opts });
    expect(good).toEqual({ question: '短问题', options: ['一', '二'] });
    const bad = await new Translator(fakeLlm(() => '{"q":"短问题","o":["只有一个"]}').fn).composeQuestion({ sessionId, question: longQ, options: opts });
    expect(bad.options).toHaveLength(2); // wrong count → deterministic fallback
  });

  it('maps free text onto options but always keeps the user\'s own words', async () => {
    const opts = ['周四发', '周五发', '下周一发'];
    const t1 = new Translator(fakeLlm(() => '{"pick":[2]}').fn);
    expect(await t1.interpretAnswer({ sessionId, question: '哪天发？', options: opts, reply: '第二个吧，上午十点' })).toBe('周五发（原话：第二个吧，上午十点）');
    const t2 = new Translator(fakeLlm(() => '{"pick":[]}').fn);
    expect(await t2.interpretAnswer({ sessionId, question: '哪天发？', options: opts, reply: '等我确认后再发，先别定' })).toBe('等我确认后再发，先别定');
    const t3 = new Translator(fakeLlm(() => {
      throw new Error('down');
    }).fn);
    expect(await t3.interpretAnswer({ sessionId, question: '哪天发？', options: opts, reply: '周五下午' })).toBe('周五下午');
  });

  it('classifies format feedback', async () => {
    const t = new Translator(fakeLlm(() => '{"feedback":true,"preference":"完成推送只说结论","ack":"好，以后只说结论"}').fn);
    expect(await t.classifyFeedback({ reply: '太长了' })).toEqual({ preference: '完成推送只说结论', ack: '好，以后只说结论' });
    const n = new Translator(fakeLlm(() => '{"feedback":false}').fn);
    expect(await n.classifyFeedback({ reply: '把格式改成表格' })).toBeNull();
  });
});

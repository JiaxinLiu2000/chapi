import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { setOrchestrator, type Orchestrator } from '../orchestrator/types.js';
import { WechatBridge } from './bridge.js';
import type { IlinkClient, WeixinMessage } from './protocol.js';
import type { Translator } from '../remote/translator.js';

const OWNER = 'owner@im.wechat';

class FakeClient {
  texts: Array<{ to: string; text: string; ctx?: string }> = [];
  files: string[] = [];
  images = 0;
  typing: number[] = [];
  failNext = 0;
  private n = 0;
  readonly tag = Math.random().toString(36).slice(2, 8);
  getUpdates(_buf: string, _t: number, signal?: AbortSignal) {
    return new Promise((resolve) => signal?.addEventListener('abort', () => resolve({ ret: 0, msgs: [] })));
  }
  async sendText(to: string, text: string, ctx?: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('sendmessage ret=-2 context expired');
    }
    this.texts.push({ to, text, ctx });
    return `srv-${this.tag}-${++this.n}`;
  }
  async uploadMedia(buf: Buffer) {
    return { downloadParam: 'dl', aeskeyHex: '00'.repeat(16), rawSize: buf.length, cipherSize: buf.length + 16 };
  }
  async sendFile(_to: string, name: string) {
    this.files.push(name);
    return `srv-${this.tag}-${++this.n}`;
  }
  async sendImage() {
    this.images++;
    return `srv-${this.tag}-${++this.n}`;
  }
  async getTypingTicket() {
    return 'ticket';
  }
  async sendTyping(_u: string, _t: string, status: number) {
    this.typing.push(status);
  }
  last() {
    return this.texts.at(-1)?.text ?? '';
  }
}

function fakeOrchestrator() {
  const calls = {
    messages: [] as Array<{ sessionId: string; text: string }>,
    answers: [] as Array<{ questionId: string; answer: string }>,
    decisions: [] as Array<{ approvalId: string; decision: string; feedback?: string }>,
    interrupts: [] as string[],
  };
  const o = {
    async handleUserMessage(sessionId: string, text: string) {
      calls.messages.push({ sessionId, text });
      await prisma.message.create({ data: { sessionId, role: 'user', type: 'user', content: [{ type: 'text', text }], text } });
    },
    async answerQuestion(_s: string, questionId: string, answer: string) {
      calls.answers.push({ questionId, answer });
      await prisma.pendingQuestion.update({ where: { id: questionId }, data: { status: 'answered', answer } });
      bus.emit({ type: 'question.closed', sessionId: _s, questionId });
    },
    async decideApproval(_s: string, approvalId: string, decision: string, feedback?: string) {
      calls.decisions.push({ approvalId, decision, feedback });
      await prisma.approval.update({ where: { id: approvalId }, data: { status: decision === 'approve' ? 'approved' : decision } });
    },
    async interrupt(sessionId: string) {
      calls.interrupts.push(sessionId);
    },
  };
  return { o: o as unknown as Orchestrator, calls };
}

const stubTranslator = {
  composeCompletion: vi.fn(async () => '搞定：租金涨了 3%'),
  composeQuestion: vi.fn(async (i: { question: string; options: string[] | null }) => ({ question: i.question, options: i.options })),
  composeApproval: vi.fn(async () => '做完了竞品表'),
  composeDetail: vi.fn(async (i: { fullText: string }) => `详细版：${i.fullText}`),
  interpretAnswer: vi.fn(async () => '周五发'),
  classifyFeedback: vi.fn(async () => null),
  recordPreference: vi.fn(async () => undefined),
  nudgeDetail: vi.fn(async () => undefined),
} as unknown as Translator;

function inbound(text: string, extra: Partial<WeixinMessage> = {}, quoted?: string): WeixinMessage {
  return {
    from_user_id: OWNER,
    message_type: 1,
    context_token: 'ctx-new',
    item_list: [{ type: 1, text_item: { text }, ...(quoted ? { ref_msg: { svr_id: quoted } } : {}) }],
    ...extra,
  };
}

describe('WechatBridge', () => {
  let client: FakeClient;
  let bridge: WechatBridge;
  let orch: ReturnType<typeof fakeOrchestrator>;
  let s1: string;
  let s2: string;

  let botId: string;

  // The test DB can be shared with a live test instance — only ever touch our own rows.
  beforeEach(async () => {
    botId = `bot-test-${Math.random().toString(36).slice(2, 8)}`;
    const mk = (title: string) =>
      prisma.session.create({ data: { slug: `wx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, model: 'm', permissionProfile: 'web', status: 'active' } });
    s1 = (await mk('竞品租金分析')).id;
    s2 = (await mk('写周报')).id;
    await prisma.wechatAccount.create({ data: { id: botId, token: 'tok', ownerUserId: OWNER, contextToken: 'ctx', status: 'active', focusSessionId: s1 } });
    await prisma.wechatBinding.create({ data: { sessionId: s1, tag: 'A' } });
    client = new FakeClient();
    orch = fakeOrchestrator();
    setOrchestrator(orch.o);
    bridge = new WechatBridge(stubTranslator, () => client as unknown as IlinkClient);
    await bridge.start();
  });

  afterEach(async () => {
    bridge.stop();
    await prisma.wechatOutbound.deleteMany({ where: { OR: [{ sessionId: { in: [s1, s2] } }, { messageId: { startsWith: `srv-${client.tag}-` } }] } });
    await prisma.wechatBinding.deleteMany({ where: { sessionId: { in: [s1, s2] } } });
    await prisma.wechatAccount.deleteMany({ where: { id: botId } });
    await prisma.session.deleteMany({ where: { id: { in: [s1, s2] } } });
  });

  it('forwards owner text to the focused session like a normal message and refreshes the context token', async () => {
    const seen: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'assistant.message' && e.message.role === 'user') seen.push(e.message.text);
    });
    await bridge.handleInbound(inbound('帮我查一下 1133 的租金'));
    off();
    expect(orch.calls.messages).toEqual([{ sessionId: s1, text: '帮我查一下 1133 的租金' }]);
    expect(seen).toEqual(['帮我查一下 1133 的租金']); // web shows it live
    expect((await prisma.wechatAccount.findUnique({ where: { id: botId } }))!.contextToken).toBe('ctx-new');
  });

  it('ignores anyone but the owner', async () => {
    await bridge.handleInbound(inbound('hi', { from_user_id: 'stranger@im.wechat' }));
    expect(orch.calls.messages).toHaveLength(0);
    expect(client.texts).toHaveLength(0);
  });

  it('uses WeChat voice-to-text as the message', async () => {
    await bridge.handleInbound({ from_user_id: OWNER, message_type: 1, context_token: 'c', item_list: [{ type: 3, voice_item: { text: '继续做下一步' } }] });
    expect(orch.calls.messages[0]!.text).toBe('继续做下一步');
  });

  it('maps a number onto the open question option, and free text through the translator', async () => {
    const q = await prisma.pendingQuestion.create({ data: { sessionId: s1, question: '哪天发？', options: ['周四发', '周五发'], status: 'open' } });
    await bridge.handleInbound(inbound('2'));
    expect(orch.calls.answers).toEqual([{ questionId: q.id, answer: '周五发' }]);
    expect(client.last()).toContain('已回答：周五发');

    const q2 = await prisma.pendingQuestion.create({ data: { sessionId: s1, question: '哪天发？', options: ['周四发', '周五发'], status: 'open' } });
    await bridge.handleInbound(inbound('第二个吧'));
    expect(stubTranslator.interpretAnswer).toHaveBeenCalled();
    expect(orch.calls.answers[1]).toEqual({ questionId: q2.id, answer: '周五发' });
  });

  it('turns approval replies into decisions', async () => {
    const a = await prisma.approval.create({ data: { sessionId: s1, summary: '竞品表', artifacts: [], status: 'open' } });
    await bridge.handleInbound(inbound('3 标题改短点'));
    expect(orch.calls.decisions).toEqual([{ approvalId: a.id, decision: 'revise', feedback: '标题改短点' }]);
    expect(client.last()).toContain('已发回修改');
  });

  it('shows typing while running, then pushes a short result and the produced file', async () => {
    bus.emit({ type: 'run.state', sessionId: s1, state: 'running' });
    await vi.waitFor(() => expect(client.typing).toContain(1));
    expect(client.texts).toHaveLength(0); // no progress messages

    const sandbox = sessionPaths(s1).sandbox;
    fs.mkdirSync(path.join(sandbox, 'output'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'output', 'report.docx'), 'docx-bytes');
    await prisma.message.create({ data: { sessionId: s1, role: 'assistant', type: 'assistant', content: [], text: '## 结果\n租金涨了 3%，报告在 output/report.docx' } });
    await prisma.artifact.create({ data: { sessionId: s1, kind: 'drive', title: '竞品表', pathOrUrl: 'https://docs.google.com/x' } });

    bus.emit({ type: 'run.state', sessionId: s1, state: 'idle' });
    await vi.waitFor(() => expect(client.typing).toContain(2));
    await bridge.finalizeTurn(s1);
    const push = client.texts.find((t) => t.text.startsWith('✅'))!.text;
    expect(push).toContain('搞定：租金涨了 3%');
    expect(push).toContain('📎 竞品表：https://docs.google.com/x');
    expect(client.files).toEqual(['report.docx']);
  });

  it('pushes questions with numbered options and stops typing while waiting', async () => {
    bus.emit({ type: 'run.state', sessionId: s1, state: 'running' });
    await vi.waitFor(() => expect(client.typing).toContain(1));
    const q = await prisma.pendingQuestion.create({ data: { sessionId: s1, question: '用哪个模板？', options: ['旧模板', '新模板'], status: 'open' } });
    bus.emit({ type: 'question.open', sessionId: s1, question: { id: q.id, sessionId: s1, agentRunId: null, question: q.question, options: ['旧模板', '新模板'], answer: null, status: 'open', source: 'agent', createdAt: '' } });
    await vi.waitFor(() => expect(client.last()).toContain('❓ 用哪个模板？\n1. 旧模板\n2. 新模板'));
    expect(client.typing).toContain(2);
    const out = await prisma.wechatOutbound.findFirst({ where: { kind: 'question' } });
    expect(out?.refId).toBe(q.id);
  });

  it('queues a failed push and re-sends it when the user next messages', async () => {
    client.failNext = 1;
    await bridge.send('结果来了', { sessionId: s1, kind: 'completion' });
    expect(client.texts).toHaveLength(0);
    expect((await bridge.status()).queued).toBe(1);
    await bridge.handleInbound(inbound('在吗'));
    expect(client.texts.map((t) => t.text)).toEqual(expect.arrayContaining(['结果来了']));
    expect((await bridge.status()).queued).toBe(0);
  });

  it('routes a quoted reply to the quoted session', async () => {
    await prisma.wechatBinding.create({ data: { sessionId: s2, tag: 'B' } });
    await bridge.start(); // reload bindings
    await prisma.wechatOutbound.create({ data: { messageId: 'srv-quoted', sessionId: s2, kind: 'completion', fullText: '周报写好了' } });
    await bridge.handleInbound(inbound('把第三段删掉', {}, 'srv-quoted'));
    expect(orch.calls.messages).toEqual([{ sessionId: s2, text: '把第三段删掉' }]);
  });

  it('handles /列表, /切, /详细 and /停', async () => {
    await bridge.handleInbound(inbound('/列表'));
    expect(client.last()).toContain('[A] 竞品租金分析');
    expect(client.last()).toContain('写周报');

    await bridge.handleInbound(inbound('/切 2'));
    expect(client.last()).toContain('已切到 [B] 写周报');
    expect((await prisma.wechatAccount.findUnique({ where: { id: botId } }))!.focusSessionId).toBe(s2);

    await bridge.send('短版', { sessionId: s2, kind: 'completion', fullText: '很长的原文' });
    await bridge.handleInbound(inbound('/状态')); // a bridge reply in between must not become "the last push"
    await bridge.handleInbound(inbound('/详细'));
    expect(client.last()).toBe('详细版：很长的原文');
    expect(stubTranslator.nudgeDetail).toHaveBeenCalledWith('completion', s2);

    await bridge.handleInbound(inbound('/停'));
    expect(orch.calls.interrupts).toEqual([s2]);
  });

  it('asks to connect a session when nothing is focused', async () => {
    await bridge.disconnect(s1);
    await bridge.handleInbound(inbound('你好'));
    expect(orch.calls.messages).toHaveLength(0);
    expect(client.last()).toContain('还没有连接对话');
  });
});

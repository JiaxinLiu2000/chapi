import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { setOrchestrator, type Orchestrator } from '../orchestrator/types.js';
import type { Translator } from '../remote/translator.js';
import type { WorkflowGraph, WorkflowNodeDef, WorkflowRunDTO } from '@chapi/shared';
import { toSessionDTO } from '../mappers.js';
import { DiscordBridge, type DiscordPort, type InboundMessage, type OutPayload } from './bridge.js';

// Office → PDF needs Word; fake a 5-page .docx render, keep everything else real.
vi.mock('../remote/preview.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../remote/preview.js')>();
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  return {
    ...real,
    makePreview: vi.fn(async (file: string, first = 1, count = 3) => {
      if (!file.endsWith('.docx')) return real.makePreview(file, first, count);
      const dir = nodePath.join(nodePath.dirname(file), '.preview', 'fake');
      nodeFs.mkdirSync(dir, { recursive: true });
      const total = 5;
      const images = [];
      for (let p = first; p < Math.min(total + 1, first + count); p++) {
        const img = nodePath.join(dir, `page-${p}.png`);
        nodeFs.writeFileSync(img, 'png');
        images.push(img);
      }
      const pdf = nodePath.join(dir, 'report.pdf');
      nodeFs.writeFileSync(pdf, 'pdf');
      return { images, first, totalPages: total, pdf };
    }),
  };
});

const OWNER = '111';
const HOME = 'home-ch';

class FakePort implements DiscordPort {
  sent: Array<{ channelId: string; p: OutPayload; id: string }> = [];
  edits: Array<{ channelId: string; messageId: string; p: OutPayload }> = [];
  typings: string[] = [];
  threads: Array<{ id: string; name: string; first: string }> = [];
  archived = new Map<string, boolean>();
  reactions: string[] = [];
  private n = 0;
  private readonly tag = Math.random().toString(36).slice(2, 8); // unique ids across runs (shared DB)
  async send(channelId: string, p: OutPayload) {
    const id = `m-${this.tag}-${++this.n}`;
    this.sent.push({ channelId, p, id });
    return id;
  }
  async edit(channelId: string, messageId: string, p: OutPayload) {
    this.edits.push({ channelId, messageId, p });
  }
  async typing(channelId: string) {
    this.typings.push(channelId);
  }
  async createThread(_parent: string, name: string, first: string) {
    const id = `t-${this.tag}-${++this.n}`;
    this.threads.push({ id, name, first });
    return id;
  }
  async setArchived(threadId: string, archived: boolean) {
    this.archived.set(threadId, archived);
  }
  renamed: Array<{ threadId: string; name: string }> = [];
  async renameThread(threadId: string, name: string) {
    this.renamed.push({ threadId, name });
  }
  async react(_c: string, _m: string, emoji: string) {
    this.reactions.push(emoji);
  }
  threadUrl(threadId: string) {
    return `https://discord.com/channels/g/${threadId}`;
  }
  inThread(threadId: string) {
    return this.sent.filter((s) => s.channelId === threadId);
  }
}

function fakeOrchestrator() {
  const calls = {
    messages: [] as Array<{ sessionId: string; text: string }>,
    answers: [] as Array<{ questionId: string; answer: string }>,
    decisions: [] as Array<{ approvalId: string; decision: string; feedback?: string }>,
    interrupts: [] as string[],
    configs: [] as Array<Record<string, unknown>>,
    completed: [] as string[],
    quality: [] as string[],
  };
  const o = {
    async handleUserMessage(sessionId: string, text: string) {
      calls.messages.push({ sessionId, text });
      const row = await prisma.message.create({ data: { sessionId, role: 'user', type: 'user', content: [{ type: 'text', text }], text } });
      bus.emit({ type: 'user.message', sessionId, message: { id: row.id, sessionId, role: 'user', type: 'user', text, tokens: 0, agentRunId: null, createdAt: '' } });
    },
    async answerQuestion(sessionId: string, questionId: string, answer: string) {
      calls.answers.push({ questionId, answer });
      await prisma.pendingQuestion.update({ where: { id: questionId }, data: { status: 'answered', answer } });
      bus.emit({ type: 'question.closed', sessionId, questionId });
    },
    async decideApproval(sessionId: string, approvalId: string, decision: string, feedback?: string) {
      calls.decisions.push({ approvalId, decision, feedback });
      await prisma.approval.update({ where: { id: approvalId }, data: { status: decision === 'approve' ? 'approved' : decision, feedback: feedback ?? null } });
      bus.emit({ type: 'approval.closed', sessionId, approvalId });
    },
    async interrupt(sessionId: string) {
      calls.interrupts.push(sessionId);
    },
    async markCompleted(sessionId: string) {
      calls.completed.push(sessionId);
      await prisma.session.update({ where: { id: sessionId }, data: { status: 'completed' } });
    },
    async runQualityReview(sessionId: string) {
      calls.quality.push(sessionId);
    },
    async setConfig(sessionId: string, model?: string, effort?: string, subagentModel?: string, language?: string, accountMode?: string, qualityReviewMinutes?: number) {
      calls.configs.push({ model, effort, subagentModel, language, accountMode, qualityReviewMinutes });
      await prisma.session.update({
        where: { id: sessionId },
        data: {
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(subagentModel ? { subagentModel } : {}),
          ...(language ? { language } : {}),
          ...(qualityReviewMinutes !== undefined ? { qualityReviewMinutes } : {}),
        },
      });
    },
  };
  return { o: o as unknown as Orchestrator, calls };
}

const stubTranslator = {
  composeCompletion: vi.fn(async () => '**搞定**：租金涨了 3%'),
  composeQuestion: vi.fn(async (i: { question: string; options: string[] | null }) => ({ question: i.question, options: i.options })),
  composeApproval: vi.fn(async () => '做完了竞品表'),
  composeDetail: vi.fn(async (i: { fullText: string }) => `详细：${i.fullText}`),
  interpretAnswer: vi.fn(async () => '新模板'),
  classifyFeedback: vi.fn(async () => ({ preference: '完成推送只说结论', ack: '好，以后只说结论' })),
  recordPreference: vi.fn(async () => undefined),
  nudgeDetail: vi.fn(async () => undefined),
} as unknown as Translator;

const sopStep = (id: string, title: string, extra: Partial<WorkflowNodeDef> = {}): WorkflowNodeDef => ({
  id,
  type: 'step',
  title,
  instructions: `做 ${title}`,
  doneCriteria: [`${title}完成`],
  evidence: [{ key: 'count', type: 'int' }],
  ...extra,
});
const sopGraph = (steps: WorkflowNodeDef[]): WorkflowGraph => {
  const nodes: WorkflowNodeDef[] = [{ id: 'start', type: 'start', title: '开始' }, ...steps, { id: 'end', type: 'end', title: '结束' }];
  return { nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })) };
};
const GRAPH = sopGraph([
  sopStep('pull', '阶段 1 拉取名单', { substeps: [{ id: 'a', title: '导出 CSV' }, { id: 'b', title: '去重' }] }),
  sopStep('call', '阶段 2 核对电话'),
]);

function msg(channelId: string, content: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return { channelId, parentId: null, isDM: false, authorId: OWNER, messageId: `in-${Math.random()}`, content, attachments: [], ...extra };
}

describe('DiscordBridge', () => {
  let port: FakePort;
  let bridge: DiscordBridge;
  let orch: ReturnType<typeof fakeOrchestrator>;
  let s1: string;
  let thread: string;
  const created: string[] = [];
  const workflows: string[] = [];

  // The test DB can be shared with a live test instance — only ever touch our own rows.
  beforeEach(async () => {
    const s = await prisma.session.create({ data: { slug: `dc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: '竞品租金分析', model: 'm', permissionProfile: 'web', status: 'active' } });
    s1 = s.id;
    created.push(s1);
    port = new FakePort();
    orch = fakeOrchestrator();
    setOrchestrator(orch.o);
    const fetchImpl = (async () => new Response(new Uint8Array(Buffer.from('PDFDATA')))) as unknown as typeof fetch;
    bridge = new DiscordBridge(stubTranslator, fetchImpl);
    await bridge.attach(port, [OWNER], HOME);
    await bridge.connect(s1);
    thread = port.threads[0]!.id;
  });

  afterEach(async () => {
    bridge.detach();
    // Sessions a failing test opened before it could record them: find them by our fake threads.
    const ours = await prisma.discordBinding.findMany({ where: { threadId: { in: port.threads.map((t) => t.id) } } });
    created.push(...ours.map((b) => b.sessionId).filter((id) => !created.includes(id)));
    await prisma.discordOutbound.deleteMany({ where: { sessionId: { in: created } } });
    await prisma.discordBinding.deleteMany({ where: { sessionId: { in: created } } });
    await prisma.session.deleteMany({ where: { id: { in: created } } });
    await prisma.workflow.deleteMany({ where: { id: { in: workflows } } });
    created.length = 0;
    workflows.length = 0;
  });

  it('connecting a session opens a thread that pings the owner', () => {
    expect(port.threads[0]!.name).toBe('chapi · 竞品租金分析');
    expect(port.threads[0]!.first).toContain(`<@${OWNER}>`);
    expect(bridge.sessionState(s1)).toEqual({ ready: true, connected: true, threadUrl: `https://discord.com/channels/g/${thread}` });
  });

  it('thread messages go to that session; strangers are ignored', async () => {
    const seen: string[] = [];
    const off = bus.on((e) => {
      if (e.type === 'assistant.message' && e.message.role === 'user') seen.push(e.message.text);
    });
    await bridge.onMessage(msg(thread, '再加两栋楼'));
    await bridge.onMessage(msg(thread, '我是路人', { authorId: '999' }));
    off();
    expect(orch.calls.messages).toEqual([{ sessionId: s1, text: '再加两栋楼' }]);
    expect(seen).toEqual(['再加两栋楼']);
    expect(port.reactions).toContain('👀');
  });

  it('a message in the home channel starts a new task in its own thread', async () => {
    await bridge.onMessage(msg(HOME, '帮我写本周周报'));
    const newSession = orch.calls.messages[0]!.sessionId;
    created.push(newSession);
    expect(newSession).not.toBe(s1);
    expect(orch.calls.messages[0]!.text).toBe('帮我写本周周报');
    expect(port.threads).toHaveLength(2);
    expect(port.reactions).toContain('🧵');
  });

  it('attachments are saved into the session and noted in the message', async () => {
    await bridge.onMessage(msg(thread, '看看这个', { attachments: [{ url: 'https://cdn.discordapp.com/x.pdf', name: '报价单.pdf', size: 7 }] }));
    const text = orch.calls.messages[0]!.text;
    expect(text).toMatch(/^看看这个\n\n\[本次上传的文件/);
    expect(text).toContain('报价单.pdf → uploads/');
    expect(await prisma.attachment.count({ where: { sessionId: s1 } })).toBe(1);
  });

  it('typing while running; result with detail button and files after the turn', async () => {
    bus.emit({ type: 'run.state', sessionId: s1, state: 'running' });
    expect(bridge.isTyping(s1)).toBe(true);
    expect(port.typings).toContain(thread);

    const sandbox = sessionPaths(s1).sandbox;
    fs.mkdirSync(path.join(sandbox, 'output'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'output', 'chart.png'), 'png');
    await prisma.message.create({ data: { sessionId: s1, role: 'assistant', type: 'assistant', content: [], text: '图表在 output/chart.png' } });
    await prisma.artifact.create({ data: { sessionId: s1, kind: 'sheet', title: '竞品表', pathOrUrl: 'https://docs.google.com/s' } });

    bus.emit({ type: 'run.state', sessionId: s1, state: 'idle' });
    expect(bridge.isTyping(s1)).toBe(false);
    await bridge.finalizeTurn(s1);
    const posts = port.inThread(thread);
    const result = posts.find((p) => p.p.content.startsWith('✅'))!;
    expect(result.p.content).toContain('**搞定**：租金涨了 3%');
    expect(result.p.content).toContain('📎 [竞品表](https://docs.google.com/s)');
    expect(result.p.buttons?.[0]?.[0]?.id).toBe('detail');
    expect(posts.find((p) => p.p.files?.length)!.p.files![0]).toMatch(/chart\.png$/);

    // 📄 详细 button → fuller version in the thread + preference nudge
    await bridge.onButton('detail', OWNER, thread, result.id);
    expect(port.inThread(thread).at(-1)!.p.content).toBe('📄 详细：图表在 output/chart.png');
    expect(stubTranslator.nudgeDetail).toHaveBeenCalledWith('completion', s1);
  });

  it('question → option buttons; clicking answers and greys out the card', async () => {
    bus.emit({ type: 'run.state', sessionId: s1, state: 'running' });
    const q = await prisma.pendingQuestion.create({ data: { sessionId: s1, question: '用哪个模板？', options: ['旧模板', '新模板'], status: 'open' } });
    bus.emit({ type: 'question.open', sessionId: s1, question: { id: q.id, sessionId: s1, agentRunId: null, question: q.question, options: ['旧模板', '新模板'], answer: null, status: 'open', source: 'agent', createdAt: '' } });
    await vi.waitFor(() => expect(port.inThread(thread).some((p) => p.p.content.includes('用哪个模板'))).toBe(true));
    const card = port.inThread(thread).find((p) => p.p.content.includes('用哪个模板'))!;
    expect(card.p.buttons![0]!.map((b) => b.id)).toEqual([`q:${q.id}:0`, `q:${q.id}:1`]);
    expect(bridge.isTyping(s1)).toBe(false); // waiting on the user

    expect(await bridge.onButton(`q:${q.id}:1`, '999', thread, card.id)).toMatch(/主人/); // not the owner
    expect(await bridge.onButton(`q:${q.id}:1`, OWNER, thread, card.id)).toBeNull();
    expect(orch.calls.answers).toEqual([{ questionId: q.id, answer: '新模板' }]);
    await vi.waitFor(() => expect(port.edits.at(-1)?.messageId).toBe(card.id));
    expect(port.edits.at(-1)!.p.content).toContain('✓ 已回答：新模板');
    expect(port.edits.at(-1)!.p.buttons).toEqual([]);
    expect(bridge.isTyping(s1)).toBe(true); // back to work
  });

  it('every question card offers 「✍️ 文字回答」; its form text is sent verbatim', async () => {
    const q = await prisma.pendingQuestion.create({ data: { sessionId: s1, question: '用哪个模板？', options: ['旧模板', '新模板'], status: 'open' } });
    bus.emit({ type: 'question.open', sessionId: s1, question: { id: q.id, sessionId: s1, agentRunId: null, question: q.question, options: ['旧模板', '新模板'], answer: null, status: 'open', source: 'agent', createdAt: '' } });
    await vi.waitFor(() => expect(port.inThread(thread).some((p) => p.p.content.includes('用哪个模板'))).toBe(true));
    const card = port.inThread(thread).find((p) => p.p.content.includes('用哪个模板'))!;
    expect(card.p.buttons!.at(-1)).toEqual([{ id: `qt:${q.id}`, label: '✍️ 文字回答', style: 'secondary' }]);
    expect(bridge.modalFor(`qt:${q.id}`)).toEqual({ id: `qm:${q.id}`, title: '文字回答', label: '你的回答（原样发给 chapi）' });
    await bridge.onModal(`qm:${q.id}`, OWNER, '都不用，按上周那份的格式来，只把日期换掉');
    expect(orch.calls.answers).toEqual([{ questionId: q.id, answer: '都不用，按上周那份的格式来，只把日期换掉' }]);
  });

  it('!设置 posts a settings card; dropdowns and buttons change the session like the web bar', async () => {
    await prisma.session.update({ where: { id: s1 }, data: { model: 'claude-opus-5-5', subagentModel: 'claude-sonnet-5-5', effort: 'high', language: 'zh', qualityReviewMinutes: 5 } });
    await bridge.onMessage(msg(thread, '!设置'));
    const card = port.inThread(thread).at(-1)!;
    expect(card.p.content).toContain('主代理：Opus 5.5 · 强 · 子代理：Sonnet 5.5 · 均衡');
    expect(card.p.content).toContain('思考强度：高 · 语言：中文 · 质检：每 5 分钟');
    expect(card.p.selects!.map((s) => s.id)).toEqual([`cfg:${s1}:model`, `cfg:${s1}:sub`, `cfg:${s1}:effort`, `cfg:${s1}:quality`]);
    expect(card.p.selects![0]!.options.find((o) => o.default)?.value).toBe('claude-opus-5-5');
    expect(card.p.buttons![0]!.map((b) => b.id)).toEqual(expect.arrayContaining([`cfgb:${s1}:lang`, `cfgb:${s1}:chrome`]));

    expect(await bridge.onSelect(`cfg:${s1}:effort`, '999', 'max', thread, card.id)).toMatch(/主人/);
    await bridge.onSelect(`cfg:${s1}:effort`, OWNER, 'max', thread, card.id);
    await bridge.onSelect(`cfg:${s1}:model`, OWNER, 'claude-fable-5-1', thread, card.id);
    await bridge.onButton(`cfgb:${s1}:lang`, OWNER, thread, card.id);
    expect(orch.calls.configs).toEqual([
      expect.objectContaining({ effort: 'max' }),
      expect.objectContaining({ model: 'claude-fable-5-1' }),
      expect.objectContaining({ language: 'en' }),
    ]);
    const refreshed = port.edits.at(-1)!;
    expect(refreshed.messageId).toBe(card.id);
    expect(refreshed.p.content).toContain('✓ 语言 → English');
    expect(refreshed.p.content).toContain('主代理：Fable 5.1 · 最强');
    expect(refreshed.p.content).toContain('思考强度：最高');
  });

  it('!列表 in the channel offers earlier conversations; picking one opens a thread with a recap and its pending question', async () => {
    const old = await prisma.session.create({ data: { slug: `dc-old-${Date.now()}`, title: '上周的周报', model: 'm', permissionProfile: 'web', status: 'active' } });
    created.push(old.id);
    await prisma.message.create({ data: { sessionId: old.id, role: 'assistant', type: 'assistant', content: [], text: '周报初稿写好了，还差销售数据。' } });
    const q = await prisma.pendingQuestion.create({ data: { sessionId: old.id, question: '销售数据用哪个版本？', options: ['10 月', '11 月'], status: 'open' } });

    await bridge.onMessage(msg(HOME, '!列表'));
    const card = port.sent.filter((s) => s.channelId === HOME).at(-1)!;
    const menu = card.p.selects![0]!;
    expect(menu.id).toBe('resume');
    expect(menu.options.map((o) => o.value)).toContain(old.id);
    expect(menu.options.map((o) => o.value)).not.toContain(s1); // already connected

    await bridge.onSelect('resume', OWNER, old.id, HOME, card.id);
    const t = bridge.sessionState(old.id);
    expect(t.connected).toBe(true);
    expect(port.sent.filter((s) => s.channelId === HOME).at(-1)!.p.content).toContain('已接上「上周的周报」');
    const oldThread = port.threads.at(-1)!.id;
    await vi.waitFor(() => expect(port.inThread(oldThread).some((p) => p.p.content.startsWith('📌 **接着上次**'))).toBe(true));
    await vi.waitFor(() => expect(port.inThread(oldThread).some((p) => p.p.buttons?.[0]?.[0]?.id === `q:${q.id}:0`)).toBe(true));
  });

  it('!找 matches conversations by title or content', async () => {
    const a = await prisma.session.create({ data: { slug: `dc-f1-${Date.now()}`, title: 'Helio 电话测试', model: 'm', permissionProfile: 'web', status: 'active' } });
    const b = await prisma.session.create({ data: { slug: `dc-f2-${Date.now()}`, title: '别的事', model: 'm', permissionProfile: 'web', status: 'completed' } });
    created.push(a.id, b.id);
    await prisma.message.create({ data: { sessionId: b.id, role: 'user', type: 'user', content: [], text: '顺便看看 Helio 的新楼' } });
    await bridge.onMessage(msg(HOME, '!找 Helio'));
    const card = port.sent.filter((s) => s.channelId === HOME).at(-1)!;
    expect(card.p.content).toContain('找到 2 个对话');
    const opts = card.p.selects![0]!.options;
    expect(opts.map((o) => o.value).sort()).toEqual([a.id, b.id].sort());
    expect(opts.find((o) => o.value === b.id)!.description).toContain('已完成（只读）');
  });

  it('documents are posted as page previews with a 「▶ 后 N 页」 button', async () => {
    const sandbox = sessionPaths(s1).sandbox;
    fs.mkdirSync(path.join(sandbox, 'output'), { recursive: true });
    const doc = path.join(sandbox, 'output', 'report.docx');
    fs.writeFileSync(doc, 'docx-bytes');
    await bridge.postPreview(s1, doc, 1);
    const first = port.inThread(thread).at(-1)!;
    expect(first.p.content).toContain('📄 **report.docx** · 第 1–3 页 / 共 5 页');
    expect(first.p.files!.map((f) => path.basename(f))).toEqual(['page-1.png', 'page-2.png', 'page-3.png', 'report.docx', 'report.pdf']);
    expect(first.p.buttons![0]![0]).toMatchObject({ id: 'pvnext', label: '▶ 后 2 页' });

    await bridge.onButton('pvnext', OWNER, thread, first.id);
    const next = port.inThread(thread).at(-1)!;
    expect(next.p.content).toContain('第 4–5 页 / 共 5 页');
    expect(next.p.files!.map((f) => path.basename(f))).toEqual(['page-4.png', 'page-5.png']);
    expect(next.p.buttons).toBeUndefined();
  });

  it('!预览 previews a sandbox file by name, or lets you pick', async () => {
    const sandbox = sessionPaths(s1).sandbox;
    fs.mkdirSync(path.join(sandbox, 'output'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'output', 'notes.md'), '# 笔记\n租金涨了 3%');
    fs.writeFileSync(path.join(sandbox, 'output', 'deck.docx'), 'x');
    await bridge.onMessage(msg(thread, '!预览 notes'));
    expect(port.inThread(thread).at(-1)!.p.content).toContain('📄 **notes.md**\n```md\n# 笔记\n租金涨了 3%');

    await bridge.onMessage(msg(thread, '!预览'));
    const pick = port.inThread(thread).at(-1)!;
    const menu = pick.p.selects![0]!;
    expect(menu.id).toBe(`pvsel:${s1}`);
    const deck = menu.options.find((o) => o.label === 'deck.docx')!;
    await bridge.onSelect(menu.id, OWNER, deck.value, thread, pick.id);
    expect(port.inThread(thread).at(-1)!.p.content).toContain('📄 **deck.docx**');
  });

  it('what you type on the computer is mirrored into the thread; Discord messages are not echoed back', async () => {
    const userMsg = (text: string) =>
      bus.emit({ type: 'user.message', sessionId: s1, message: { id: 'x', sessionId: s1, role: 'user', type: 'user', text, tokens: 0, agentRunId: null, createdAt: '' } });
    userMsg('把 2B 的数据也加上\n第二行\n\n[本次上传的文件（位于会话沙盘，可直接读取/编辑）]\n- a.pdf → uploads/a.pdf\n- b.png → uploads/b.png');
    await vi.waitFor(() => expect(port.inThread(thread).some((p) => p.p.content.startsWith('💻'))).toBe(true));
    expect(port.inThread(thread).at(-1)!.p.content).toBe('💻 **你在电脑上说**\n> 把 2B 的数据也加上\n> 第二行\n📎 2 个附件');

    userMsg('[定时任务] 每日检查'); // system-injected → not mirrored
    const before = port.inThread(thread).length;
    await bridge.onMessage(msg(thread, '手机上发的')); // from Discord → forwarded, not echoed
    await new Promise((r) => setTimeout(r, 50));
    expect(orch.calls.messages.at(-1)).toEqual({ sessionId: s1, text: '手机上发的' });
    expect(port.inThread(thread).slice(before).some((p) => p.p.content.startsWith('💻'))).toBe(false);
  });

  it('typed answers still work (number or free text)', async () => {
    const q = await prisma.pendingQuestion.create({ data: { sessionId: s1, question: '用哪个？', options: ['旧模板', '新模板'], status: 'open' } });
    await bridge.onMessage(msg(thread, '还是用新的吧'));
    expect(orch.calls.answers).toEqual([{ questionId: q.id, answer: '新模板' }]);
  });

  it('approval: 批准 button, and 修改 opens a form whose text becomes the feedback', async () => {
    const a = await prisma.approval.create({ data: { sessionId: s1, summary: '竞品表做完了', artifacts: [], status: 'open' } });
    bus.emit({ type: 'approval.request', sessionId: s1, approval: { id: a.id, sessionId: s1, summary: a.summary, artifacts: [], status: 'open', feedback: null, createdAt: '' } });
    await vi.waitFor(() => expect(port.inThread(thread).some((p) => p.p.content.startsWith('📋'))).toBe(true));
    const card = port.inThread(thread).find((p) => p.p.content.startsWith('📋'))!;
    expect(card.p.buttons![0]!.map((b) => b.label)).toEqual(['✅ 批准', '✏️ 修改', '❌ 驳回']);

    expect(bridge.modalFor(`a:${a.id}:revise`)).toEqual({ id: `am:${a.id}`, title: '修改意见', label: '要怎么改？' });
    expect(bridge.modalFor(`a:${a.id}:approve`)).toBeNull();
    await bridge.onModal(`am:${a.id}`, OWNER, '标题改短一点');
    expect(orch.calls.decisions).toEqual([{ approvalId: a.id, decision: 'revise', feedback: '标题改短一点' }]);
    await vi.waitFor(() => expect(port.edits.at(-1)?.p.content).toContain('已发回修改：标题改短一点'));

    const a2 = await prisma.approval.create({ data: { sessionId: s1, summary: '第二版', artifacts: [], status: 'open' } });
    await bridge.onButton(`a:${a2.id}:approve`, OWNER, thread, 'x');
    expect(orch.calls.decisions[1]).toEqual({ approvalId: a2.id, decision: 'approve', feedback: undefined });
  });

  it('a question answered on the computer is marked so in Discord', async () => {
    const q = await prisma.pendingQuestion.create({ data: { sessionId: s1, question: '继续吗？', status: 'open' } });
    bus.emit({ type: 'question.open', sessionId: s1, question: { id: q.id, sessionId: s1, agentRunId: null, question: q.question, options: null, answer: null, status: 'open', source: 'agent', createdAt: '' } });
    await vi.waitFor(() => expect(port.inThread(thread).some((p) => p.p.content.includes('继续吗'))).toBe(true));
    await prisma.pendingQuestion.update({ where: { id: q.id }, data: { status: 'answered', answer: '继续' } });
    bus.emit({ type: 'question.closed', sessionId: s1, questionId: q.id });
    await vi.waitFor(() => expect(port.edits.at(-1)?.p.content).toContain('已在电脑上回答：继续'));
  });

  it('format feedback becomes a preference instead of a task message', async () => {
    await bridge.onMessage(msg(thread, '太长了，只要结论'));
    expect(orch.calls.messages).toHaveLength(0);
    expect(stubTranslator.recordPreference).toHaveBeenCalledWith('完成推送只说结论', s1);
    expect(port.inThread(thread).at(-1)!.p.content).toBe('好，以后只说结论');
  });

  it('!停 interrupts and suppresses the result; !断开 archives the thread', async () => {
    bus.emit({ type: 'run.state', sessionId: s1, state: 'running' });
    await bridge.onMessage(msg(thread, '!停'));
    expect(orch.calls.interrupts).toEqual([s1]);
    await prisma.message.create({ data: { sessionId: s1, role: 'assistant', type: 'assistant', content: [], text: '半截输出' } });
    bus.emit({ type: 'run.state', sessionId: s1, state: 'idle' });
    await bridge.finalizeTurn(s1);
    expect(port.inThread(thread).some((p) => p.p.content.startsWith('✅'))).toBe(false);

    await bridge.onMessage(msg(thread, '!断开'));
    expect(port.archived.get(thread)).toBe(true);
    expect(bridge.sessionState(s1).connected).toBe(false);
  });

  async function makeSop(name: string, state: 'confirmed' | 'draft' = 'confirmed') {
    const w = await prisma.workflow.create({
      data: {
        slug: `dc-sop-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        status: state,
        confirmedVersion: state === 'confirmed' ? 1 : null,
        versions: { create: { version: 1, graph: GRAPH as unknown as object, state, confirmedAt: state === 'confirmed' ? new Date() : null } },
      },
    });
    workflows.push(w.id);
    return w;
  }

  it('!流程 lists confirmed SOPs; picking one starts it here with a live progress card', async () => {
    const w = await makeSop(`名单清洗-${Date.now()}`);
    await bridge.onMessage(msg(thread, '!流程'));
    const card = port.inThread(thread).at(-1)!;
    const menu = card.p.selects!.find((x) => x.id === `wfstart:${s1}`)!;
    expect(menu.options.map((o) => o.value)).toContain(w.slug);

    expect(await bridge.onSelect(menu.id, OWNER, w.slug, thread, card.id)).toBeNull();
    expect(orch.calls.messages.at(-1)!.text.startsWith(`[工作流] 用户已启动「${w.name}」`)).toBe(true);
    await vi.waitFor(() => expect(port.inThread(thread).some((p) => p.p.content.startsWith('🧭'))).toBe(true));
    const live = port.inThread(thread).find((p) => p.p.content.startsWith('🧭'))!;
    expect(live.p.content).toContain('1. **拉取名单**');
    expect(live.p.content).toContain('◻ 1.1 导出 CSV');
    expect(live.p.content).toContain('⚪ 2. 核对电话');
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { sessionId: s1 } });
    expect(live.p.selects![0]!.id).toBe(`wfnode:${run.id}`);
    expect(live.p.buttons![0]![0]).toMatchObject({ id: `wfstop:${run.id}`, style: 'danger' });

    // A second start in the same session is refused (one run at a time).
    await bridge.onMessage(msg(thread, '!流程'));
    expect(port.inThread(thread).at(-1)!.p.content).toContain('已有进行中的工作流');
  });

  it('stage transitions notify; the finished run edits the card and drops the stop button', async () => {
    const base: WorkflowRunDTO = {
      id: `run-${Math.random().toString(36).slice(2, 8)}`,
      workflowId: 'w',
      workflowName: '名单清洗',
      version: 2,
      sessionId: s1,
      label: '批次A',
      status: 'running',
      graph: GRAPH,
      cursor: { nodeId: 'pull', iterKey: '' },
      pendingToken: null,
      nodeRuns: [
        {
          id: 'n1', nodeId: 'pull', iterKey: '', status: 'dispatched', agentId: null, agentRunId: null, summary: null, evidence: null, review: null, attempts: 1,
          substeps: [{ id: 'a', status: 'done', note: '导出 120 行' }, { id: 'b', status: 'pending', note: null }], progress: 48, startedAt: null, endedAt: null,
        },
        { id: 'n2', nodeId: 'call', iterKey: '', status: 'pending', agentId: null, agentRunId: null, summary: null, evidence: null, review: null, attempts: 0, substeps: [], progress: 0, startedAt: null, endedAt: null },
      ],
      createdAt: '',
      endedAt: null,
    };
    await bridge.onWorkflowUpdate(s1, base);
    const card = port.inThread(thread).at(-1)!;
    expect(card.p.content).toContain('🧭 **名单清洗** · v2 · 批次A');
    expect(card.p.content).toContain('✓ 1.1 导出 CSV');
    expect(card.p.content).toContain('**24%**');

    const stage1Done: WorkflowRunDTO = {
      ...base,
      cursor: { nodeId: 'call', iterKey: '' },
      nodeRuns: [
        { ...base.nodeRuns[0]!, status: 'done', progress: 100 },
        { ...base.nodeRuns[1]!, status: 'dispatched', progress: 15 },
      ],
    };
    await bridge.onWorkflowUpdate(s1, stage1Done);
    expect(port.inThread(thread).at(-1)!.p.content).toBe('✅ 阶段 1/2「拉取名单」完成');

    const done: WorkflowRunDTO = { ...stage1Done, status: 'done', cursor: null, nodeRuns: stage1Done.nodeRuns.map((n) => ({ ...n, status: 'done', progress: 100 })) };
    await bridge.onWorkflowUpdate(s1, done);
    const last = port.edits.filter((e) => e.messageId === card.id).at(-1)!;
    expect(last.p.content).toContain('**100%** · 全部完成');
    expect(last.p.buttons).toBeUndefined();
    expect(port.inThread(thread).at(-1)!.p.content).toBe('✅ 阶段 2/2「核对电话」完成\n🏁 工作流「名单清洗」全部完成');
  });

  it('stage detail dropdown shows sub-steps, the hand-off and the review', async () => {
    const w = await makeSop(`详情-${Date.now()}`);
    await bridge.onSelect(`wfstart:${s1}`, OWNER, w.slug, thread, 'x');
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { sessionId: s1 } });
    await prisma.workflowNodeRun.updateMany({
      where: { runId: run.id, nodeId: 'pull' },
      data: {
        status: 'done',
        summary: '导出 120 行，去重后 98 行',
        substeps: [{ id: 'a', status: 'done', note: '120 行' }, { id: 'b', status: 'na', note: '没有重复' }],
        review: { decision: 'accept', perCriterion: [{ criterion: '阶段 1 拉取名单完成', verdict: 'met', reason: '' }], feedback: '不错' },
      },
    });
    await bridge.onSelect(`wfnode:${run.id}`, OWNER, 'pull', thread, 'x');
    const detail = port.inThread(thread).at(-1)!.p.content;
    expect(detail).toContain('🔍 **阶段 1/2：拉取名单**');
    expect(detail).toContain('✓ 1.1 导出 CSV：120 行');
    expect(detail).toContain('— 1.2 去重：没有重复');
    expect(detail).toContain('导出 120 行，去重后 98 行');
    expect(detail).toContain('**主 AI 审核**：✓ 通过 — 不错');
  });

  it('⏹ 停止工作流 asks first, then cancels the run and tells the main AI', async () => {
    const w = await makeSop(`停止-${Date.now()}`);
    await bridge.onSelect(`wfstart:${s1}`, OWNER, w.slug, thread, 'x');
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { sessionId: s1 } });
    await bridge.onButton(`wfstop:${run.id}`, OWNER, thread, 'card');
    const ask = port.inThread(thread).at(-1)!;
    expect(ask.p.buttons![0]!.map((b) => b.id)).toEqual([`wfstopy:${run.id}`, 'cancel']);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('running');

    await bridge.onButton(`wfstopy:${run.id}`, OWNER, thread, ask.id);
    expect((await prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('cancelled');
    expect(orch.calls.messages.at(-1)!.text).toMatch(/^\[工作流\] .*工作流已结束/);
    expect(port.edits.find((e) => e.messageId === ask.id)!.p.content).toBe('⏹ 已停止工作流。');
  });

  it('AI-drafted SOPs can be reviewed and confirmed (exactly the version shown)', async () => {
    const w = await makeSop(`草稿-${Date.now()}`, 'draft');
    await bridge.onMessage(msg(HOME, '!流程'));
    const list = port.sent.filter((x) => x.channelId === HOME).at(-1)!;
    const drafts = list.p.selects!.find((x) => x.id === 'wfdraft')!;
    expect(drafts.options.find((o) => o.value === w.id)!.description).toContain('草稿 v1（未确认，不能运行）');

    await bridge.onSelect('wfdraft', OWNER, w.id, HOME, list.id);
    const card = port.sent.filter((x) => x.channelId === HOME).at(-1)!;
    expect(card.p.content).toContain('1. 拉取名单（2 个子步骤）');
    expect(card.p.buttons![0]![0]!.id).toBe(`wfok:${w.id}:1`);

    await bridge.onButton(`wfok:${w.id}:2`, OWNER, HOME, card.id); // stale version
    expect((await prisma.workflow.findUniqueOrThrow({ where: { id: w.id } })).status).toBe('draft');
    await bridge.onButton(`wfok:${w.id}:1`, OWNER, HOME, card.id);
    const after = await prisma.workflow.findUniqueOrThrow({ where: { id: w.id } });
    expect(after).toMatchObject({ status: 'confirmed', confirmedVersion: 1 });
    expect(port.edits.at(-1)!.p.content).toContain('✅ 已确认');
  });

  it('!流程 <name> in the channel starts the SOP in a new task', async () => {
    const w = await makeSop(`频道-${Date.now()}`);
    await bridge.onMessage(msg(HOME, `!流程 ${w.name}`));
    const run = await prisma.workflowRun.findFirstOrThrow({ where: { workflowId: w.id } });
    created.push(run.sessionId);
    expect(run.sessionId).not.toBe(s1);
    expect(port.threads).toHaveLength(2);
    expect(port.sent.filter((x) => x.channelId === HOME).at(-1)!.p.content).toContain(`🧭 已开始「${w.name}」`);
  });

  it('!进度 shows the task flow when there is no workflow', async () => {
    await prisma.planTask.createMany({
      data: [
        { sessionId: s1, ordinal: 1, text: '1. 抓取竞品', status: 'done' },
        { sessionId: s1, ordinal: 2, text: '2. 算净租金', status: 'in_progress' },
        { sessionId: s1, ordinal: 3, text: '3. 写报告', status: 'pending' },
      ],
    });
    await bridge.onMessage(msg(thread, '!进度'));
    const out = port.inThread(thread).at(-1)!.p.content;
    expect(out).toContain('🗂 **任务流 · 竞品租金分析**');
    expect(out).toContain('**50%** · 1/3 步');
    expect(out).toContain('🔵 算净租金');
  });

  it('notifications reach the thread (question/approval ones come as cards instead)', async () => {
    bus.emit({ type: 'notification', sessionId: s1, level: 'error', title: '质检：疑似卡住', body: '20 分钟没有进展' });
    bus.emit({ type: 'notification', sessionId: s1, level: 'question', title: 'AI 需要你的输入', body: '用哪个？' });
    await vi.waitFor(() => expect(port.inThread(thread).some((p) => p.p.content.includes('疑似卡住'))).toBe(true));
    expect(port.inThread(thread).at(-1)!.p.content).toBe('⚠️ **质检：疑似卡住**：20 分钟没有进展');
    expect(port.inThread(thread).some((p) => p.p.content.includes('AI 需要你的输入'))).toBe(false);
  });

  it('!质检 runs the advisor; !归档 asks, then archives', async () => {
    await bridge.onMessage(msg(thread, '!质检'));
    expect(orch.calls.quality).toEqual([s1]);
    await bridge.onMessage(msg(thread, '!归档'));
    const ask = port.inThread(thread).at(-1)!;
    expect(ask.p.buttons![0]!.map((b) => b.id)).toEqual([`arch:${s1}`, 'cancel']);
    await bridge.onButton(`arch:${s1}`, OWNER, thread, ask.id);
    expect(orch.calls.completed).toEqual([s1]);
    expect(port.edits.at(-1)!.p.content).toContain('📦 已标记出色完成并归档');
  });

  it('a new title from the AI renames the thread', async () => {
    const row = await prisma.session.update({ where: { id: s1 }, data: { title: '1133 Hope 竞品净租金' } });
    bus.emit({ type: 'session.updated', session: toSessionDTO(row) });
    await vi.waitFor(() => expect(port.renamed).toEqual([{ threadId: thread, name: 'chapi · 1133 Hope 竞品净租金' }]));
  });

  // ── board: today / projects / automations ──────────────────────────────────

  const automations: string[] = [];
  async function makeAutomation(name: string, extra: Record<string, unknown> = {}) {
    const a = await prisma.automation.create({
      data: { name, schedule: { kind: 'daily', time: '09:00' }, prompt: `按指令跑 ${name}`, mode: 'manual', enabled: true, ...extra },
    });
    automations.push(a.id);
    return a;
  }
  async function cleanupAutomations() {
    const runs = await prisma.automationRun.findMany({ where: { automationId: { in: automations } }, select: { sessionId: true } });
    created.push(...runs.map((r) => r.sessionId).filter((x): x is string => Boolean(x) && !created.includes(x!)));
    await prisma.discordOutbound.deleteMany({ where: { OR: automations.map((id) => ({ refId: { startsWith: `remind:${id}@` } })) } });
    await prisma.automation.deleteMany({ where: { id: { in: automations } } });
    automations.length = 0;
  }

  /** 'HH:mm' in Pacific time, `minutesAgo` before now. */
  function ptTime(minutesAgo: number): string {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(Date.now() - minutesAgo * 60_000));
    return `${p.find((x) => x.type === 'hour')!.value}:${p.find((x) => x.type === 'minute')!.value}`;
  }

  it('!今天 shows the board columns with a dropdown to open any of them', async () => {
    const q = await prisma.pendingQuestion.create({ data: { sessionId: s1, question: '用哪版？', status: 'open' } });
    await bridge.onMessage(msg(HOME, '!今天'));
    const card = port.sent.filter((x) => x.channelId === HOME).at(-1)!;
    expect(card.p.content).toContain('📋 **今天的看板**');
    expect(card.p.content).toMatch(/🟠 \*\*等你\*\*（\d+）/);
    expect(card.p.content).toContain('🧵 竞品租金分析');
    expect(card.p.content).toContain('等你回答');
    const menu = card.p.selects![0]!;
    expect(menu.id).toBe('resume');
    expect(menu.options.find((o) => o.value === s1)!.description).toContain('等你');
    await prisma.pendingQuestion.delete({ where: { id: q.id } });
  });

  it('!项目 lists projects; picking one lists its conversations; in a thread it moves the task', async () => {
    const p = await prisma.project.create({ data: { name: `测试项目-${Date.now()}`, summary: '竞品研究' } });
    try {
      await prisma.session.update({ where: { id: s1 }, data: { projectId: p.id } });
      await bridge.onMessage(msg(HOME, '!项目'));
      const list = port.sent.filter((x) => x.channelId === HOME).at(-1)!;
      expect(list.p.content).toContain(`**${p.name}** · 1 个对话`);
      await bridge.onSelect('proj', OWNER, p.id, HOME, list.id);
      const inProject = port.sent.filter((x) => x.channelId === HOME).at(-1)!;
      expect(inProject.p.content).toContain('🧵 竞品租金分析');
      expect(inProject.p.selects![0]!.options.map((o) => o.value)).toEqual([s1]);

      await bridge.onMessage(msg(thread, '!项目'));
      const picker = port.inThread(thread).at(-1)!;
      expect(picker.p.content).toContain(`现在在：**${p.name}**`);
      await bridge.onSelect(`projset:${s1}`, OWNER, 'none', thread, picker.id);
      expect(await prisma.session.findUniqueOrThrow({ where: { id: s1 } })).toMatchObject({ projectId: null, projectSource: 'user' });
      expect(port.edits.at(-1)!.p.content).toBe('🗂 已移到：**未归类**');
    } finally {
      await prisma.session.update({ where: { id: s1 }, data: { projectId: null } });
      await prisma.project.delete({ where: { id: p.id } });
    }
  });

  it('!自动化 lists tasks; the card runs one now (thread opens) and toggles enable; auto needs a confirmed SOP', async () => {
    try {
      const a = await makeAutomation(`周报-${Date.now()}`);
      await bridge.onMessage(msg(HOME, '!自动化'));
      const list = port.sent.filter((x) => x.channelId === HOME).at(-1)!;
      expect(list.p.content).toContain(`**${a.name}** · 每天 09:00 · 手动`);
      expect(list.p.selects![0]!.id).toBe('auto');

      await bridge.onSelect('auto', OWNER, a.id, HOME, list.id);
      const card = port.sent.filter((x) => x.channelId === HOME).at(-1)!;
      expect(card.p.buttons![0]!.map((b) => b.id)).toEqual([`autorun:${a.id}`, `automode:${a.id}`, `autoen:${a.id}`]);
      expect(card.p.buttons![0]![1]!.disabled).toBe(true); // no confirmed SOP → can't go auto

      await bridge.onButton(`autorun:${a.id}`, OWNER, HOME, card.id);
      const run = await prisma.automationRun.findFirstOrThrow({ where: { automationId: a.id } });
      expect(run.sessionId).toBeTruthy();
      created.push(run.sessionId!);
      expect(bridge.sessionState(run.sessionId!).connected).toBe(true);
      await vi.waitFor(() => expect(orch.calls.messages.some((x) => x.sessionId === run.sessionId && x.text.includes(`按指令跑 ${a.name}`))).toBe(true));
      expect(port.edits.at(-1)!.p.content).toContain('▶ 已开跑 → <#');

      await bridge.onButton(`autoen:${a.id}`, OWNER, HOME, card.id);
      expect((await prisma.automation.findUniqueOrThrow({ where: { id: a.id } })).enabled).toBe(false);
      expect(port.edits.at(-1)!.p.content).toContain('✓ 已停用');
      await bridge.onButton(`automode:${a.id}`, OWNER, HOME, card.id);
      expect(port.edits.at(-1)!.p.content).toContain('没改成');
    } finally {
      await cleanupAutomations();
    }
  });

  it('a manual automation whose slot just came pings the channel once, with ▶', async () => {
    try {
      const a = await makeAutomation(`EOD-${Date.now()}`, { schedule: { kind: 'daily', time: ptTime(3) }, createdAt: new Date(Date.now() - 86_400_000) });
      await bridge.boardTick();
      const ping = port.sent.filter((x) => x.channelId === HOME && x.p.content.includes(a.name));
      expect(ping).toHaveLength(1);
      expect(ping[0]!.p.content).toContain('⏰ **到点了');
      expect(ping[0]!.p.buttons![0]![0]!.id).toBe(`autorun:${a.id}`);
      await bridge.boardTick(); // no repeat
      expect(port.sent.filter((x) => x.channelId === HOME && x.p.content.includes(a.name))).toHaveLength(1);
    } finally {
      await cleanupAutomations();
    }
  });

  it('an automation run that starts on its own gets a thread (unless turned off)', async () => {
    try {
      const a = await makeAutomation(`QuickBooks-${Date.now()}`);
      const other = await prisma.session.create({ data: { slug: `dc-auto-${Date.now()}`, title: 'QuickBooks 发票核对', model: 'm', permissionProfile: 'web', status: 'active' } });
      created.push(other.id);
      await prisma.automationRun.create({ data: { automationId: a.id, sessionId: other.id, trigger: 'cron', status: 'running' } });
      await bridge.connectAutomationRuns();
      expect(bridge.sessionState(other.id).connected).toBe(true);
      expect(port.sent.filter((x) => x.channelId === HOME).at(-1)!.p.content).toContain(`⏰ 自动化「${a.name}」开跑了`);

      // Disconnected by hand → not reconnected.
      await bridge.disconnect(other.id);
      await bridge.connectAutomationRuns();
      expect(bridge.sessionState(other.id).connected).toBe(false);
    } finally {
      await cleanupAutomations();
    }
  });

  it('alerts without a session go to the channel', async () => {
    bus.emit({ type: 'notification', sessionId: null, level: 'error', title: '自动化运行失败', body: '「三表同步」SOP 未确认' });
    await vi.waitFor(() => expect(port.sent.some((x) => x.channelId === HOME && x.p.content === '⚠️ **自动化运行失败**：「三表同步」SOP 未确认')).toBe(true));
  });
});

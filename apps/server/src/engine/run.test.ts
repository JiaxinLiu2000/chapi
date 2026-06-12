import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerEvent } from '@chapi/shared';
import { prisma } from '../db/client.js';
import { bus } from '../gateway/bus.js';
import { Run } from './run.js';

function fakeQuery(messages: SDKMessage[]): Query {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for (const m of messages) yield m;
  }
  const g = gen() as unknown as Query & { interrupt: () => Promise<void> };
  g.interrupt = async () => undefined;
  return g;
}

const SYNTHETIC = [
  {
    type: 'system',
    subtype: 'init',
    session_id: 'sdk-uuid-123',
    cwd: '/x',
    tools: [],
    mcp_servers: [],
    model: 'claude-opus-4-8',
    apiKeySource: 'user',
    claude_code_version: 'test',
  },
  {
    type: 'stream_event',
    uuid: 'm1',
    parent_tool_use_id: null,
    session_id: 'sdk-uuid-123',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
  },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    uuid: 'm1',
    session_id: 'sdk-uuid-123',
    message: { content: [{ type: 'text', text: 'Hello!' }] },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 1000,
    num_turns: 1,
    result: 'Hello!',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'r1',
    session_id: 'sdk-uuid-123',
  },
] as unknown as SDKMessage[];

describe('Run engine', () => {
  let sessionId: string;
  const events: ServerEvent[] = [];
  let off: () => void;

  beforeAll(async () => {
    const s = await prisma.session.create({
      data: {
        slug: `test-${Date.now()}`,
        title: 'engine test',
        model: 'claude-opus-4-8',
        permissionProfile: 'web',
        status: 'active',
      },
    });
    sessionId = s.id;
    off = bus.on((e) => events.push(e));
  });

  afterAll(async () => {
    off();
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('streams an assistant message, accounts usage, and persists', async () => {
    const run = new Run(sessionId, () => fakeQuery(SYNTHETIC));
    await run.pushUserMessage('hi');
    await run.waitIdle();

    const types = events.filter((e) => sessionEventId(e) === sessionId).map((e) => e.type);
    expect(types).toContain('assistant.message');
    expect(types).toContain('usage.updated');
    expect(types).toContain('run.state');

    const assistant = events.find((e) => e.type === 'assistant.message');
    expect(assistant && assistant.type === 'assistant.message' && assistant.message.text).toBe(
      'Hello!',
    );

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    expect(session?.sdkSessionId).toBe('sdk-uuid-123');
    expect(session?.totalTokens).toBe(15);
    expect(session?.activeMs).toBe(1234);

    const msgs = await prisma.message.findMany({ where: { sessionId } });
    expect(msgs.some((m) => m.role === 'assistant' && m.text === 'Hello!')).toBe(true);

    // After a turn completes the main agent settles to 'idle' (waiting for the
    // next message), not 'done' — the long-lived run stays available.
    const main = await prisma.agentRun.findFirst({ where: { sessionId, name: 'main' } });
    expect(main?.status).toBe('idle');
    expect(main?.currentTool).toBeNull();
  });
});

function sessionEventId(e: ServerEvent): string | null {
  if (e.type === 'session.created' || e.type === 'session.updated') return e.session.id;
  if ('sessionId' in e) return e.sessionId;
  return null;
}

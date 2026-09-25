import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { prisma } from '../db/client.js';
import { SdkOrchestrator } from './orchestrator.js';
import type { QueryFn } from './run.js';

// A harmless query() stand-in — never touches the network — so a fresh Run
// spun up during these tests doesn't try to make a real Claude API call.
function fakeQuery(): Query {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-uuid-race-test',
      cwd: '/x',
      tools: [],
      mcp_servers: [],
      model: 'claude-opus-4-8',
      apiKeySource: 'user',
      claude_code_version: 'test',
    } as unknown as SDKMessage;
  }
  const g = gen() as unknown as Query & { interrupt: () => Promise<void> };
  g.interrupt = async () => undefined;
  return g;
}
const fakeQueryFn: QueryFn = () => fakeQuery();

/**
 * A `set.config` account-mode switch and a `user.message` are two independent
 * WebSocket messages; if the switch's own run-teardown hasn't finished by the
 * time a racing message is handled, the still-live run would silently push
 * that turn out on its *old* pin. `handleUserMessage` guards against this by
 * comparing the live run's started pin against the session's current one.
 */
describe('SdkOrchestrator.handleUserMessage — stale account-pin race guard', () => {
  let sessionId: string;

  beforeEach(async () => {
    const s = await prisma.session.create({
      data: {
        slug: `race-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: 'race test',
        model: 'claude-opus-4-8',
        permissionProfile: 'web',
        status: 'active',
        accountMode: 'primary', // the session was just switched to a manual pin
      },
    });
    sessionId = s.id;
  });

  afterEach(async () => {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => undefined);
  });

  it('tears down a run started under a stale pin before reusing it', async () => {
    const orchestrator = new SdkOrchestrator(fakeQueryFn);
    const stop = async () => undefined;
    let stopCalls = 0;
    const staleRun = {
      getStartedAccountMode: () => 'auto' as const, // started before the switch to 'primary'
      stop: async () => {
        stopCalls += 1;
        await stop();
      },
      pushUserMessage: async () => undefined,
    };
    const runs = (orchestrator as unknown as { runs: Map<string, unknown> }).runs;
    runs.set(sessionId, staleRun);

    await orchestrator.handleUserMessage(sessionId, 'hello');

    expect(stopCalls).toBe(1);
    // A fresh Run replaced the stale one — reusing the same object would mean
    // this message silently went out on the old 'auto'-resolved seat.
    expect(runs.get(sessionId)).not.toBe(staleRun);
  });

  it('does not tear down a run whose pin already matches the session', async () => {
    const orchestrator = new SdkOrchestrator(fakeQueryFn);
    let stopCalls = 0;
    let pushed: string | null = null;
    const matchingRun = {
      getStartedAccountMode: () => 'primary' as const,
      stop: async () => {
        stopCalls += 1;
      },
      pushUserMessage: async (text: string) => {
        pushed = text;
      },
    };
    const runs = (orchestrator as unknown as { runs: Map<string, unknown> }).runs;
    runs.set(sessionId, matchingRun);

    await orchestrator.handleUserMessage(sessionId, 'hello');

    expect(stopCalls).toBe(0);
    expect(pushed).toBe('hello');
    expect(runs.get(sessionId)).toBe(matchingRun);
  });
});

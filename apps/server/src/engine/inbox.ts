import type { RunState } from '@chapi/shared';
import { bus } from '../gateway/bus.js';
import { createLogger } from '../logger.js';
import { getOrchestrator } from '../orchestrator/types.js';

const log = createLogger('engine:inbox');

/**
 * The main agent's inbox for messages from the side agents (质检 advisor, 学习
 * learning agent). Nothing here ever blocks or interrupts the user's flow:
 *   - `deliver(…, 'now')`  → straight into the running turn when the main agent is
 *                             working; otherwise held for its next turn
 *   - `deliver(…, 'next')` → always held and attached to the next turn
 * `take()` is called when the next user turn is pushed to the run.
 */
class AgentInbox {
  private held = new Map<string, string[]>();
  private runStates = new Map<string, RunState>();

  constructor() {
    bus.on((e) => {
      if (e.type === 'run.state') this.runStates.set(e.sessionId, e.state);
    });
  }

  busy(sessionId: string): boolean {
    const st = this.runStates.get(sessionId);
    return st === 'running' || st === 'paused';
  }

  async deliver(sessionId: string, text: string, when: 'now' | 'next' = 'now'): Promise<'sent' | 'held'> {
    if (when === 'now' && this.busy(sessionId)) {
      try {
        await getOrchestrator().injectAdvice(sessionId, text);
        return 'sent';
      } catch (err) {
        log.warn('inject failed, holding for next turn', err);
      }
    }
    this.held.set(sessionId, [...(this.held.get(sessionId) ?? []), text]);
    return 'held';
  }

  /** Everything held for this session (cleared). */
  take(sessionId: string): string | null {
    const list = this.held.get(sessionId);
    if (!list?.length) return null;
    this.held.delete(sessionId);
    return list.join('\n\n');
  }

  pending(sessionId: string): number {
    return this.held.get(sessionId)?.length ?? 0;
  }
}

export const agentInbox = new AgentInbox();

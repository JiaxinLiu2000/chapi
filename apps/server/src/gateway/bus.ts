import type { RunState, ServerEvent } from '@chapi/shared';
import { createLogger } from '../logger.js';

const log = createLogger('bus');

type Listener = (event: ServerEvent) => void;

/**
 * Process-wide event bus. The engine/orchestrator emits ServerEvents here; the
 * WebSocket gateway subscribes and forwards matching events to each connection.
 * Single-user local app, so a flat fan-out + per-connection filtering is enough.
 */
export class EventBus {
  private listeners = new Set<Listener>();
  /**
   * Last `run.state` seen per session. `run.state` is only emitted on transitions,
   * so a client that (re)loads mid-run would otherwise never learn the run is
   * still going (no stop button). Recorded here so nothing can miss an event.
   */
  private runStates = new Map<string, RunState>();

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The session's current run state as last emitted ('idle' if never). */
  lastRunState(sessionId: string): RunState {
    return this.runStates.get(sessionId) ?? 'idle';
  }

  emit(event: ServerEvent): void {
    if (event.type === 'run.state') this.runStates.set(event.sessionId, event.state);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.error('listener threw', err);
      }
    }
  }
}

export const bus = new EventBus();

/** Events that every connected client should receive regardless of subscription. */
export function isGlobalEvent(event: ServerEvent): boolean {
  return (
    event.type === 'session.created' ||
    event.type === 'session.updated' ||
    event.type === 'session.attention' ||
    event.type === 'board.changed'
  );
}

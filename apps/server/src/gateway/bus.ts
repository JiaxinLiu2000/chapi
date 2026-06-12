import type { ServerEvent } from '@chapi/shared';
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

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
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
  return event.type === 'session.created' || event.type === 'session.updated';
}

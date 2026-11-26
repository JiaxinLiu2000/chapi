import type { ClientCommand, ServerEvent } from '@chapi/shared';
import { WS_URL } from './config';

type EventHandler = (event: ServerEvent) => void;

/**
 * Resilient WebSocket client. Auto-reconnects and re-subscribes to the active
 * session. One instance per browser tab.
 */
export class ChapiSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<EventHandler>();
  private subscribed = new Set<string>();
  private queue: ClientCommand[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      for (const sid of this.subscribed) {
        ws.send(JSON.stringify({ type: 'session.subscribe', sessionId: sid }));
      }
      const pending = this.queue;
      this.queue = [];
      for (const cmd of pending) ws.send(JSON.stringify(cmd));
    };

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data as string) as ServerEvent;
        for (const h of this.handlers) h(event);
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => {
      if (this.closedByUser) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, 1000);
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(cmd: ClientCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    } else {
      this.queue.push(cmd);
      this.open();
    }
  }

  subscribe(sessionId: string): void {
    this.subscribed.add(sessionId);
    this.send({ type: 'session.subscribe', sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.subscribed.delete(sessionId);
    this.send({ type: 'session.unsubscribe', sessionId });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

let singleton: ChapiSocket | null = null;

export function getSocket(): ChapiSocket {
  if (!singleton) {
    singleton = new ChapiSocket();
    singleton.connect();
  }
  return singleton;
}

/**
 * Board live updates: `board.changed` touches every board view at once (~400ms
 * coalescing); session-level global events (created / renamed / asking for you)
 * only move cards on "today", so they're debounced to one trailing call ~1.5s
 * after the burst ends.
 */
export function watchBoard(onChange: (scope: 'all' | 'today') => void): () => void {
  let allTimer: ReturnType<typeof setTimeout> | null = null;
  let todayTimer: ReturnType<typeof setTimeout> | null = null;
  const off = getSocket().on((e) => {
    if (e.type === 'board.changed') {
      if (allTimer) return;
      allTimer = setTimeout(() => {
        allTimer = null;
        onChange('all');
      }, 400);
    } else if (e.type === 'session.created' || e.type === 'session.updated' || e.type === 'session.attention') {
      if (todayTimer) clearTimeout(todayTimer);
      todayTimer = setTimeout(() => {
        todayTimer = null;
        onChange('today');
      }, 1500);
    }
  });
  return () => {
    off();
    if (allTimer) clearTimeout(allTimer);
    if (todayTimer) clearTimeout(todayTimer);
  };
}

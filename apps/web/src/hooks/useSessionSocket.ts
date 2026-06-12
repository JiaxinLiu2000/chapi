'use client';
import { useEffect } from 'react';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';

/** Subscribe the active session to the WebSocket and pipe events into the store. */
export function useSessionSocket(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return;
    const socket = getSocket();
    const off = socket.on((e) => useStore.getState().applyEvent(e));
    socket.subscribe(sessionId);
    return () => {
      off();
      socket.unsubscribe(sessionId);
    };
  }, [sessionId]);
}

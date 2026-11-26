'use client';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from '@/lib/store';
import { getSocket, watchBoard } from '@/lib/ws';
import type { NotificationLevel } from '@chapi/shared';

const LEVEL_BY_KIND: Record<string, NotificationLevel> = {
  question: 'question',
  approval: 'success',
  notify: 'info',
};
const PREFIX_BY_KIND: Record<string, string> = {
  question: '需要你的输入',
  approval: '成果待审批',
  notify: '通知',
};

/**
 * App-wide listener for `session.attention` events. When a *background* session
 * (one you're not currently viewing) asks a question / needs approval /
 * finishes, pops a clickable toast that navigates to that session. The active
 * session shows its own inline toast (via applyEvent), so we skip those here.
 */
export function GlobalAlerts() {
  const qc = useQueryClient();
  // Board queries (['board', …]) follow the server: invalidated here so any open view refetches.
  useEffect(
    () => watchBoard((scope) => void qc.invalidateQueries({ queryKey: scope === 'all' ? ['board'] : ['board', 'today'] })),
    [qc],
  );
  useEffect(() => {
    const socket = getSocket();
    const off = socket.on((e) => {
      if (e.type !== 'session.attention') return;
      if (e.sessionId === useStore.getState().sessionId) return; // active session handles itself
      useStore.setState({
        toast: {
          level: LEVEL_BY_KIND[e.kind] ?? 'info',
          title: `「${e.title}」${PREFIX_BY_KIND[e.kind] ?? '通知'}`,
          body: e.body,
          ts: Date.now(),
          sessionSlug: e.slug,
        },
      });
    });
    return off;
  }, []);
  return null;
}

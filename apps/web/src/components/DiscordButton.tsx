'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Run-config-bar toggle: give this conversation a Discord thread (pushes + replies). */
export function DiscordButton({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['discord-session', sessionId], queryFn: () => api.discordSession(sessionId), refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = data?.state;

  if (!st?.ready) return null; // not configured → keep the bar clean

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.discordConnect(sessionId, !st.connected);
      qc.setQueryData(['discord-session', sessionId], r);
      void qc.invalidateQueries({ queryKey: ['discord-status'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-1">
      <button
        className={`rounded-md border px-2 py-1 text-xs ${
          st.connected ? 'border-[#5865F2]/60 bg-[#5865F2]/15 text-[#a5adff]' : 'border-border text-muted hover:text-text'
        } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
        disabled={busy}
        onClick={toggle}
        title={err ?? (st.connected ? '已连到 Discord 子话题，点击断开' : '在 Discord 里给这个对话开一个子话题：结果/提问/审批发到手机，手机回复直接发给它')}
      >
        {busy ? '…' : st.connected ? '💬 Discord 已连接' : '💬 连到 Discord'}
      </button>
      {st.connected && st.threadUrl && (
        <a href={st.threadUrl} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-text" title="打开 Discord 子话题">
          ↗
        </a>
      )}
    </span>
  );
}

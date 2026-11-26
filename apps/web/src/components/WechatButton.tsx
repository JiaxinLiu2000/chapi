'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Run-config-bar toggle: connect this conversation to WeChat (pushes + replies). */
export function WechatButton({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['wechat-session', sessionId], queryFn: () => api.wechatSession(sessionId), refetchInterval: 15_000 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const st = data?.state;

  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.wechatConnect(sessionId, !st?.connected);
      qc.setQueryData(['wechat-session', sessionId], r);
      void qc.invalidateQueries({ queryKey: ['wechat-status'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!st?.loggedIn) return null; // not set up → keep the bar clean
  return (
    <button
      className={`rounded-md border px-2 py-1 text-xs ${
        st.connected ? 'border-[#22c55e]/50 bg-[#22c55e]/10 text-[#4ade80]' : 'border-border text-muted hover:text-text'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      disabled={busy}
      onClick={toggle}
      title={
        err ??
        (st.connected
          ? `已连接微信（标签 ${st.tag}${st.focused ? '，当前对话' : ''}）。点击断开。`
          : '把这个对话连接到微信：结果/提问/审批推到手机，手机回复直接发给它')
      }
    >
      {busy ? '…' : st.connected ? `📱 微信 [${st.tag}]` : '📱 连到微信'}
    </button>
  );
}

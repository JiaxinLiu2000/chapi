'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/Button';

const inputCls = 'w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text placeholder:text-muted/50';

/** Settings section: Discord remote — bot token, server invite, channel for task threads. */
export function DiscordPanel() {
  const { data, refetch } = useQuery({ queryKey: ['discord-status'], queryFn: api.discordStatus, refetchInterval: 5000 });
  const st = data?.status;
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const apply = async (input: { token?: string | null; channelId?: string | null }) => {
    setBusy(true);
    setErr(null);
    try {
      await api.discordConfigure(input);
      setToken('');
      await refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const chip = !st?.configured
    ? { text: '未配置', cls: 'bg-panel text-muted ring-border' }
    : !st.connected
      ? { text: '未连上', cls: 'bg-danger/10 text-danger ring-danger/40' }
      : !st.channelId
        ? { text: `已登录 ${st.botTag} · 还没选频道`, cls: 'bg-warn/10 text-warn ring-warn/40' }
        : { text: `已连接 ${st.botTag}`, cls: 'bg-[#22c55e]/15 text-[#4ade80] ring-[#22c55e]/40' };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <div className="text-xs font-semibold text-text">Discord 远程</div>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', chip.cls)}>{chip.text}</span>
      </div>
      <p className="text-[11px] text-muted/80">
        每个连到 Discord 的对话会在所选频道里开一个子话题：结果、提问（按钮选择）、审批（批准 / 修改 / 驳回）都发在里面，在子话题里打字就是发给这个对话；在频道里直接发消息 = 新建任务。只有机器人的主人（Developer Portal 里的应用所有者）能操作。
      </p>

      <div className="flex items-center gap-2">
        <input
          className={inputCls}
          type="password"
          placeholder={st?.configured ? 'Bot Token 已保存（粘贴新的可替换）' : 'Bot Token（Developer Portal → Bot → Reset Token）'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Button variant="outline" className="shrink-0 text-xs" disabled={busy || !token.trim()} onClick={() => apply({ token: token.trim() })}>
          {busy ? '连接中…' : '保存并连接'}
        </Button>
      </div>

      {st?.connected && (
        <div className="space-y-2 text-[11px] text-muted">
          {st.owners.length > 0 && <div>主人：{st.owners.join('、')}</div>}
          {st.inviteUrl && (
            <div>
              第一步：
              <a href={st.inviteUrl} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
                把机器人邀请进你的服务器
              </a>
              （建议建一个只有你自己的私人服务器）
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="shrink-0">第二步：任务子话题开在</span>
            <select
              className={inputCls}
              value={st.channelId ?? ''}
              disabled={busy}
              onChange={(e) => apply({ channelId: e.target.value || null })}
            >
              <option value="">{st.channels.length ? '选择频道…' : '（先邀请机器人进服务器，再刷新）'}</option>
              {st.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.guild} / #{c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 pt-1">
            {(
              [
                ['autoAutomations', '自动化任务开跑时（定时自动跑，或在电脑上点「运行」）自动在 Discord 开子话题'],
                ['remindManual', '手动模式的自动化到点时，在频道里提醒（带「▶ 现在运行」按钮）'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-xs text-text">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={st.prefs[key]}
                  disabled={busy}
                  onChange={async (e) => {
                    setBusy(true);
                    try {
                      await api.discordPrefs({ [key]: e.target.checked });
                      await refetch();
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          {st.bindings.length > 0 && (
            <div>
              已连接的对话：
              {st.bindings.map((b) => (
                <a key={b.sessionId} href={b.threadUrl ?? `/s/${b.slug}`} target="_blank" rel="noreferrer" className="ml-2 underline-offset-2 hover:underline">
                  {b.title}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
      {st?.lastError && <div className="text-[11px] text-danger">{st.lastError}</div>}
      {err && <div className="text-[11px] text-danger">{err}</div>}
      {st?.configured && (
        <Button variant="ghost" className="text-xs" disabled={busy} onClick={() => apply({ token: null })}>
          断开并清除 Token
        </Button>
      )}
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WechatLoginDTO } from '@chapi/shared';
import { api } from '@/lib/api';
import { cn, relativeTime } from '@/lib/utils';
import { Button } from './ui/Button';

/** Settings section: WeChat remote — QR login, status, connected sessions. */
export function WechatPanel() {
  const { data, refetch } = useQuery({ queryKey: ['wechat-status'], queryFn: api.wechatStatus, refetchInterval: 5000 });
  const st = data?.status;
  const [login, setLogin] = useState<WechatLoginDTO | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Poll the QR state while a login is in progress.
  const active = login && ['wait', 'scaned', 'need_verifycode'].includes(login.status);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      const r = await api.wechatLoginState().catch(() => null);
      if (r) setLogin(r.login);
      if (r?.login.status === 'confirmed') void refetch();
    }, 2000);
    return () => clearInterval(t);
  }, [active, refetch]);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      setLogin((await api.wechatStartLogin()).login);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api.wechatLogout().catch(() => undefined);
    setLogin(null);
    void refetch();
  };

  const statusChip = !st?.loggedIn
    ? { text: '未连接', cls: 'bg-panel text-muted ring-border' }
    : st.accountStatus === 'stale'
      ? { text: '登录失效，需重新扫码', cls: 'bg-danger/10 text-danger ring-danger/40' }
      : !st.pushReady
        ? { text: '已登录 · 先在微信里给它发一句话', cls: 'bg-warn/10 text-warn ring-warn/40' }
        : { text: st.polling ? '已连接' : '已登录（未在收消息）', cls: 'bg-[#22c55e]/15 text-[#4ade80] ring-[#22c55e]/40' };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <div className="text-xs font-semibold text-text">微信远程</div>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', statusChip.cls)}>{statusChip.text}</span>
      </div>
      <p className="text-[11px] text-muted/80">
        扫码后，在对话顶栏点「微信」就能用手机微信和这个对话聊天：结果、提问、审批会精简后推送到微信，回数字即可选择。电脑开机且 chapi 在运行时有效。
      </p>

      {st?.loggedIn && (
        <div className="space-y-1 text-[11px] text-muted">
          {st.lastInboundAt && <div>最近收到微信消息：{relativeTime(st.lastInboundAt)}</div>}
          {st.queued > 0 && <div className="text-warn">有 {st.queued} 条推送待补发（你下次在微信发消息时会自动补发）</div>}
          {st.lastError && <div className="text-danger">{st.lastError}</div>}
          {st.bindings.length > 0 ? (
            <div>
              已连接的对话：
              {st.bindings.map((b) => (
                <a key={b.sessionId} href={`/s/${b.slug}`} className="ml-2 underline-offset-2 hover:underline">
                  [{b.tag}] {b.title}
                  {b.focused ? '（当前）' : ''}
                </a>
              ))}
            </div>
          ) : (
            <div>还没有对话连接到微信。</div>
          )}
        </div>
      )}

      {login && login.status !== 'idle' && login.status !== 'confirmed' && (
        <div className="flex items-start gap-3">
          {login.qrSvg && ['wait', 'scaned', 'need_verifycode'].includes(login.status) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt="微信登录二维码"
              className="h-[180px] w-[180px] shrink-0 rounded-md bg-white p-1"
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(login.qrSvg)}`}
            />
          )}
          <div className="space-y-2 text-[11px] text-muted">
            <div>{login.message}</div>
            {login.status === 'need_verifycode' && (
              <div className="flex items-center gap-2">
                <input
                  className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-xs text-text"
                  value={code}
                  inputMode="numeric"
                  placeholder="手机上的数字"
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button
                  variant="outline"
                  className="text-xs"
                  onClick={async () => setLogin((await api.wechatVerify(code)).login)}
                >
                  提交
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      {login?.status === 'confirmed' && <div className="text-[11px] text-[#4ade80]">{login.message}</div>}
      {err && <div className="text-[11px] text-danger">{err}</div>}

      <div className="flex items-center gap-2">
        <Button variant="outline" className="text-xs" disabled={busy} onClick={start}>
          {busy ? '获取二维码…' : st?.loggedIn ? '重新扫码' : '扫码连接微信'}
        </Button>
        {st?.loggedIn && (
          <Button variant="ghost" className="text-xs" onClick={logout}>
            退出微信
          </Button>
        )}
      </div>
    </div>
  );
}

'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MODEL_OPTIONS, type BrowserStatusResponse, type UpdateSettingsInput } from '@chapi/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

function Field({
  label,
  hint,
  saved,
  children,
}: {
  label: string;
  hint?: string;
  saved?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {saved && (
          <span className="rounded-full bg-[#22c55e]/15 px-2 py-0.5 text-[10px] font-medium text-[#4ade80] ring-1 ring-inset ring-[#22c55e]/40">
            已保存
          </span>
        )}
      </div>
      {children}
      {hint && <div className="mt-1 text-[11px] text-muted/70">{hint}</div>}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-border bg-panel2 px-3 py-2 text-sm outline-none focus:border-accent';

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    enabled: open,
  });
  const s = data?.settings;

  const [form, setForm] = useState<UpdateSettingsInput>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (s)
      setForm({
        mainModel: s.mainModel,
        subagentModel: s.subagentModel,
        embeddingModel: s.embeddingModel,
        googleUserEmail: s.googleUserEmail,
        maxSubagents: s.maxSubagents,
        enableBrowser: s.enableBrowser,
      });
  }, [s]);

  const set = (k: keyof UpdateSettingsInput, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const [bBusy, setBBusy] = useState(false);
  const [bMsg, setBMsg] = useState('');
  const [bStatus, setBStatus] = useState<BrowserStatusResponse | null>(null);

  const refreshBrowser = async () => {
    try {
      setBStatus(await api.browserStatus());
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (open) void refreshBrowser();
  }, [open]);

  const startBrowser = async () => {
    setBBusy(true);
    setBMsg('正在启动浏览器服务…（首次需下载内核，请稍候并点“刷新状态”）');
    try {
      await api.updateSettings(form);
      const st = await api.browserStart();
      setBStatus(st);
      setBMsg(st.message);
    } catch (e) {
      setBMsg(e instanceof Error ? e.message : '启动失败');
    } finally {
      setBBusy(false);
    }
  };
  const browserLogin = async () => {
    setBBusy(true);
    setBMsg('正在打开浏览器登录页…（若刚启用，需等内核下载/启动）');
    try {
      await api.updateSettings(form);
      const r = await api.browserLogin();
      setBMsg(r.message);
      void refreshBrowser();
    } catch (e) {
      setBMsg(e instanceof Error ? e.message : '打开失败');
    } finally {
      setBBusy(false);
    }
  };

  const [gBusy, setGBusy] = useState(false);
  const [gMsg, setGMsg] = useState('');
  const [gStatus, setGStatus] = useState<'idle' | 'connected' | 'authorizing' | 'error'>('idle');
  const connectGoogle = async () => {
    setGBusy(true);
    setGStatus('idle');
    setGMsg('正在启动 Google 授权…（首次可能需下载 workspace-mcp，请稍候）');
    try {
      // Save any edited OAuth credentials first so the connect probe uses them.
      await api.updateSettings(form);
      const r = await api.connectGoogle();
      setGStatus(r.status);
      if (r.status === 'authorizing' && r.authUrl) {
        window.open(r.authUrl, '_blank', 'noopener,noreferrer');
        setGMsg(r.message + '（已在新标签打开授权页）');
      } else {
        setGMsg(r.message);
      }
      await refetch();
    } catch (e) {
      setGStatus('error');
      setGMsg(e instanceof Error ? e.message : '连接失败');
    } finally {
      setGBusy(false);
    }
  };

  // model dropdown: always include the current value, even if it's a custom id
  const modelOptions = (current?: string) => {
    const base = MODEL_OPTIONS.map((m) => ({ id: m.id, label: m.label }));
    return current && !base.some((m) => m.id === current)
      ? [{ id: current, label: current }, ...base]
      : base;
  };

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      await api.updateSettings(form);
      await refetch();
      setForm((f) => ({ ...f, openAiKey: '', googleOAuthClientId: '', googleOAuthClientSecret: '' }));
      setMsg('已保存');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const requestNotif = () => {
    if ('Notification' in window) Notification.requestPermission();
  };

  return (
    <Modal open={open} onClose={onClose} title="设置">
      <div className="space-y-4">
        <p className="text-xs text-muted/70">
          Claude 用本机 Claude Code 凭证运行，无需 Anthropic API Key。
        </p>
        <Field label="OpenAI API Key" saved={s?.hasOpenAiKey} hint={s?.hasOpenAiKey ? undefined : 'RAG 嵌入用'}>
          <input
            className={inputCls}
            type="password"
            placeholder={s?.hasOpenAiKey ? '••••••••' : 'sk-…'}
            value={form.openAiKey ?? ''}
            onChange={(e) => set('openAiKey', e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Google OAuth Client ID" saved={s?.hasGoogleOAuth}>
            <input
              className={inputCls}
              type="password"
              value={form.googleOAuthClientId ?? ''}
              placeholder={s?.hasGoogleOAuth ? '••••••••' : ''}
              onChange={(e) => set('googleOAuthClientId', e.target.value)}
            />
          </Field>
          <Field label="Google OAuth Client Secret" saved={s?.hasGoogleOAuth}>
            <input
              className={inputCls}
              type="password"
              placeholder={s?.hasGoogleOAuth ? '••••••••' : ''}
              onChange={(e) => set('googleOAuthClientSecret', e.target.value)}
            />
          </Field>
        </div>
        <Field label="Google 账号邮箱" hint="代理以此账号操作 Workspace/Drive/Gmail 草稿">
          <input
            className={inputCls}
            type="email"
            placeholder="name@gmail.com"
            value={form.googleUserEmail ?? ''}
            onChange={(e) => set('googleUserEmail', e.target.value)}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="text-xs" disabled={gBusy} onClick={connectGoogle}>
            {gBusy ? '授权中…' : '连接 Google（开始授权）'}
          </Button>
          {gStatus === 'connected' || (gStatus === 'idle' && s?.googleConnected) ? (
            <span className="rounded-full bg-[#22c55e]/15 px-2 py-0.5 text-[11px] font-medium text-[#4ade80] ring-1 ring-inset ring-[#22c55e]/40">
              Google 已连接，可直接使用
            </span>
          ) : gMsg ? (
            <span className={cn('text-[11px]', gStatus === 'error' ? 'text-danger' : 'text-muted')}>
              {gMsg}
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="主代理模型">
            <select
              className={inputCls}
              value={form.mainModel ?? ''}
              onChange={(e) => set('mainModel', e.target.value)}
            >
              {modelOptions(form.mainModel).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="子代理模型">
            <select
              className={inputCls}
              value={form.subagentModel ?? ''}
              onChange={(e) => set('subagentModel', e.target.value)}
            >
              {modelOptions(form.subagentModel).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="嵌入模型 (OpenAI)">
            <input
              className={inputCls}
              value={form.embeddingModel ?? ''}
              onChange={(e) => set('embeddingModel', e.target.value)}
            />
          </Field>
          <Field label="最多并行子代理" hint="主代理同时运行的 sub-agent 上限">
            <select
              className={inputCls}
              value={form.maxSubagents ?? 3}
              onChange={(e) => setForm((f) => ({ ...f, maxSubagents: Number(e.target.value) }))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="space-y-2 border-t border-border pt-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(form.enableBrowser)}
              onChange={(e) => setForm((f) => ({ ...f, enableBrowser: e.target.checked }))}
            />
            启用 cloakbrowser（浏览器自动化）
            {bStatus &&
              (bStatus.serving ? (
                <span className="rounded-full bg-[#22c55e]/15 px-2 py-0.5 text-[10px] font-medium text-[#4ade80] ring-1 ring-inset ring-[#22c55e]/40">
                  运行中 :9222
                </span>
              ) : (
                <span className="rounded-full bg-border px-2 py-0.5 text-[10px] text-muted">未运行</span>
              ))}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className="text-xs" disabled={bBusy} onClick={startBrowser}>
              {bBusy ? '处理中…' : '启动/重启浏览器服务'}
            </Button>
            <Button variant="outline" className="text-xs" disabled={bBusy} onClick={browserLogin}>
              打开浏览器登录账号
            </Button>
            <Button variant="ghost" className="text-xs" onClick={refreshBrowser}>
              刷新状态
            </Button>
          </div>
          {bMsg && <p className="text-[11px] text-muted">{bMsg}</p>}
          {bStatus && bStatus.logs.length > 0 && (
            <pre className="max-h-32 overflow-y-auto rounded-md border border-border bg-panel2 p-2 text-[10px] leading-relaxed text-muted/80">
              {bStatus.logs.join('\n')}
            </pre>
          )}
          <p className="text-[11px] text-muted/60">
            cloakserve 是单一持久化浏览器（127.0.0.1:9222）：在它的窗口里登录账号会持久保存，agent 直接复用。
          </p>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <Button variant="outline" onClick={requestNotif} className="text-xs">
            开启桌面通知
          </Button>
          <div className="flex items-center gap-3">
            {msg && <span className="text-xs text-muted">{msg}</span>}
            <Button variant="accent" disabled={saving} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

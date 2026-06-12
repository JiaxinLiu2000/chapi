'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MODEL_OPTIONS, type UpdateSettingsInput } from '@chapi/shared';
import { api } from '@/lib/api';
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
      });
  }, [s]);

  const set = (k: keyof UpdateSettingsInput, v: string) => setForm((f) => ({ ...f, [k]: v }));

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

        <div className="flex items-center justify-between border-t border-border pt-3">
          <Button variant="ghost" onClick={requestNotif} className="text-xs">
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

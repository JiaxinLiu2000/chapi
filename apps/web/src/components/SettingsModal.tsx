'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { UpdateSettingsInput } from '@chapi/shared';
import { api } from '@/lib/api';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-muted">{label}</div>
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
    if (s) setForm({ mainModel: s.mainModel, subagentModel: s.subagentModel, embeddingModel: s.embeddingModel });
  }, [s]);

  const set = (k: keyof UpdateSettingsInput, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      await api.updateSettings(form);
      await refetch();
      setForm((f) => ({ ...f, openAiKey: '', anthropicKey: '', googleOAuthClientSecret: '' }));
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
        <Field
          label="Anthropic API Key"
          hint={s?.hasAnthropicKey ? '已配置（留空保持不变）' : '可选：留空则使用本机 Claude Code 登录凭证'}
        >
          <input
            className={inputCls}
            type="password"
            placeholder={s?.hasAnthropicKey ? '••••••••（已保存）' : '留空用本机凭证，或 sk-ant-…'}
            value={form.anthropicKey ?? ''}
            onChange={(e) => set('anthropicKey', e.target.value)}
          />
        </Field>
        <Field label="OpenAI API Key" hint={s?.hasOpenAiKey ? '已配置（留空保持不变）' : 'RAG 嵌入用'}>
          <input
            className={inputCls}
            type="password"
            placeholder={s?.hasOpenAiKey ? '••••••••（已保存）' : 'sk-…'}
            value={form.openAiKey ?? ''}
            onChange={(e) => set('openAiKey', e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Google OAuth Client ID">
            <input
              className={inputCls}
              value={form.googleOAuthClientId ?? ''}
              placeholder={s?.hasGoogleOAuth ? '已保存' : ''}
              onChange={(e) => set('googleOAuthClientId', e.target.value)}
            />
          </Field>
          <Field label="Google OAuth Client Secret">
            <input
              className={inputCls}
              type="password"
              placeholder={s?.hasGoogleOAuth ? '••••••••' : ''}
              onChange={(e) => set('googleOAuthClientSecret', e.target.value)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="主代理模型">
            <input className={inputCls} value={form.mainModel ?? ''} onChange={(e) => set('mainModel', e.target.value)} />
          </Field>
          <Field label="子代理模型">
            <input
              className={inputCls}
              value={form.subagentModel ?? ''}
              onChange={(e) => set('subagentModel', e.target.value)}
            />
          </Field>
        </div>
        <Field label="嵌入模型 (OpenAI)">
          <input
            className={inputCls}
            value={form.embeddingModel ?? ''}
            onChange={(e) => set('embeddingModel', e.target.value)}
          />
        </Field>

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

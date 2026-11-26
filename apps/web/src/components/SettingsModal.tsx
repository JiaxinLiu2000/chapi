'use client';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { Bot, Globe, KeyRound, Link2, MailCheck, SlidersHorizontal, Smartphone, type LucideIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  MODEL_OPTIONS,
  type BrowserStatusResponse,
  type EmailVerifyResult,
  type EmailVerifyStatusResponse,
  type UpdateSettingsInput,
} from '@chapi/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { useDiscardGuard } from './ui/useDiscardGuard';
import { DiscordPanel } from './DiscordPanel';
import { WechatPanel } from './WechatPanel';

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
        <span className="label">{label}</span>
        {saved && (
          <span className="rounded-full tone tone-green px-2 py-0.5 text-2xs font-medium">
            已保存
          </span>
        )}
      </div>
      {children}
      {hint && <div className="mt-1 text-2xs leading-snug text-muted">{hint}</div>}
    </label>
  );
}

const inputCls = 'field';

export type TabKey = 'models' | 'claude' | 'connections' | 'browser' | 'email' | 'remote' | 'general';
const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: 'models', label: '模型', icon: Bot },
  { key: 'claude', label: 'Claude 账号', icon: KeyRound },
  { key: 'connections', label: '连接', icon: Link2 },
  { key: 'browser', label: '浏览器', icon: Globe },
  { key: 'email', label: '邮箱验证', icon: MailCheck },
  { key: 'remote', label: '手机远程', icon: Smartphone },
  { key: 'general', label: '通用', icon: SlidersHorizontal },
];

export const SETTINGS_TABS: readonly TabKey[] = ['models', 'claude', 'connections', 'browser', 'email', 'general'];

/** Same value for the dirty check: empty/null/undefined alike, lists order-free. */
const norm = (v: unknown) => (v === undefined || v === null ? '' : Array.isArray(v) ? JSON.stringify([...v].sort()) : String(v));
function sameSettings(a: UpdateSettingsInput, b: UpdateSettingsInput): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof UpdateSettingsInput>;
  for (const k of keys) if (norm(a[k]) !== norm(b[k])) return false;
  return true;
}

/** `tab` lives in the URL (`?settings=<tab>`), owned by the caller. */
export function SettingsModal({
  open,
  onClose,
  tab,
  onTabChange: setTab,
}: {
  open: boolean;
  onClose: () => void;
  tab: TabKey;
  onTabChange: (t: TabKey) => void;
}) {
  const { data, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: api.getSettings,
    enabled: open,
  });
  const s = data?.settings;

  const [form, setForm] = useState<UpdateSettingsInput>({});
  // What's saved on the server (as a form): any difference = unsaved edits.
  const [baseline, setBaseline] = useState<UpdateSettingsInput>({});
  const dirty = open && !sameSettings(form, baseline);
  const discardAndClose = () => {
    setForm(baseline);
    onClose();
  };
  const { requestClose, confirm: discardConfirm } = useDiscardGuard(dirty, dirty ? discardAndClose : onClose);
  /** Save the form, then treat it as the saved state. */
  const persist = async () => {
    await api.updateSettings(form);
    setBaseline(form);
  };
  // Phones: keep the chosen tab fully visible in the scrolling strip.
  useEffect(() => {
    document.getElementById(`settings-tab-${tab}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);
  // Arrow keys move between tabs (roving focus, as a tablist should).
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.key === tab);
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next]!.key);
    document.getElementById(`settings-tab-${TABS[next]!.key}`)?.focus();
  };
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!s) return;
    const f: UpdateSettingsInput = {
      mainModel: s.mainModel,
      subagentModel: s.subagentModel,
      qualityModel: s.qualityModel,
      learningModel: s.learningModel,
      embeddingModel: s.embeddingModel,
      googleUserEmail: s.googleUserEmail,
      maxSubagents: s.maxSubagents,
      enableBrowser: s.enableBrowser,
      browserHidden: s.browserHidden,
      maxBrowserPages: s.maxBrowserPages,
      claudeEmailPrimary: s.claudeEmailPrimary,
      claudeEmailFallback: s.claudeEmailFallback,
      claudeCooldownH: s.claudeCooldownH,
      claudeModelsPrimary: s.claudeModelsPrimary,
      claudeModelsFallback: s.claudeModelsFallback,
      emailVerifyEnabled: s.emailVerifyEnabled,
      emailVerifyProxyHost: s.emailVerifyProxyHost,
      emailVerifyProxyPort: s.emailVerifyProxyPort,
      emailVerifyProxyUsername: s.emailVerifyProxyUsername,
      emailVerifyFromEmail: s.emailVerifyFromEmail,
      emailVerifyHelloName: s.emailVerifyHelloName,
    };
    setForm(f);
    setBaseline(f);
  }, [s]);

  const toggleModel = (key: 'claudeModelsPrimary' | 'claudeModelsFallback', id: string) =>
    setForm((f) => {
      const cur = f[key] ?? [];
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      return { ...f, [key]: next };
    });

  const [claudeMsg, setClaudeMsg] = useState('');
  const useClaudePrimary = async () => {
    try {
      await persist();
      await api.useClaudePrimary();
      await refetch();
      setClaudeMsg('已切回主账号');
    } catch (e) {
      setClaudeMsg(e instanceof Error ? e.message : '切换失败');
    }
  };

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

  const browserLogin = async () => {
    setBBusy(true);
    setBMsg('正在打开浏览器登录页…（若刚启用，需等内核下载/启动）');
    try {
      await persist();
      const r = await api.browserLogin();
      setBMsg(r.message);
      void refreshBrowser();
    } catch (e) {
      setBMsg(e instanceof Error ? e.message : '打开失败');
    } finally {
      setBBusy(false);
    }
  };

  const [eStatus, setEStatus] = useState<EmailVerifyStatusResponse | null>(null);
  const [eInput, setEInput] = useState('');
  const [eBusy, setEBusy] = useState(false);
  const [eMsg, setEMsg] = useState('');
  const [eResults, setEResults] = useState<EmailVerifyResult[]>([]);
  const refreshEmail = async () => {
    try {
      setEStatus(await api.emailVerifyStatus());
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (!open) return;
    void refreshEmail();
    // Poll while open so the badge follows the first build (downloads Go modules).
    const t = setInterval(() => void refreshEmail(), 4000);
    return () => clearInterval(t);
  }, [open]);

  const testEmails = async () => {
    const emails = eInput.split(/[\s,;]+/).filter(Boolean);
    if (emails.length === 0) return;
    setEBusy(true);
    setEMsg('验证中…（每个地址最多约 10–50 秒）');
    setEResults([]);
    try {
      await persist(); // apply the toggle/proxy before testing
      const r = await api.verifyEmails(emails);
      setEResults(r.results);
      setEMsg(r.notes.join(' '));
    } catch (e) {
      setEMsg(e instanceof Error ? e.message : '验证失败');
    } finally {
      setEBusy(false);
      void refreshEmail();
    }
  };

  const [wikiConfirm, setWikiConfirm] = useState(false);
  const [wikiMsg, setWikiMsg] = useState('');
  const clearWiki = async () => {
    try {
      const r = await api.clearWiki();
      setWikiMsg(`已清空 AI Wiki（删除 ${r.removed} 条）`);
    } catch (e) {
      setWikiMsg(e instanceof Error ? e.message : '清空失败');
    } finally {
      setWikiConfirm(false);
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
      await persist();
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

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      await persist();
      await refetch();
      setForm((f) => ({
        ...f,
        openAiKey: '',
        googleOAuthClientId: '',
        googleOAuthClientSecret: '',
        claudeTokenPrimary: '',
        claudeTokenFallback: '',
        emailVerifyProxyPassword: '',
      }));
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
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title="设置"
        className="sm:max-w-3xl"
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-3">
              {msg && (
                <span className="text-xs text-muted" role="status">
                  {msg}
                </span>
              )}
              <Button variant="primary" disabled={saving} onClick={save}>
                {saving ? '保存中…' : '保存设置'}
              </Button>
            </div>
          </div>
        }
      >
      <div className="flex flex-col gap-4 sm:flex-row sm:gap-6">
        {/* Tabs: a scrollable strip on phones, a sticky side rail from sm up */}
        <div
          role="tablist"
          aria-label="设置分类"
          aria-orientation="vertical"
          onKeyDown={onTabKey}
          className="no-scrollbar sticky top-0 z-10 -mx-5 -mt-4 flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-panel px-5 py-2 sm:mx-0 sm:mt-0 sm:w-40 sm:flex-col sm:self-start sm:overflow-visible sm:border-b-0 sm:bg-transparent sm:p-0"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const on = tab === t.key;
            return (
              <button
                key={t.key}
                id={`settings-tab-${t.key}`}
                role="tab"
                aria-selected={on}
                aria-controls={`settings-panel-${t.key}`}
                tabIndex={on ? 0 : -1}
                onClick={() => setTab(t.key)}
                className={cn(
                  'flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors active:bg-panel2 sm:w-full [@media(pointer:coarse)]:h-10',
                  on ? 'bg-panel2 font-medium text-text' : 'text-muted hover:bg-panel2/60 hover:text-text',
                )}
              >
                <Icon size={16} aria-hidden className={on ? 'text-accent' : undefined} />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="min-w-0 flex-1 pb-2">
        {tab === 'models' && (
          <section role="tabpanel" id="settings-panel-models" aria-labelledby="settings-tab-models" className="anim-fade space-y-5">
            <header>
              <h3 className="text-[14px] font-medium">模型</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">Claude 用本机 Claude Code 凭证运行，不需要 Anthropic API Key。这里设的是新会话的默认值，会话顶栏可以单独改。</p>
            </header>
        <div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {(
              [
                ['mainModel', '主代理', '新会话的默认主代理模型（会话顶栏可单独改）', false],
                ['subagentModel', '子代理', '新会话的默认子代理（Task）模型（会话顶栏可单独改）', false],
                ['qualityModel', '质检顾问', '定时质检用的模型；默认跟随子代理', true],
                ['learningModel', '学习代理', '自动学习、整理知识点、处理冲突用的模型；默认跟随子代理', true],
              ] as const
            ).map(([key, label, hint, follow]) => (
              <Field key={key} label={label} hint={hint}>
                <select
                  className={inputCls}
                  value={(form[key] as string | undefined) ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                >
                  {follow && <option value="">跟随子代理</option>}
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="嵌入模型（OpenAI）">
            <input
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
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

          </section>
        )}
        {tab === 'claude' && (
          <section role="tabpanel" id="settings-panel-claude" aria-labelledby="settings-tab-claude" className="anim-fade space-y-5">
            <header>
              <h3 className="text-[14px] font-medium">Claude 账号</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">主号到限额会自动切到备用号并重试，冷却后新会话再优先试主号。</p>
            </header>
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-muted">
            当前使用
            <span className="rounded-full bg-panel2 px-2 py-0.5 text-2xs font-medium text-text">
              当前：{s?.claudeActive === 'fallback' ? '备用号' : '主号'}
            </span>
          </div>
          <p className="text-2xs text-muted">
            用 <code className="rounded bg-panel2 px-1">claude setup-token</code> 在各账号下各生成一个长期 token 填入。
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="主账号 token" saved={s?.hasClaudeTokenPrimary} hint={s?.claudeEmailPrimary}>
              <input
                className={inputCls}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={s?.hasClaudeTokenPrimary ? '••••••••' : 'sk-ant-oat…'}
                value={form.claudeTokenPrimary ?? ''}
                onChange={(e) => set('claudeTokenPrimary', e.target.value)}
              />
            </Field>
            <Field label="备用账号 token" saved={s?.hasClaudeTokenFallback} hint={s?.claudeEmailFallback}>
              <input
                className={inputCls}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={s?.hasClaudeTokenFallback ? '••••••••' : 'sk-ant-oat…'}
                value={form.claudeTokenFallback ?? ''}
                onChange={(e) => set('claudeTokenFallback', e.target.value)}
              />
            </Field>
            <Field label="主账号邮箱">
              <input
                className={inputCls}
                type="email"
                autoComplete="off"
                spellCheck={false}
                value={form.claudeEmailPrimary ?? ''}
                onChange={(e) => set('claudeEmailPrimary', e.target.value)}
              />
            </Field>
            <Field label="备用账号邮箱">
              <input
                className={inputCls}
                type="email"
                autoComplete="off"
                spellCheck={false}
                value={form.claudeEmailFallback ?? ''}
                onChange={(e) => set('claudeEmailFallback', e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 text-xs font-medium text-muted">主账号可用模型</div>
              <div className="space-y-1">
                {MODEL_OPTIONS.map((m) => (
                  <label key={m.id} className="flex h-8 cursor-pointer items-center gap-2 text-xs [@media(pointer:coarse)]:h-10">
                    <input
                      type="checkbox"
                      checked={(form.claudeModelsPrimary ?? []).includes(m.id)}
                      onChange={() => toggleModel('claudeModelsPrimary', m.id)}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted">备账号可用模型</div>
              <div className="space-y-1">
                {MODEL_OPTIONS.map((m) => (
                  <label key={m.id} className="flex h-8 cursor-pointer items-center gap-2 text-xs [@media(pointer:coarse)]:h-10">
                    <input
                      type="checkbox"
                      checked={(form.claudeModelsFallback ?? []).includes(m.id)}
                      onChange={() => toggleModel('claudeModelsFallback', m.id)}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span>切回主号冷却（小时）</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={72}
                className="select-sm h-8 w-16 rounded-md border border-border bg-panel px-2 text-xs tabular-nums text-text"
                value={form.claudeCooldownH ?? 5}
                onChange={(e) => setForm((f) => ({ ...f, claudeCooldownH: Number(e.target.value) }))}
              />
            </label>
            {s?.claudeActive === 'fallback' && (
              <Button variant="outline" size="sm" onClick={useClaudePrimary}>
                立即切回主号
              </Button>
            )}
            {claudeMsg && <span className="text-2xs text-muted" role="status">{claudeMsg}</span>}
          </div>
        </div>

          </section>
        )}
        {tab === 'connections' && (
          <section role="tabpanel" id="settings-panel-connections" aria-labelledby="settings-tab-connections" className="anim-fade space-y-5">
            <header>
              <h3 className="text-[14px] font-medium">连接</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">OpenAI 用于知识库的向量嵌入；Google 用于 Drive、Docs、Sheets 和 Gmail 草稿。</p>
            </header>
        <Field label="OpenAI API Key" saved={s?.hasOpenAiKey} hint={s?.hasOpenAiKey ? undefined : 'RAG 嵌入用'}>
          <input
            className={inputCls}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            placeholder={s?.hasOpenAiKey ? '••••••••' : 'sk-…'}
            value={form.openAiKey ?? ''}
            onChange={(e) => set('openAiKey', e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Google OAuth Client ID" saved={s?.hasGoogleOAuth}>
            <input
              className={inputCls}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={form.googleOAuthClientId ?? ''}
              placeholder={s?.hasGoogleOAuth ? '••••••••' : ''}
              onChange={(e) => set('googleOAuthClientId', e.target.value)}
            />
          </Field>
          <Field label="Google OAuth Client Secret" saved={s?.hasGoogleOAuth}>
            <input
              className={inputCls}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={s?.hasGoogleOAuth ? '••••••••' : ''}
              value={form.googleOAuthClientSecret ?? ''}
              onChange={(e) => set('googleOAuthClientSecret', e.target.value)}
            />
          </Field>
        </div>
        <Field label="Google 账号邮箱" hint="代理以此账号操作 Workspace/Drive/Gmail 草稿">
          <input
            className={inputCls}
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="name@gmail.com"
            value={form.googleUserEmail ?? ''}
            onChange={(e) => set('googleUserEmail', e.target.value)}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" disabled={gBusy} onClick={connectGoogle}>
            {gBusy ? '授权中…' : '连接 Google（开始授权）'}
          </Button>
          {gStatus === 'connected' || (gStatus === 'idle' && s?.googleConnected) ? (
            <span className="rounded-full tone tone-green px-2 py-0.5 text-2xs font-medium">
              Google 已连接，可直接使用
            </span>
          ) : gMsg ? (
            <span className={cn('text-2xs', gStatus === 'error' ? 'text-danger' : 'text-muted')} role="status">
              {gMsg}
            </span>
          ) : null}
        </div>
          </section>
        )}
        {tab === 'browser' && (
          <section role="tabpanel" id="settings-panel-browser" aria-labelledby="settings-tab-browser" className="anim-fade space-y-5">
            <header>
              <h3 className="text-[14px] font-medium">浏览器</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">cloakbrowser 是 AI 用来上网、登录网站的受控浏览器，登录状态会保留。</p>
            </header>
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={Boolean(form.enableBrowser)}
              onChange={(e) => setForm((f) => ({ ...f, enableBrowser: e.target.checked }))}
            />
            启用 cloakbrowser（浏览器自动化）
            {bStatus &&
              (bStatus.serving ? (
                <span className="rounded-full tone tone-green px-2 py-0.5 text-2xs font-medium">
                  运行中 :9222
                </span>
              ) : (
                <span className="rounded-full bg-border px-2 py-0.5 text-2xs text-muted">未运行</span>
              ))}
          </label>
          <label className="flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={Boolean(form.browserHidden)}
              onChange={(e) => setForm((f) => ({ ...f, browserHidden: e.target.checked }))}
            />
            隐藏浏览器窗口（不在任务栏显示，仅在「实时浏览器」里查看）
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span>实时浏览器最多页面</span>
            <select
              className="select-sm h-8 rounded-md border border-border bg-panel px-2 text-xs text-text"
              value={form.maxBrowserPages ?? 2}
              onChange={(e) => setForm((f) => ({ ...f, maxBrowserPages: Number(e.target.value) }))}
            >
              <option value={1}>1（单页）</option>
              <option value={2}>2（开第二页自动上下分屏）</option>
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={bBusy} onClick={browserLogin}>
              {bBusy ? '启动中…' : '启动浏览器并登录账号'}
            </Button>
          </div>
          {bMsg && <p className="text-2xs text-muted" role="status">{bMsg}</p>}
          <p className="text-2xs text-muted">
            点击开启浏览器后，请保持其运行。在里面登录的账号会被保留，下次 AI 直接使用这些已登录网站。
            隐藏后不在任务栏显示，仍可在「实时浏览器」面板查看；需要手动登录时先取消勾选「隐藏」用可见窗口登录。
          </p>
        </div>

          </section>
        )}
        {tab === 'email' && (
          <section role="tabpanel" id="settings-panel-email" aria-labelledby="settings-tab-email" className="anim-fade space-y-5">
            <header>
              <h3 className="text-[14px] font-medium">邮箱验证</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">不发信就判断邮箱是否真实存在，发邮件前清洗名单用。</p>
            </header>
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={Boolean(form.emailVerifyEnabled)}
              onChange={(e) => setForm((f) => ({ ...f, emailVerifyEnabled: e.target.checked }))}
            />
            启用邮箱验证（AfterShip email-verifier）
            {eStatus?.enabled &&
              (eStatus.ready ? (
                <span className="rounded-full tone tone-green px-2 py-0.5 text-2xs font-medium">
                  已就绪
                </span>
              ) : (
                <span className="rounded-full bg-border px-2 py-0.5 text-2xs text-muted">
                  {eStatus.building ? '编译中…' : eStatus.goInstalled === false ? '未安装 Go' : '未编译'}
                </span>
              ))}
          </label>
          <p className="text-2xs text-muted">
            AI 可用 <code className="rounded bg-panel2 px-1">verify_email</code>{' '}
            验证邮箱是否存在（语法 → MX → SMTP 握手，不发信；另检测一次性/角色/免费邮箱与域名拼写）。
            首次启用会用本机 Go 编译验证程序（需已安装 Go）。
            {eStatus?.enabled && eStatus.goInstalled === false && ' 注意：' + eStatus.message}
            {eStatus?.port25Open === false &&
              (eStatus.proxyConfigured
                ? ' 本机出站 25 端口被封，将通过下方 SOCKS5 代理做 SMTP 验证。'
                : ' 注意：本机出站 25 端口被封：不配代理时只能做语法/MX/一次性邮箱检测，SMTP 结果多为 unknown。')}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="col-span-2">
              <Field label="SOCKS5 代理主机" hint="可选；代理需开放出站 25 端口">
                <input
                  className={inputCls}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="proxy.example.com"
                  value={form.emailVerifyProxyHost ?? ''}
                  onChange={(e) => set('emailVerifyProxyHost', e.target.value)}
                />
              </Field>
            </div>
            <Field label="端口">
              <input
                className={inputCls}
                type="number"
                inputMode="numeric"
                placeholder="1080"
                value={form.emailVerifyProxyPort ?? ''}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    emailVerifyProxyPort: e.target.value ? Number(e.target.value) : null,
                  }))
                }
              />
            </Field>
            <Field label="用户名">
              <input
                className={inputCls}
                autoComplete="off"
                spellCheck={false}
                value={form.emailVerifyProxyUsername ?? ''}
                onChange={(e) => set('emailVerifyProxyUsername', e.target.value)}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="代理密码" saved={s?.hasEmailVerifyProxyPassword}>
              <input
                className={inputCls}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={s?.hasEmailVerifyProxyPassword ? '••••••••' : ''}
                value={form.emailVerifyProxyPassword ?? ''}
                onChange={(e) => set('emailVerifyProxyPassword', e.target.value)}
              />
            </Field>
            <Field label="MAIL FROM 邮箱" hint="可选，默认 user@example.org">
              <input
                className={inputCls}
                type="email"
                autoComplete="off"
                spellCheck={false}
                value={form.emailVerifyFromEmail ?? ''}
                onChange={(e) => set('emailVerifyFromEmail', e.target.value)}
              />
            </Field>
            <Field label="HELO 主机名" hint="可选，最好与出口 IP 反解一致">
              <input
                className={inputCls}
                autoComplete="off"
                spellCheck={false}
                value={form.emailVerifyHelloName ?? ''}
                onChange={(e) => set('emailVerifyHelloName', e.target.value)}
              />
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <input
              className={inputCls}
              aria-label="要试验证的邮箱"
              autoComplete="off"
              spellCheck={false}
              placeholder="试验证：输入一个或多个邮箱（空格/逗号分隔）…"
              value={eInput}
              onChange={(e) => setEInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void testEmails();
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={eBusy || !form.emailVerifyEnabled}
              onClick={testEmails}
            >
              {eBusy ? '验证中…' : '验证'}
            </Button>
          </div>
          {eResults.length > 0 && (
            <ul className="space-y-0.5 text-2xs">
              {eResults.map((r) => (
                <li key={r.email}>
                  <span
                    className={cn(
                      'mr-2 font-medium',
                      r.status === 'safe'
                        ? 'text-success'
                        : r.status === 'invalid'
                          ? 'text-danger'
                          : 'text-muted',
                    )}
                  >
                    {r.status}
                  </span>
                  {r.email}
                  {r.suggestion && <span className="text-muted"> · 是否想输入 {r.suggestion}？</span>}
                  {r.disposable && <span className="text-muted"> · 一次性/仿冒拼写域名</span>}
                  {r.roleAccount && <span className="text-muted"> · 角色邮箱</span>}
                  {r.free && <span className="text-muted"> · 免费邮箱</span>}
                  {r.catchAll && <span className="text-muted"> · catch-all</span>}
                  {r.error && <span className="text-muted"> · SMTP 未验证</span>}
                </li>
              ))}
            </ul>
          )}
          {eMsg && <p className="text-2xs text-muted" role="status">{eMsg}</p>}
        </div>

          </section>
        )}
        {tab === 'remote' && (
          <section role="tabpanel" id="settings-panel-remote" aria-labelledby="settings-tab-remote" className="anim-fade space-y-5">
            <header>
              <h3 className="text-[14px] font-medium">手机远程</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">在手机上和对话聊天：结果、提问、审批、流程进度推到手机，手机上的回复直接发给 chapi。</p>
            </header>
            <DiscordPanel />
            <WechatPanel />
          </section>
        )}
        {tab === 'general' && (
          <section role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" className="anim-fade space-y-5">
            <header>
              <h3 className="text-[14px] font-medium">通用</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">通知和数据维护</p>
            </header>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">桌面通知</div>
              <p className="mt-0.5 text-xs text-muted">AI 提问、成果待审批、任务完成时弹出系统通知</p>
            </div>
            <Button variant="outline" size="sm" onClick={requestNotif}>
              开启桌面通知
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-danger">清空 AI Wiki</div>
              <p className="mt-0.5 text-xs text-muted">永久删除所有知识点和向量索引，无法恢复</p>
            </div>
            <Button variant="outline" size="sm" className="text-danger" onClick={() => setWikiConfirm(true)}>
              清空 AI Wiki
            </Button>
          </div>
          {wikiMsg && (
            <p className="text-2xs text-muted" role="status">
              {wikiMsg}
            </p>
          )}
        </div>
          </section>
        )}
        </div>
      </div>
      </Modal>

      <Modal
        open={wikiConfirm}
        onClose={() => setWikiConfirm(false)}
        title="清空 AI Wiki？"
        className="sm:max-w-sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setWikiConfirm(false)}>
              取消
            </Button>
            <Button variant="danger" onClick={clearWiki}>
              清空 AI Wiki
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          所有 AI Wiki 条目及其向量索引会被<span className="font-medium text-text">永久删除</span>，agent 沉淀的经验会全部丢失，无法恢复。
        </p>
      </Modal>
      {discardConfirm}
    </>
  );
}

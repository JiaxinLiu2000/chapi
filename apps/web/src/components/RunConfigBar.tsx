'use client';
import { useQuery } from '@tanstack/react-query';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  type AccountMode,
  type EffortLevel,
  type Language,
} from '@chapi/shared';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';

const effortLabel: Record<EffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '较高',
  max: '最高',
};

const selectCls =
  'rounded-md border border-border bg-panel2 px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50';

export function RunConfigBar({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.session);
  const { data: settingsData } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const st = settingsData?.settings;

  const completed = session?.status === 'completed';
  const model = session?.model ?? '';
  const subagentModel = session?.subagentModel || model;
  const effort: EffortLevel = session?.effort ?? 'high';
  const language: Language = session?.language ?? 'zh';
  const accountMode: AccountMode = session?.accountMode ?? 'auto';

  const tokensConfigured = Boolean(st && (st.hasClaudeTokenPrimary || st.hasClaudeTokenFallback));
  // Which account's model permissions apply: fallback seat when pinned to it, else the primary's.
  const allowedIds =
    tokensConfigured && st
      ? accountMode === 'fallback'
        ? st.claudeModelsFallback
        : st.claudeModelsPrimary
      : null;

  const patch = (partial: Partial<NonNullable<typeof session>>) =>
    useStore.setState((s) => ({ session: s.session ? { ...s.session, ...partial } : s.session }));

  const modelOpts = (cur: string) => {
    let opts = MODEL_OPTIONS as ReadonlyArray<{ id: string; label: string }>;
    if (allowedIds && allowedIds.length) opts = opts.filter((m) => allowedIds.includes(m.id));
    if (opts.length === 0) opts = MODEL_OPTIONS;
    return opts.some((m) => m.id === cur) ? opts : [{ id: cur, label: cur || '(默认)' }, ...opts];
  };

  const onModel = (value: string) => {
    patch({ model: value });
    getSocket().send({ type: 'set.config', sessionId, model: value });
  };
  const onSubModel = (value: string) => {
    patch({ subagentModel: value });
    getSocket().send({ type: 'set.config', sessionId, subagentModel: value });
  };
  const onEffort = (value: EffortLevel) => {
    patch({ effort: value });
    getSocket().send({ type: 'set.config', sessionId, effort: value });
  };
  const onLanguage = (value: Language) => {
    patch({ language: value });
    getSocket().send({ type: 'set.config', sessionId, language: value });
  };
  const onAccount = (mode: AccountMode) => {
    // Changing the seat may change which models are permitted — send it all in one
    // set.config (one run restart), fixing model/sub-agent to an allowed one if needed.
    const cfg: {
      type: 'set.config';
      sessionId: string;
      accountMode: AccountMode;
      model?: string;
      subagentModel?: string;
    } = { type: 'set.config', sessionId, accountMode: mode };
    const next = st
      ? mode === 'fallback'
        ? st.claudeModelsFallback
        : mode === 'primary'
          ? st.claudeModelsPrimary
          : st.claudeModelsPrimary // auto → primary's list
      : null;
    const p: Partial<NonNullable<typeof session>> = { accountMode: mode };
    if (tokensConfigured && next && next.length) {
      if (!next.includes(model)) (cfg.model = next[0]), (p.model = next[0]);
      if (!next.includes(subagentModel)) (cfg.subagentModel = next[0]), (p.subagentModel = next[0]);
    }
    patch(p);
    getSocket().send(cfg);
  };

  const browserOn = useStore((s) => s.browserViewOn);
  const setBrowserOn = useStore((s) => s.setBrowserViewOn);
  const toggleBrowser = () => {
    const next = !browserOn;
    setBrowserOn(next);
    getSocket().send({ type: 'browser.view', sessionId, on: next });
  };

  const acctLabel = (m: AccountMode) =>
    m === 'auto'
      ? '自动(主→备)'
      : m === 'primary'
        ? `主号${st?.claudeEmailPrimary ? ` · ${st.claudeEmailPrimary}` : ''}`
        : `备号${st?.claudeEmailFallback ? ` · ${st.claudeEmailFallback}` : ''}`;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel/40 px-4 py-2">
      {tokensConfigured && (
        <>
          <span className="text-xs text-muted">账号</span>
          <select
            className={selectCls}
            value={accountMode}
            disabled={completed}
            onChange={(e) => onAccount(e.target.value as AccountMode)}
            title="选择使用哪个 Claude 账号(自动=主号优先、限额切备用；也可手动锁定)。切换会在下一条消息生效。"
          >
            <option value="auto">{acctLabel('auto')}</option>
            <option value="primary">{acctLabel('primary')}</option>
            <option value="fallback">{acctLabel('fallback')}</option>
          </select>
        </>
      )}

      <span className={tokensConfigured ? 'ml-3 text-xs text-muted' : 'text-xs text-muted'}>主代理</span>
      <select
        className={selectCls}
        value={model}
        disabled={completed}
        onChange={(e) => onModel(e.target.value)}
        title="主编排代理的模型(按所选账号可用范围过滤，即时生效)"
      >
        {modelOpts(model).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      <span className="ml-3 text-xs text-muted">子代理</span>
      <select
        className={selectCls}
        value={subagentModel}
        disabled={completed}
        onChange={(e) => onSubModel(e.target.value)}
        title="子代理(Task 派发)的模型(按所选账号可用范围过滤，下一条消息生效)"
      >
        {modelOpts(subagentModel).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      <span className="ml-3 text-xs text-muted">思考强度</span>
      <select
        className={selectCls}
        value={effort}
        disabled={completed}
        onChange={(e) => onEffort(e.target.value as EffortLevel)}
        title="切换推理强度(下一条消息生效)"
      >
        {EFFORT_LEVELS.map((e) => (
          <option key={e} value={e}>
            {effortLabel[e]}
          </option>
        ))}
      </select>

      <span className="ml-3 text-xs text-muted">语言</span>
      <select
        className={selectCls}
        value={language}
        disabled={completed}
        onChange={(e) => onLanguage(e.target.value as Language)}
        title="与用户交流的语言(表格/邮件/查资料仍默认英文)"
      >
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>

      {!browserOn && (
        <button
          className="ml-auto rounded-md border border-border px-2 py-1 text-xs text-muted hover:text-text"
          onClick={toggleBrowser}
          title="在右侧实时显示 agent 的浏览器画面"
        >
          🌐 实时浏览器
        </button>
      )}
    </div>
  );
}

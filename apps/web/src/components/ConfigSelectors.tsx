'use client';
import {
  EFFORT_LEVELS,
  MODEL_OPTIONS,
  type AccountMode,
  type EffortLevel,
  type Language,
  type PublicSettingsDTO,
} from '@chapi/shared';

export interface RunConfig {
  model: string;
  subagentModel: string;
  effort: EffortLevel;
  language: Language;
  accountMode: AccountMode;
}

const effortLabel: Record<EffortLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '较高',
  max: '最高',
};

const selectCls =
  'rounded-md border border-border bg-panel2 px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-50';

/**
 * The account / main-model / sub-model / effort / language selectors, shared by the
 * session run bar and the home page's new-conversation form. Stateless: the parent
 * owns `value` and applies `onChange(partial)` (persist per-session, or hold as the
 * initial config for a new session). Main/sub model options filter by the selected
 * account's permitted models; switching account snaps a disallowed model to allowed.
 */
export function ConfigSelectors({
  value,
  settings,
  disabled,
  onChange,
}: {
  value: RunConfig;
  settings?: PublicSettingsDTO;
  disabled?: boolean;
  onChange: (partial: Partial<RunConfig>) => void;
}) {
  const st = settings;
  const tokensConfigured = Boolean(st && (st.hasClaudeTokenPrimary || st.hasClaudeTokenFallback));
  const allowedIds =
    tokensConfigured && st
      ? value.accountMode === 'fallback'
        ? st.claudeModelsFallback
        : st.claudeModelsPrimary
      : null;

  const modelOpts = (cur: string) => {
    let opts = MODEL_OPTIONS as ReadonlyArray<{ id: string; label: string }>;
    if (allowedIds && allowedIds.length) opts = opts.filter((m) => allowedIds.includes(m.id));
    if (opts.length === 0) opts = MODEL_OPTIONS;
    return opts.some((m) => m.id === cur) ? opts : [{ id: cur, label: cur || '(默认)' }, ...opts];
  };

  const acctLabel = (m: AccountMode) =>
    m === 'auto'
      ? '自动(主→备)'
      : m === 'primary'
        ? `主号${st?.claudeEmailPrimary ? ` · ${st.claudeEmailPrimary}` : ''}`
        : `备号${st?.claudeEmailFallback ? ` · ${st.claudeEmailFallback}` : ''}`;

  const onAccount = (mode: AccountMode) => {
    const next = st
      ? mode === 'fallback'
        ? st.claudeModelsFallback
        : st.claudeModelsPrimary
      : null;
    const partial: Partial<RunConfig> = { accountMode: mode };
    if (tokensConfigured && next && next.length) {
      if (!next.includes(value.model)) partial.model = next[0];
      if (!next.includes(value.subagentModel)) partial.subagentModel = next[0];
    }
    onChange(partial);
  };

  return (
    <>
      {tokensConfigured && (
        <>
          <span className="text-xs text-muted">账号</span>
          <select
            className={selectCls}
            value={value.accountMode}
            disabled={disabled}
            onChange={(e) => onAccount(e.target.value as AccountMode)}
            title="选择使用哪个 Claude 账号(自动=主号优先、限额切备用；也可手动锁定)"
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
        value={value.model}
        disabled={disabled}
        onChange={(e) => onChange({ model: e.target.value })}
        title="主编排代理的模型(按所选账号可用范围过滤)"
      >
        {modelOpts(value.model).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      <span className="ml-3 text-xs text-muted">子代理</span>
      <select
        className={selectCls}
        value={value.subagentModel}
        disabled={disabled}
        onChange={(e) => onChange({ subagentModel: e.target.value })}
        title="子代理(Task 派发)的模型(按所选账号可用范围过滤)"
      >
        {modelOpts(value.subagentModel).map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      <span className="ml-3 text-xs text-muted">思考强度</span>
      <select
        className={selectCls}
        value={value.effort}
        disabled={disabled}
        onChange={(e) => onChange({ effort: e.target.value as EffortLevel })}
        title="推理强度"
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
        value={value.language}
        disabled={disabled}
        onChange={(e) => onChange({ language: e.target.value as Language })}
        title="与用户交流的语言(表格/邮件/查资料仍默认英文)"
      >
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </>
  );
}

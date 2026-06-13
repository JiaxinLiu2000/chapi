'use client';
import { EFFORT_LEVELS, MODEL_OPTIONS, type EffortLevel, type Language } from '@chapi/shared';
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
  const completed = session?.status === 'completed';
  const model = session?.model ?? '';
  const effort: EffortLevel = session?.effort ?? 'high';
  const language: Language = session?.language ?? 'zh';

  const patch = (partial: { model?: string; effort?: EffortLevel; language?: Language }) =>
    useStore.setState((s) => ({ session: s.session ? { ...s.session, ...partial } : s.session }));

  const onModel = (value: string) => {
    patch({ model: value });
    getSocket().send({ type: 'set.config', sessionId, model: value });
  };
  const onEffort = (value: EffortLevel) => {
    patch({ effort: value });
    getSocket().send({ type: 'set.config', sessionId, effort: value });
  };
  const onLanguage = (value: Language) => {
    patch({ language: value });
    getSocket().send({ type: 'set.config', sessionId, language: value });
  };
  const optionsFor = (cur: string) =>
    MODEL_OPTIONS.some((m) => m.id === cur)
      ? MODEL_OPTIONS
      : [{ id: cur, label: cur || '(默认)' }, ...MODEL_OPTIONS];

  const browserOn = useStore((s) => s.browserViewOn);
  const setBrowserOn = useStore((s) => s.setBrowserViewOn);
  const toggleBrowser = () => {
    const next = !browserOn;
    setBrowserOn(next);
    getSocket().send({ type: 'browser.view', sessionId, on: next });
  };

  return (
    <div className="flex items-center gap-2 border-b border-border bg-panel/40 px-4 py-2">
      <span className="text-xs text-muted">模型</span>
      <select
        className={selectCls}
        value={model}
        disabled={completed}
        onChange={(e) => onModel(e.target.value)}
        title="模型（主代理与子代理统一使用，即时生效）"
      >
        {optionsFor(model).map((m) => (
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
        title="切换推理强度（下一条消息生效）"
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
        title="与用户交流的语言（表格/邮件/查资料仍默认英文）"
      >
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>

      {/* hidden while the panel is open (the panel has its own close button) */}
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

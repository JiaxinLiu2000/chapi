'use client';
import { EFFORT_LEVELS, MODEL_OPTIONS, type EffortLevel } from '@chapi/shared';
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

  const patch = (partial: { model?: string; effort?: EffortLevel }) =>
    useStore.setState((s) => ({ session: s.session ? { ...s.session, ...partial } : s.session }));

  const onModel = (value: string) => {
    patch({ model: value });
    getSocket().send({ type: 'set.config', sessionId, model: value });
  };
  const onEffort = (value: EffortLevel) => {
    patch({ effort: value });
    getSocket().send({ type: 'set.config', sessionId, effort: value });
  };

  // Always include the current model in the dropdown, even if it's a custom id.
  const models = MODEL_OPTIONS.some((m) => m.id === model)
    ? MODEL_OPTIONS
    : [{ id: model, label: model || '(默认)' }, ...MODEL_OPTIONS];

  return (
    <div className="flex items-center gap-2 border-b border-border bg-panel/40 px-4 py-2">
      <span className="text-xs text-muted">模型</span>
      <select
        className={selectCls}
        value={model}
        disabled={completed}
        onChange={(e) => onModel(e.target.value)}
        title="切换 Claude 模型（即时生效）"
      >
        {models.map((m) => (
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

      <span className="ml-auto text-[11px] text-muted/60">
        {completed ? '已完成（只读）' : '可随时切换'}
      </span>
    </div>
  );
}

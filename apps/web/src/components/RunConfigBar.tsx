'use client';
import { useQuery } from '@tanstack/react-query';
import type { EffortLevel, Language, AccountMode } from '@chapi/shared';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { ConfigSelectors, type RunConfig } from './ConfigSelectors';

export function RunConfigBar({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.session);
  const { data: settingsData } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const completed = session?.status === 'completed';

  const value: RunConfig = {
    model: session?.model ?? '',
    subagentModel: session?.subagentModel || session?.model || '',
    effort: (session?.effort as EffortLevel) ?? 'high',
    language: (session?.language as Language) ?? 'zh',
    accountMode: (session?.accountMode as AccountMode) ?? 'auto',
  };

  // Optimistic local update + persist per-session. A single onChange may carry several
  // keys (e.g. account switch snapping the model); set.config accepts them together.
  const onChange = (partial: Partial<RunConfig>) => {
    useStore.setState((s) => ({ session: s.session ? { ...s.session, ...partial } : s.session }));
    getSocket().send({ type: 'set.config', sessionId, ...partial });
  };

  const browserOn = useStore((s) => s.browserViewOn);
  const setBrowserOn = useStore((s) => s.setBrowserViewOn);
  const toggleBrowser = () => {
    const next = !browserOn;
    setBrowserOn(next);
    getSocket().send({ type: 'browser.view', sessionId, on: next });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel/40 px-4 py-2">
      <ConfigSelectors
        value={value}
        settings={settingsData?.settings}
        disabled={completed}
        onChange={onChange}
      />
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

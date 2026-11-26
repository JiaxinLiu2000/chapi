'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, CheckCircle2, ChevronDown, Globe, PanelLeftOpen, SlidersHorizontal } from 'lucide-react';
import type { EffortLevel, Language, AccountMode } from '@chapi/shared';
import { api } from '@/lib/api';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { cn } from '@/lib/utils';
import { ConfigSelectors, type RunConfig } from './ConfigSelectors';
import { Button } from './ui/Button';
import { Modal } from './ui/Modal';
import { WechatButton } from './WechatButton';
import { DiscordButton } from './DiscordButton';

/**
 * The session's control bar: run config (inline from md, a collapsible grid on
 * phones), the user-Chrome switch, and the session actions (monitor drawer on
 * small screens, live browser, archive).
 */
export function RunConfigBar({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.session);
  const { data: settingsData } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const completed = session?.status === 'completed';
  const [mobileOpen, setMobileOpen] = useState(false);
  const [confirmDone, setConfirmDone] = useState(false);

  const value: RunConfig = {
    model: session?.model ?? '',
    subagentModel: session?.subagentModel || session?.model || '',
    effort: (session?.effort as EffortLevel) ?? 'high',
    language: (session?.language as Language) ?? 'zh',
    accountMode: (session?.accountMode as AccountMode) ?? 'auto',
    qualityReviewMinutes: session?.qualityReviewMinutes ?? 0,
    qualityModel: session?.qualityModel ?? '',
  };

  // Optimistic local update + persist per-session. A single onChange may carry several
  // keys (e.g. account switch snapping the model); set.config accepts them together.
  const onChange = (partial: Partial<RunConfig>) => {
    useStore.setState((s) => ({ session: s.session ? { ...s.session, ...partial } : s.session }));
    getSocket().send({ type: 'set.config', sessionId, ...partial });
  };

  // Opt-in to the user's own logged-in Chrome; off by default (cloakbrowser only).
  const userChrome = session?.userChrome ?? false;
  const toggleUserChrome = (on: boolean) => {
    useStore.setState((s) => ({ session: s.session ? { ...s.session, userChrome: on } : s.session }));
    getSocket().send({ type: 'set.config', sessionId, userChrome: on });
  };

  const browserOn = useStore((s) => s.browserViewOn);
  const setBrowserOn = useStore((s) => s.setBrowserViewOn);
  const toggleBrowser = () => {
    const next = !browserOn;
    setBrowserOn(next);
    getSocket().send({ type: 'browser.view', sessionId, on: next });
  };
  const setMonitor = useStore((s) => s.setMonitorOpen);

  const markDone = () => {
    getSocket().send({ type: 'mark.completed', sessionId });
    setConfirmDone(false);
  };

  const chromeSwitch = (
    <label
      className={cn('flex min-w-0 cursor-pointer items-center gap-2 text-xs', completed && 'pointer-events-none opacity-50')}
      title="打开后，本对话的 agent 可以用你本机 Chrome 里已登录的 jiaxin.liu@unitpulse.ai（在第二个窗口里开标签，只读）。关闭 = 只用 cloakbrowser（joannaliubus）。"
    >
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={userChrome}
        disabled={completed}
        onChange={(e) => toggleUserChrome(e.target.checked)}
      />
      <span className={userChrome ? 'text-warn' : 'text-muted'}>用我的 Chrome</span>
      <span className="hidden truncate text-2xs text-muted 2xl:inline">jiaxin.liu@unitpulse.ai</span>
    </label>
  );

  return (
    <div className="shrink-0 border-b border-border bg-panel">
      <div className="flex min-h-12 items-center gap-2 px-3 py-2 sm:px-4">
        <button
          className="btn btn--ghost btn--sm max-sm:w-8 max-sm:px-0 lg:hidden [@media(pointer:coarse)]:max-sm:w-10"
          onClick={() => setMonitor(true)}
          aria-label="打开任务监控"
        >
          <PanelLeftOpen size={16} aria-hidden />
          <span className="max-sm:hidden">监控</span>
        </button>

        {/* 2xl+: everything inline on one row */}
        <div className="hidden min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2 2xl:flex">
          <ConfigSelectors value={value} settings={settingsData?.settings} disabled={completed} onChange={onChange} />
          {chromeSwitch}
        </div>

        {/* below 2xl: one button that reveals the settings grid */}
        <button
          className="btn btn--ghost btn--sm 2xl:hidden"
          onClick={() => setMobileOpen((o) => !o)}
          aria-expanded={mobileOpen}
          aria-controls="run-config-mobile"
        >
          <SlidersHorizontal size={16} aria-hidden />
          运行设置
          <ChevronDown
            size={14}
            aria-hidden
            className={cn('transition-transform duration-150 ease-ui', mobileOpen && 'rotate-180')}
          />
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <DiscordButton sessionId={sessionId} disabled={completed} />
          <WechatButton sessionId={sessionId} disabled={completed} />
          <button
            className={cn('btn btn--sm', browserOn ? 'btn--secondary text-text' : 'btn--secondary text-muted')}
            onClick={toggleBrowser}
            aria-pressed={browserOn}
            title={browserOn ? '关闭实时浏览器' : '实时显示 agent 的浏览器画面'}
          >
            <Globe size={16} aria-hidden />
            <span className="max-sm:hidden">实时浏览器</span>
          </button>
          {completed ? (
            <span className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-success">
              <CheckCircle2 size={16} aria-hidden />
              <span className="max-sm:hidden">已归档</span>
            </span>
          ) : (
            <button
              onClick={() => setConfirmDone(true)}
              title="标记为出色完成：平台会学习并归档，之后该对话变为只读"
              className="btn btn--secondary btn--sm text-success"
            >
              <Archive size={16} aria-hidden />
              <span className="max-sm:hidden">归档</span>
            </button>
          )}
        </div>
      </div>

      {mobileOpen && (
        <div
          id="run-config-mobile"
          className="anim-drop grid grid-cols-2 gap-3 border-t border-border px-3 pb-3 pt-3 sm:grid-cols-3 sm:px-4 lg:grid-cols-6 2xl:hidden"
        >
          <ConfigSelectors value={value} settings={settingsData?.settings} disabled={completed} onChange={onChange} stack />
          <div className="col-span-2 pt-1 sm:col-span-3 lg:col-span-6">{chromeSwitch}</div>
        </div>
      )}

      <Modal
        open={confirmDone}
        onClose={() => setConfirmDone(false)}
        title="标记为出色完成？"
        className="sm:max-w-sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDone(false)}>
              取消
            </Button>
            <Button variant="success" onClick={markDone}>
              完成并归档
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">
          平台会学习并归档本次任务的成果与方案以便复现，<span className="font-medium text-text">该对话随后变为只读</span>
          ，无法继续对话。
        </p>
      </Modal>
    </div>
  );
}

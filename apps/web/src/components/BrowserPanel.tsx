'use client';
import { X } from 'lucide-react';
import { useStore } from '@/lib/store';
import { getSocket } from '@/lib/ws';

/**
 * Right-side live view of the agent's cloakbrowser (CDP screencast frames),
 * forming a left/right split with the chat. Read-only — you watch the agent.
 */
export function BrowserPanel({ sessionId }: { sessionId: string }) {
  const on = useStore((s) => s.browserViewOn);
  const frame = useStore((s) => s.browserFrame);
  const url = useStore((s) => s.browserUrl);
  const status = useStore((s) => s.browserStatus);
  const message = useStore((s) => s.browserMessage);
  const setOn = useStore((s) => s.setBrowserViewOn);

  if (!on) return null;

  const close = () => {
    setOn(false);
    getSocket().send({ type: 'browser.view', sessionId, on: false });
  };

  return (
    <div className="flex w-[44%] min-w-[360px] flex-col border-l border-border bg-panel/30">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted">🌐 实时浏览器</span>
        <span
          className={
            'h-2 w-2 rounded-full ' +
            (status === 'connected'
              ? 'bg-[#22c55e]'
              : status === 'connecting'
                ? 'bg-amber-400 animate-pulse'
                : 'bg-muted/50')
          }
        />
        <span className="truncate text-[11px] text-muted/70" title={url ?? ''}>
          {url ?? status}
        </span>
        <button
          onClick={close}
          className="ml-auto rounded p-1 text-muted hover:bg-panel2 hover:text-text"
          title="关闭浏览器视图"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-1 items-center justify-center overflow-hidden bg-black/40 p-2">
        {frame ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt="browser"
            className="max-h-full max-w-full rounded shadow"
          />
        ) : (
          <div className="px-6 text-center text-xs text-muted">
            {status === 'unavailable'
              ? (message ?? 'cloakbrowser 未运行。请在设置启用浏览器。')
              : status === 'connecting'
                ? '正在连接 cloakbrowser…'
                : '等待 agent 打开网页…（agent 调用浏览器时这里会显示实时画面）'}
          </div>
        )}
      </div>
    </div>
  );
}

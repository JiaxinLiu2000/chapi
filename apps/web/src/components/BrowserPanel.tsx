'use client';
import { X } from 'lucide-react';
import { useStore, type BrowserPaneState } from '@/lib/store';
import { getSocket } from '@/lib/ws';

function Pane({ pane }: { pane: BrowserPaneState }) {
  const { frame, url, status, message } = pane;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span
          className={
            'h-2 w-2 shrink-0 rounded-full ' +
            (status === 'connected'
              ? 'bg-[#22c55e]'
              : status === 'connecting'
                ? 'animate-pulse bg-amber-400'
                : 'bg-muted/50')
          }
        />
        <span className="truncate text-[11px] text-muted/70" title={url ?? ''}>
          {url ?? status}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/40 p-2">
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
                : '等待 agent 打开网页…'}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Right-side live view of the agent's cloakbrowser, forming a left/right split
 * with the chat. Shows up to 2 pages stacked top/bottom (read-only).
 */
export function BrowserPanel({ sessionId, width }: { sessionId: string; width: number }) {
  const pages = useStore((s) => s.browserPages);
  const pageCount = useStore((s) => s.browserPageCount);
  const setOn = useStore((s) => s.setBrowserViewOn);

  const close = () => {
    setOn(false);
    getSocket().send({ type: 'browser.view', sessionId, on: false });
  };

  const count = Math.min(Math.max(pageCount, 1), 2);

  return (
    <div className="flex shrink-0 flex-col border-l border-border bg-panel/30" style={{ width }}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-muted">
          🌐 实时浏览器{count > 1 ? `（${count} 页）` : ''}
        </span>
        <button
          onClick={close}
          className="ml-auto rounded p-1 text-muted hover:bg-panel2 hover:text-text"
          title="关闭浏览器视图"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-border">
        {Array.from({ length: count }).map((_, i) => (
          <Pane key={i} pane={pages[i] ?? { frame: null, url: null, status: 'idle', message: null }} />
        ))}
      </div>
    </div>
  );
}

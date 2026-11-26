'use client';
import { useEffect } from 'react';
import { Globe, X } from 'lucide-react';
import { useStore, type BrowserPaneState } from '@/lib/store';
import { getSocket } from '@/lib/ws';
import { cn } from '@/lib/utils';

function Pane({ pane, index }: { pane: BrowserPaneState; index: number }) {
  const { frame, url, status, message } = pane;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span
          aria-hidden
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            status === 'connected' ? 'bg-success' : status === 'connecting' ? 'animate-pulse bg-warn' : 'bg-muted/50',
          )}
        />
        <span className="min-w-0 truncate font-mono text-2xs text-muted" title={url ?? ''}>
          {url ?? (status === 'connected' ? '已连接' : status === 'connecting' ? '连接中…' : '空闲')}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-panel2 p-2">
        {frame ? (
          // eslint-disable-next-line @next/next/no-img-element -- live JPEG frames over the socket
          <img
            src={`data:image/jpeg;base64,${frame}`}
            alt={url ? `第 ${index + 1} 个页面：${url}` : `第 ${index + 1} 个页面的实时画面`}
            width={1280}
            height={800}
            className="h-auto max-h-full w-auto max-w-full rounded-md"
          />
        ) : (
          <div className="px-6 text-center text-xs leading-relaxed text-muted">
            {status === 'unavailable'
              ? (message ?? 'cloakbrowser 没有运行，请在设置里启用浏览器')
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
 * Live view of the agent's cloakbrowser (read-only, up to 2 pages stacked).
 * lg+: the right side of a split with the chat. Smaller screens: a full-screen
 * overlay under the top bar (Esc closes).
 */
export function BrowserPanel({ sessionId, width }: { sessionId: string; width: number }) {
  const pages = useStore((s) => s.browserPages);
  const pageCount = useStore((s) => s.browserPageCount);
  const setOn = useStore((s) => s.setBrowserViewOn);

  const close = () => {
    setOn(false);
    getSocket().send({ type: 'browser.view', sessionId, on: false });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !window.matchMedia('(min-width: 1024px)').matches) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const count = Math.min(Math.max(pageCount, 1), 2);

  return (
    <section
      aria-label="实时浏览器"
      className="anim-sheet-right fixed inset-0 top-14 z-40 flex flex-col bg-panel lg:static lg:z-auto lg:h-[calc(100dvh-3.5rem)] lg:w-[var(--bw)] lg:shrink-0 lg:animate-none"
      style={{ ['--bw' as string]: `${width}px` }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1.5">
        <Globe size={16} aria-hidden className="text-muted" />
        <span className="text-xs font-medium text-muted">
          实时浏览器{count > 1 ? <span className="tabular-nums">（{count} 页）</span> : null}
        </span>
        <button onClick={close} className="btn btn--ghost btn--icon btn--sm ml-auto" aria-label="关闭实时浏览器">
          <X size={16} aria-hidden />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col divide-y divide-border">
        {Array.from({ length: count }).map((_, i) => (
          <Pane key={i} index={i} pane={pages[i] ?? { frame: null, url: null, status: 'idle', message: null }} />
        ))}
      </div>
    </section>
  );
}

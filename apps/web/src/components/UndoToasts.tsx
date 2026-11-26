'use client';
import { useEffect, useState } from 'react';
import { undo, useUndoStore } from '@/lib/undoable';

/** 「已停止 · 撤销 4」: one bar per pending undoable action, bottom centre. */
export function UndoToasts() {
  const items = useUndoStore((s) => s.items);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!items.length) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [items.length]);

  return (
    <div
      className="pointer-events-none fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-[61] flex flex-col items-center gap-2"
      role="status"
      aria-live="polite"
    >
      {items.map((it) => {
        const left = Math.max(0, Math.ceil((it.due - Date.now()) / 1000));
        return (
          <div
            key={it.id}
            className="anim-rise pointer-events-auto flex h-11 items-center gap-3 rounded-xl border border-border bg-panel pl-4 pr-1.5 text-sm"
          >
            <span>{it.label}</span>
            <span className="text-muted" aria-hidden>
              ·
            </span>
            <button type="button" className="btn btn--ghost btn--sm -ml-1.5 text-accent" onClick={() => undo(it.id)}>
              撤销
              {/* The ticking number stays out of the live region's announcements. */}
              <span className="w-5 text-left text-2xs tabular-nums text-muted" aria-hidden>
                {left}s
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { PALETTES, type PaletteKey } from '@/lib/palettes';
import { PALETTE_KEY } from '@/lib/themeBoot';
import { cn } from '@/lib/utils';

function Swatch({ colors }: { colors: string[] }) {
  // ground · panel · ink · primary
  return (
    <span className="flex h-6 w-12 overflow-hidden rounded-md ring-1 ring-inset ring-text/10" aria-hidden>
      <span className="flex-1" style={{ background: colors[0] }} />
      <span className="flex-1" style={{ background: colors[1] }} />
      <span className="flex-1" style={{ background: colors[2] }} />
      <span className="flex-1" style={{ background: colors[3] }} />
    </span>
  );
}

/**
 * Palette switcher: five reviewed palettes, independent of the light/dark toggle.
 * `open`/`onOpenChange` make it controllable (the phone 「更多」 menu opens it);
 * `triggerClassName` lets the caller hide the icon button on phones.
 */
export function PalettePicker({
  open: openProp,
  onOpenChange,
  triggerClassName,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
} = {}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean | ((o: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(open) : v;
    setOpenState(next);
    onOpenChange?.(next);
  };
  const [current, setCurrent] = useState<PaletteKey>('amber');
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const p = document.documentElement.dataset.palette as PaletteKey | undefined;
    if (p) setCurrent(p);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Back to the trigger (on phones it's hidden — the 「更多」 button stays put instead).
      if (trigger.current?.offsetParent) trigger.current.focus({ preventScroll: true });
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (k: PaletteKey) => {
    document.documentElement.dataset.palette = k;
    try {
      localStorage.setItem(PALETTE_KEY, k);
    } catch {
      /* storage unavailable: lasts this page */
    }
    setCurrent(k);
    window.dispatchEvent(new Event('chapi-theme')); // canvas redraws pick up new tokens
  };

  return (
    <div className="relative" ref={box}>
      <button
        ref={trigger}
        className={cn('btn btn--ghost btn--icon [@media(pointer:coarse)]:w-10', open && 'is-active', triggerClassName)}
        aria-label="配色方案"
        title="配色方案"
        aria-expanded={open}
        aria-controls="palette-pop"
        onClick={() => setOpen((o) => !o)}
      >
        <Palette size={18} aria-hidden />
      </button>
      {open && (
        <div
          id="palette-pop"
          role="dialog"
          aria-label="配色方案"
          className="anim-pop scroll-area absolute right-0 top-full z-50 mt-2 max-h-[calc(100dvh-5rem)] w-72 rounded-xl border border-border bg-panel p-1 [--origin:top_right] max-sm:fixed max-sm:inset-x-2 max-sm:top-16 max-sm:mt-0 max-sm:w-auto"
        >
          <div className="px-2.5 pb-1.5 pt-1 text-xs text-muted">配色 · 左白天 / 右夜间</div>
          {PALETTES.map((p) => (
            <button
              key={p.key}
              onClick={() => pick(p.key)}
              aria-pressed={current === p.key}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-panel2 active:bg-panel2',
                current === p.key && 'bg-panel2 font-medium',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <Swatch colors={p.light} />
              <Swatch colors={p.dark} />
              <Check size={14} aria-hidden className={cn('text-accent', current === p.key ? 'opacity-100' : 'opacity-0')} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const EXIT_MS = 120;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
/** Open dialogs, oldest first: keys go to the last one only. */
const openStack: object[] = [];

/**
 * Dialog: fades/rises in, softer and shorter out; Esc and the scrim close it.
 * The header and an optional `footer` stay put while the body scrolls (body
 * scroll never chains to the page). On phones it's a bottom sheet.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Sticky action row (e.g. Save) — always visible however long the body is. */
  footer?: ReactNode;
  className?: string;
}) {
  // Keep it mounted for the exit animation.
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const t = setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, EXIT_MS);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Latest onClose without re-running the open effect: callers pass inline arrows, and
  // re-running it on every parent render would yank focus out of the field being typed in.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const self = {};
    openStack.push(self);
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost dialog answers (a confirm opened over Settings closes alone).
      if (openStack[openStack.length - 1] !== self) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      // Keep Tab inside the dialog.
      const panel = panelRef.current;
      if (e.key !== 'Tab' || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel || !panel.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !panel.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase: Esc closes this dialog and nothing underneath (page-level Esc handlers).
    window.addEventListener('keydown', onKey, true);
    // Focus the dialog so Tab starts inside it and screen readers announce it.
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      openStack.splice(openStack.indexOf(self), 1);
      html.style.overflow = prevOverflow;
      prev?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-end justify-center bg-scrim/45 sm:items-start sm:p-4 sm:pt-[10vh]',
        closing ? 'anim-exit-fade' : 'anim-fade',
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-2xl border border-border bg-panel outline-none sm:max-h-[80vh] sm:rounded-2xl',
          closing ? 'anim-exit-pop' : 'anim-pop',
          className,
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border py-2 pl-5 pr-2">
          <h2 id={titleId} className="min-w-0 truncate text-[14px] font-medium">
            {title}
          </h2>
          <button onClick={onClose} className="btn btn--ghost btn--icon" aria-label="关闭">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="scroll-area min-h-0 flex-1 px-5 py-4">{children}</div>
        {footer && (
          <div className="pb-safe flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 pt-3 sm:pb-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

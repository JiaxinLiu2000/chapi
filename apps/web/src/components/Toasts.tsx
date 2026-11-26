'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, X } from 'lucide-react';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

const barByLevel: Record<string, string> = {
  info: 'border-l-accent',
  question: 'border-l-warn',
  success: 'border-l-success',
  error: 'border-l-danger',
};

/** Bottom-right toast (full width on phones) that also mirrors to a desktop notification. */
export function Toasts() {
  const toast = useStore((s) => s.toast);
  const clear = useStore((s) => s.clearToast);
  const router = useRouter();

  useEffect(() => {
    if (!toast) return;
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(toast.title, { body: toast.body });
        if (toast.sessionSlug) {
          const slug = toast.sessionSlug;
          n.onclick = () => {
            window.focus();
            router.push(`/s/${slug}`);
            n.close();
          };
        }
      } catch {
        /* ignore */
      }
    }
    const ms = toast.level === 'error' || toast.level === 'question' ? 9000 : 5000;
    const t = setTimeout(clear, ms);
    return () => clearTimeout(t);
  }, [toast, clear, router]);

  return (
    // The live region stays mounted so screen readers hear each new toast.
    <div
      className="pointer-events-none fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-[60] flex justify-end sm:inset-x-auto sm:right-4"
      role="status"
      aria-live="polite"
    >
      {toast && (
        <div
          key={toast.ts}
          className={cn(
            'anim-rise pointer-events-auto relative w-full rounded-xl border border-l-[3px] border-border bg-panel sm:w-80',
            barByLevel[toast.level] ?? 'border-l-accent',
          )}
        >
          <div className="py-3 pl-3 pr-10">
            <div className="text-sm font-medium">{toast.title}</div>
            <div className="scroll-area mt-1 max-h-32 whitespace-pre-wrap text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
              {toast.body}
            </div>
            {toast.sessionSlug && (
              <Link
                href={`/s/${toast.sessionSlug}`}
                className="act -ml-1.5 mt-2 h-8 px-1.5 text-xs text-accent"
                onClick={clear}
              >
                切换到这个对话 <ArrowRight size={14} aria-hidden />
              </Link>
            )}
          </div>
          <button onClick={clear} className="btn btn--ghost btn--icon btn--sm absolute right-1.5 top-1.5" aria-label="关闭通知">
            <X size={16} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

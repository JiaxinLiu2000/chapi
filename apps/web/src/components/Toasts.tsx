'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

const borderByLevel: Record<string, string> = {
  info: 'border-accent',
  question: 'border-warn',
  success: 'border-success',
  error: 'border-danger',
};

/** Bottom-right toast that also mirrors to a desktop (Chrome) notification. */
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

  if (!toast) return null;
  const clickable = Boolean(toast.sessionSlug);
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={
        clickable
          ? () => {
              router.push(`/s/${toast.sessionSlug}`);
              clear();
            }
          : undefined
      }
      className={cn(
        'fixed bottom-4 right-4 z-[60] w-80 rounded-lg border-l-4 bg-panel2 p-3 shadow-xl',
        borderByLevel[toast.level] ?? 'border-accent',
        clickable && 'cursor-pointer transition-colors hover:bg-panel',
      )}
    >
      <div className="text-sm font-semibold">{toast.title}</div>
      <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted">
        {toast.body}
      </div>
      {clickable && <div className="mt-1.5 text-[11px] text-accent">点击切换到该对话流 →</div>}
    </div>
  );
}

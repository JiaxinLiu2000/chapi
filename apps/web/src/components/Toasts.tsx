'use client';
import { useEffect } from 'react';
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

  useEffect(() => {
    if (!toast) return;
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(toast.title, { body: toast.body });
      } catch {
        /* ignore */
      }
    }
    const ms = toast.level === 'error' || toast.level === 'question' ? 9000 : 5000;
    const t = setTimeout(clear, ms);
    return () => clearTimeout(t);
  }, [toast, clear]);

  if (!toast) return null;
  return (
    <div
      className={cn(
        'fixed bottom-4 right-4 z-[60] w-80 rounded-lg border-l-4 bg-panel2 p-3 shadow-xl',
        borderByLevel[toast.level] ?? 'border-accent',
      )}
    >
      <div className="text-sm font-semibold">{toast.title}</div>
      <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-muted">
        {toast.body}
      </div>
    </div>
  );
}

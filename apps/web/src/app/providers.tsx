'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Toasts } from '@/components/Toasts';
import { UndoToasts } from '@/components/UndoToasts';
import { GlobalAlerts } from '@/components/GlobalAlerts';
import { cssToken } from '@/lib/theme';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5000 } },
      }),
  );
  // Browser chrome (mobile address bar, PWA title bar) follows the top bar's colour,
  // including a pinned light/dark choice and the palette, not just the OS scheme.
  useEffect(() => {
    const sync = () => {
      const c = cssToken('panel');
      document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', c));
    };
    sync();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', sync);
    window.addEventListener('chapi-theme', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('chapi-theme', sync);
    };
  }, []);
  return (
    <QueryClientProvider client={client}>
      {children}
      <GlobalAlerts />
      <Toasts />
      <UndoToasts />
    </QueryClientProvider>
  );
}

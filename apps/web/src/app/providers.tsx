'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Toasts } from '@/components/Toasts';
import { GlobalAlerts } from '@/components/GlobalAlerts';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 5000 } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <GlobalAlerts />
      <Toasts />
    </QueryClientProvider>
  );
}

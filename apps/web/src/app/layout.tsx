import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { APP_VERSION } from '@chapi/shared';
import { Providers } from './providers';
import { TopNav } from '@/components/TopNav';

export const metadata: Metadata = {
  title: 'Chapi — 本地 Claude Code 工作流',
  description: 'Local web platform to drive Claude Code with natural language.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>
          <TopNav />
          {children}
          <div className="pointer-events-none fixed bottom-1 left-2 z-30 select-none text-[10px] text-muted/40">
            v{APP_VERSION}
          </div>
        </Providers>
      </body>
    </html>
  );
}

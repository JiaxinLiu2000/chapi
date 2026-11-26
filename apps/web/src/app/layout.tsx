import 'katex/dist/katex.min.css';
import '@xyflow/react/dist/style.css';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import { TopNav } from '@/components/TopNav';
import { THEME_BOOT_SCRIPT } from '@/lib/themeBoot';

export const metadata: Metadata = {
  title: 'Chapi：本地 AI 工作台',
  description: '用自然语言驱动 Claude Code 完成调研、文档和表格任务，结果交你审批。',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fdfdfc' },
    { media: '(prefers-color-scheme: dark)', color: '#262522' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint (no light/dark flash). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600&display=swap"
        />
      </head>
      <body suppressHydrationWarning>
        <a href="#main" className="skip-link">
          跳到主要内容
        </a>
        <Providers>
          <TopNav />
          {children}
        </Providers>
      </body>
    </html>
  );
}

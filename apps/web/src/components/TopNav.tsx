'use client';
import Link from 'next/link';
import { useState } from 'react';
import { BookOpen, History, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { HistoryMenu } from './HistoryMenu';
import { SettingsModal } from './SettingsModal';

export function TopNav() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const iconBtn = 'rounded-lg p-2 text-muted transition hover:bg-panel2 hover:text-text';

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-panel/80 px-4 backdrop-blur">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-white">C</span>
          <span>Chapi</span>
          <span className="ml-1 hidden text-xs font-normal text-muted sm:inline">
            本地 Claude Code 工作流
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          <Link href="/wiki" className={iconBtn} title="AI Wiki">
            <BookOpen size={18} />
          </Link>
          <button
            className={cn(iconBtn, historyOpen && 'bg-panel2 text-text')}
            title="历史记录"
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <History size={18} />
          </button>
          <button className={iconBtn} title="设置" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} />
          </button>
        </nav>
      </header>

      <HistoryMenu open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

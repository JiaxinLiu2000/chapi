'use client';
import { Suspense, useRef, type KeyboardEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LayoutDashboard } from 'lucide-react';
import { AutomationTable } from '@/components/board/AutomationTable';
import { ProjectGrid } from '@/components/board/ProjectGrid';
import { TodayColumns } from '@/components/board/TodayColumns';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'today', label: '今天' },
  { key: 'projects', label: '项目' },
  { key: 'automations', label: '自动化' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/**
 * Board: today's sessions by state, sessions grouped into projects, and the
 * automation register. The tab lives in `?tab=` so a reload / link keeps it.
 */
export default function BoardPage() {
  return (
    <Suspense fallback={null}>
      <Board />
    </Suspense>
  );
}

function Board() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get('tab');
  const tab: Tab = TABS.some((t) => t.key === raw) ? (raw as Tab) : 'today';
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const go = (t: Tab) => {
    if (t === tab) return;
    router.replace(t === 'today' ? pathname : `${pathname}?tab=${t}`, { scroll: false });
  };

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.key === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    go(TABS[next]!.key);
    tabRefs.current[next]?.focus();
  };

  return (
    <main id="main" tabIndex={-1} className="page-scroll outline-none mx-auto w-full max-w-6xl px-4 py-6">
      <div className="mb-1 flex items-center gap-2">
        <LayoutDashboard size={18} aria-hidden className="text-muted" />
        <h1 className="text-base font-medium">看板</h1>
      </div>
      <p className="mb-5 text-sm text-muted">今天在跑和等你处理的会话、按项目归好的全部会话，以及定期要做的任务。</p>

      <div role="tablist" aria-label="看板视图" onKeyDown={onKey} className="mb-5 inline-flex rounded-[10px] bg-panel2 p-0.5 max-sm:flex max-sm:w-full">
        {TABS.map((t, i) => {
          const on = t.key === tab;
          return (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              id={`board-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls="board-panel"
              tabIndex={on ? 0 : -1}
              onClick={() => go(t.key)}
              className={cn(
                'h-8 rounded-md px-4 text-sm transition-[color,background-color,transform] duration-150 ease-ui active:scale-[0.96] max-sm:h-10 max-sm:flex-1',
                on ? 'bg-panel font-medium text-text ring-1 ring-inset ring-border' : 'text-muted hover:text-text',
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div id="board-panel" role="tabpanel" aria-labelledby={`board-tab-${tab}`} key={tab} className="anim-fade">
        {tab === 'today' && <TodayColumns />}
        {tab === 'projects' && <ProjectGrid />}
        {tab === 'automations' && <AutomationTable />}
      </div>
    </main>
  );
}

'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  BookOpen,
  History,
  LayoutDashboard,
  Monitor,
  Moon,
  MoreHorizontal,
  Network,
  Palette,
  Settings,
  Sun,
  Workflow,
} from 'lucide-react';
import { APP_VERSION } from '@chapi/shared';
import { cn } from '@/lib/utils';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import { HistoryMenu } from './HistoryMenu';
import { PalettePicker } from './PalettePicker';
import { SessionTitle } from './SessionTitle';
import { SETTINGS_TABS, SettingsModal, type TabKey } from './SettingsModal';
import { useUrlParam } from '@/lib/urlState';

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_META: Record<ThemeChoice, { icon: typeof Sun; label: string; short: string }> = {
  system: { icon: Monitor, label: '主题：跟随系统（点击切到白天）', short: '主题：跟随系统' },
  light: { icon: Sun, label: '主题：白天（点击切到夜间）', short: '主题：白天' },
  dark: { icon: Moon, label: '主题：夜间（点击改为跟随系统）', short: '主题：夜间' },
};

const EXIT_MS = 120;

export function TopNav() {
  const [historyOpen, setHistoryOpen] = useState(false);
  // Settings open + tab live in `?settings=<tab>` (reload keeps it; unknown → 模型).
  const [settingsParam, setSettingsParam] = useUrlParam('settings');
  const settingsOpen = settingsParam !== null;
  const settingsTab: TabKey = SETTINGS_TABS.includes(settingsParam as TabKey) ? (settingsParam as TabKey) : 'models';
  const setSettingsOpen = (on: boolean) => setSettingsParam(on ? settingsTab : null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { choice, set } = useTheme();
  const pathname = usePathname();
  const historyBtn = useRef<HTMLButtonElement>(null);

  // Touch: 40px wide (not the 44 default) so the icons still leave the title room on a phone.
  const iconBtn = 'btn btn--ghost btn--icon [@media(pointer:coarse)]:w-10';
  // Below sm these live in the 「更多」 menu instead.
  const wideOnly = 'max-sm:hidden';

  return (
    <>
      {/* Opaque bar, one hairline, no blur or shadow. */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-2 border-b border-border bg-panel px-3 sm:gap-4 sm:px-4">
        <Link href="/" className="-mx-1.5 flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-1.5" aria-label="Chapi 首页">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary font-display text-[14px] font-medium text-on-primary">
            C
          </span>
          <span className="hidden font-display text-[16px] font-medium sm:inline" translate="no">Chapi</span>
          <span className="ml-1 hidden text-xs text-muted lg:inline">本地 AI 工作台</span>
        </Link>
        <SessionTitle />
        <nav className="flex shrink-0 items-center gap-0.5" aria-label="主导航">
          <Link
            href="/board"
            className={cn(iconBtn, pathname === '/board' && 'is-active')}
            title="看板"
            aria-label="看板"
            aria-current={pathname === '/board' ? 'page' : undefined}
          >
            <LayoutDashboard size={18} aria-hidden />
          </Link>
          <Link
            href="/wiki"
            className={cn(iconBtn, wideOnly, pathname === '/wiki' && 'is-active')}
            title="AI Wiki"
            aria-label="AI Wiki"
            aria-current={pathname === '/wiki' ? 'page' : undefined}
          >
            <BookOpen size={18} aria-hidden />
          </Link>
          <Link
            href="/workflows"
            className={cn(iconBtn, wideOnly, pathname === '/workflows' && 'is-active')}
            title="SOP 工作流"
            aria-label="SOP 工作流"
            aria-current={pathname === '/workflows' ? 'page' : undefined}
          >
            <Workflow size={18} aria-hidden />
          </Link>
          <Link
            href="/wiki/graph"
            className={cn(iconBtn, wideOnly, pathname === '/wiki/graph' && 'is-active')}
            title="知识图谱"
            aria-label="知识图谱"
            aria-current={pathname === '/wiki/graph' ? 'page' : undefined}
          >
            <Network size={18} aria-hidden />
          </Link>
          <button
            ref={historyBtn}
            className={cn(iconBtn, historyOpen && 'is-active')}
            title="历史记录"
            aria-label="历史记录"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <History size={18} aria-hidden />
          </button>
          <span className="mx-1 h-5 w-px bg-border max-sm:hidden" aria-hidden />
          {/* One picker: its icon shows from sm; on phones 「更多 → 配色」 opens the same popover. */}
          <PalettePicker open={paletteOpen} onOpenChange={setPaletteOpen} triggerClassName={wideOnly} />
          <button
            className={cn(iconBtn, wideOnly)}
            title={THEME_META[choice].label}
            aria-label={THEME_META[choice].label}
            onClick={() => set(NEXT_THEME[choice])}
          >
            <ThemeIcon choice={choice} />
          </button>
          <button className={cn(iconBtn, wideOnly)} title="设置" aria-label="设置" onClick={() => setSettingsOpen(true)}>
            <Settings size={18} aria-hidden />
          </button>
          <MoreMenu
            iconBtn={iconBtn}
            pathname={pathname}
            theme={choice}
            onTheme={() => set(NEXT_THEME[choice])}
            onPalette={() => setPaletteOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />
        </nav>
      </header>

      <HistoryMenu
        open={historyOpen}
        onClose={() => {
          setHistoryOpen(false);
          historyBtn.current?.focus({ preventScroll: true }); // back to where the panel came from
        }}
      />
      <SettingsModal open={settingsOpen} tab={settingsTab} onTabChange={setSettingsParam} onClose={() => setSettingsOpen(false)} />
      {/* Version: home page only (elsewhere it sat on top of the left sidebars). */}
      {pathname === '/' && (
        <div className="pointer-events-none fixed bottom-1 left-2 z-30 select-none font-mono text-2xs text-muted/70 max-lg:hidden" aria-hidden>
          v{APP_VERSION}
        </div>
      )}
    </>
  );
}

/** State icon: the three stacked, cross-faded with scale and opacity (compositor-only). */
function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  return (
    <span className="relative grid h-[18px] w-[18px] place-items-center" aria-hidden>
      {(Object.keys(THEME_META) as ThemeChoice[]).map((k) => {
        const Icon = THEME_META[k].icon;
        return (
          <Icon
            key={k}
            size={18}
            className={cn(
              'absolute transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.2,0,0,1)]',
              k === choice ? 'scale-100 opacity-100' : 'scale-[0.25] opacity-0',
            )}
          />
        );
      })}
    </span>
  );
}

/**
 * Phones only (< sm): the less-used nav icons in one menu. Each item does what its
 * wide-screen button does; 主题 cycles in place (the menu stays open to show it).
 */
function MoreMenu({
  iconBtn,
  pathname,
  theme,
  onTheme,
  onPalette,
  onSettings,
}: {
  iconBtn: string;
  pathname: string | null;
  theme: ThemeChoice;
  onTheme: () => void;
  onPalette: () => void;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const shown = open && !closing;

  const close = () => {
    if (!open || closing) return;
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, EXIT_MS);
  };

  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        btn.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onDown);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  // Opening moves focus to the first item; ↑/↓/Home/End move between items (menu pattern).
  useEffect(() => {
    if (shown) box.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus({ preventScroll: true });
  }, [shown]);
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown' ? (i + 1) % items.length
      : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length
      : e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };

  // Widening past the phone breakpoint closes it (the items are back in the bar).
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia('(min-width: 640px)');
    const onMq = () => mq.matches && setOpen(false);
    mq.addEventListener('change', onMq);
    return () => mq.removeEventListener('change', onMq);
  }, [open]);

  const item = 'flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-panel2 active:bg-panel2';
  const links: { href: string; label: string; icon: typeof BookOpen }[] = [
    { href: '/wiki', label: 'AI Wiki', icon: BookOpen },
    { href: '/workflows', label: 'SOP 工作流', icon: Workflow },
    { href: '/wiki/graph', label: '知识图谱', icon: Network },
  ];

  return (
    <div className="relative sm:hidden" ref={box}>
      <button
        ref={btn}
        className={cn(iconBtn, shown && 'is-active')}
        title="更多"
        aria-label="更多"
        aria-haspopup="menu"
        aria-expanded={shown}
        aria-controls="more-menu"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <MoreHorizontal size={18} aria-hidden />
      </button>
      {open && (
        <div
          id="more-menu"
          role="menu"
          aria-label="更多"
          onKeyDown={onMenuKey}
          className={cn(
            'absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-border bg-panel p-1 [--origin:top_right]',
            closing ? 'anim-exit-pop' : 'anim-pop',
          )}
        >
          {links.map(({ href, label, icon: Icon }) => {
            const on = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                role="menuitem"
                aria-current={on ? 'page' : undefined}
                onClick={close}
                className={cn(item, on && 'bg-panel2 font-medium')}
              >
                <Icon size={18} aria-hidden className={on ? 'text-accent' : 'text-muted'} />
                {label}
              </Link>
            );
          })}
          <div className="mx-2.5 my-1 h-px bg-border" aria-hidden />
          <button
            role="menuitem"
            className={item}
            onClick={() => {
              close();
              // After this tap's outside-click handling, so the picker doesn't close itself at once.
              setTimeout(onPalette, 0);
            }}
          >
            <Palette size={18} aria-hidden className="text-muted" />
            配色
          </button>
          <button role="menuitem" className={item} onClick={onTheme} aria-label={THEME_META[theme].label}>
            <span className="text-muted">
              <ThemeIcon choice={theme} />
            </span>
            {THEME_META[theme].short}
          </button>
          <button
            role="menuitem"
            className={item}
            onClick={() => {
              close();
              onSettings();
            }}
          >
            <Settings size={18} aria-hidden className="text-muted" />
            设置
          </button>
        </div>
      )}
    </div>
  );
}

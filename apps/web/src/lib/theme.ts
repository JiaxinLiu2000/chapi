'use client';
import { useCallback, useEffect, useState } from 'react';
import { THEME_KEY as KEY } from './themeBoot';

/** 'system' follows the OS; 'light' / 'dark' pin it (stored per browser). */
export type ThemeChoice = 'system' | 'light' | 'dark';

function read(): ThemeChoice {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* private mode: the choice just lasts this page */
  }
  window.dispatchEvent(new Event('chapi-theme'));
}

/** The resolved theme actually on screen (for canvas drawing etc.). */
export function resolvedTheme(): 'light' | 'dark' {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  useEffect(() => setChoice(read()), []);
  const set = useCallback((c: ThemeChoice) => {
    apply(c);
    setChoice(c);
  }, []);
  return { choice, set };
}

/** Re-render when the resolved theme changes (user toggle or OS switch). */
export function useResolvedTheme(): 'light' | 'dark' {
  const [t, setT] = useState<'light' | 'dark'>('dark');
  useEffect(() => {
    const update = () => setT(resolvedTheme());
    update();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    window.addEventListener('chapi-theme', update);
    return () => {
      mq.removeEventListener('change', update);
      window.removeEventListener('chapi-theme', update);
    };
  }, []);
  return t;
}

/** Read a theme token as a CSS colour string, e.g. cssToken('text', 0.4). */
export function cssToken(name: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--c-${name}`).trim();
  return v ? `rgb(${v} / ${alpha})` : `rgba(128,128,128,${alpha})`;
}

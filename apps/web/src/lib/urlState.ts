'use client';
import { useCallback, useEffect, useState } from 'react';

/**
 * Write query params in place (history.replaceState — Next's router picks it up,
 * no history entry per change, no re-render of the route). `null`/'' removes a key.
 */
export function replaceQuery(update: Record<string, string | null | undefined>): void {
  if (typeof window === 'undefined') return;
  const u = new URL(window.location.href);
  for (const [k, v] of Object.entries(update)) {
    if (v === null || v === undefined || v === '') u.searchParams.delete(k);
    else u.searchParams.set(k, v);
  }
  const next = `${u.pathname}${u.search}${u.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(window.history.state, '', next);
  }
}

export function readQuery(key: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get(key);
}

/**
 * One query param as state: read after mount (so server and first client render
 * agree), written back on every set. Callers validate the value (unknown → default).
 */
export function useUrlParam(key: string): [string | null, (v: string | null) => void] {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    setV(readQuery(key));
  }, [key]);
  const set = useCallback(
    (next: string | null) => {
      setV(next);
      replaceQuery({ [key]: next });
    },
    [key],
  );
  return [v, set];
}

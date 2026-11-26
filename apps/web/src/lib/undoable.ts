'use client';
import { create } from 'zustand';

/**
 * Delayed, undoable actions ("已停止 · 撤销"). The caller updates the UI at once;
 * `commit` (the real API call) runs only after `delayMs` unless 撤销 is clicked,
 * in which case `revert` puts the UI back and nothing is sent. If the page is
 * closed or reloaded during the window, everything pending is sent at once
 * (`flush`, e.g. fetch keepalive, falling back to `commit`), so the intent isn't lost.
 * In-app navigation keeps the timer and the toast (both live outside any page).
 */
export interface UndoItem {
  id: string;
  /** Toast text, e.g. 「已停止」 — the toast adds 「· 撤销」 and the countdown. */
  label: string;
  /** Epoch ms when the action will be sent. */
  due: number;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  commit: () => unknown;
  flush?: () => unknown;
  revert: () => void;
}

export const UNDO_MS = 5000;
const pending = new Map<string, Pending>();

export const useUndoStore = create<{ items: UndoItem[] }>(() => ({ items: [] }));

const drop = (id: string) => {
  pending.delete(id);
  useUndoStore.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  if (pending.size === 0) unlisten();
};

const run = (fn: () => unknown, onError?: (e: unknown) => void) => {
  try {
    const r = fn();
    if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((e) => onError?.(e));
  } catch (e) {
    onError?.(e);
  }
};

/** Page going away: send everything still waiting, now. */
const flushAll = () => {
  for (const [id, p] of [...pending]) {
    clearTimeout(p.timer);
    run(p.flush ?? p.commit);
    drop(id);
  }
};
let listening = false;
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pagehide', flushAll);
  window.addEventListener('beforeunload', flushAll);
}
function unlisten() {
  if (!listening || typeof window === 'undefined') return;
  listening = false;
  window.removeEventListener('pagehide', flushAll);
  window.removeEventListener('beforeunload', flushAll);
}

let seq = 0;
export function scheduleUndoable(opts: {
  label: string;
  commit: () => unknown;
  revert: () => void;
  /** Unload-safe variant of `commit` (fetch keepalive / sendBeacon). */
  flush?: () => unknown;
  onError?: (e: unknown) => void;
  delayMs?: number;
}): string {
  const id = `u${Date.now().toString(36)}${(seq++).toString(36)}`;
  const delay = opts.delayMs ?? UNDO_MS;
  const timer = setTimeout(() => {
    const p = pending.get(id);
    if (!p) return;
    drop(id);
    run(p.commit, opts.onError);
  }, delay);
  pending.set(id, { timer, commit: opts.commit, flush: opts.flush, revert: opts.revert });
  useUndoStore.setState((s) => ({ items: [...s.items, { id, label: opts.label, due: Date.now() + delay }] }));
  listen();
  return id;
}

/** 撤销: cancel before it was sent. Returns false if it already went out. */
export function undo(id: string): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  drop(id);
  p.revert();
  return true;
}

// Dev-only harness so the timing/undo/unload paths can be checked from a browser
// test without producing a real workflow run or approval.
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as unknown as { __chapiUndo?: unknown }).__chapiUndo = { scheduleUndoable, undo, pendingCount: () => pending.size };
}

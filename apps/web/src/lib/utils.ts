import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Mirrors the server's multipart limits (see apps/server/src/http/app.ts). */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export interface UploadedAttachment {
  filename: string;
  /** Path relative to the session sandbox cwd, e.g. "uploads/ab12cd-report.pdf". */
  sandboxPath: string;
}

/**
 * Append the just-uploaded file locations to an outgoing message so the agent
 * can find them at once. Shared by the home page and the in-session composer so
 * the first message of a task reads the same as any later one.
 */
export function withAttachmentNote(text: string, items: UploadedAttachment[]): string {
  if (items.length === 0) return text;
  const lines = items.map((a) => `- ${a.filename} → ${a.sandboxPath}`).join('\n');
  const note = `[本次上传的文件（位于会话沙盘，可直接读取/编辑）]\n${lines}`;
  return text ? `${text}\n\n${note}` : note;
}

export function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

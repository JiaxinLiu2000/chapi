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

const usd4 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatCost(usd: number): string {
  return (usd < 1 ? usd4 : usd2).format(usd);
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

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const dateFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });

/** "刚刚 / 5 分钟前 / 3 小时前 / 昨天 / 4 天前", then the date after a month (Intl, not hand-rolled). */
export function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return rtf.format(-m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return rtf.format(-h, 'hour');
  const days = Math.floor(h / 24);
  if (days < 30) return rtf.format(-days, 'day');
  return dateFmt.format(d);
}

/**
 * Phone previews of produced documents: Office files are converted to PDF with the
 * locally installed Microsoft Office (COM, Windows only), then PDF pages are
 * rendered to PNG with PyMuPDF so chat apps show them inline. Text-like files
 * become a snippet. Results are cached next to the file's session sandbox, keyed
 * by the source file's size + mtime.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import { IMAGE_EXT } from './files.js';

const run = promisify(execFile);
const log = createLogger('remote:preview');

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts');
const PYTHON = process.env.PYTHON_BIN || 'python';
const OFFICE_EXT = new Set(['.docx', '.doc', '.rtf', '.odt', '.xlsx', '.xls', '.xlsm', '.ods', '.pptx', '.ppt', '.odp']);
const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.json', '.log', '.tsv']);
export const PREVIEW_PAGES = 3;

export interface Preview {
  /** PNG page images (or the image itself). */
  images: string[];
  /** First page shown (1-based) and the document's total page count. */
  first: number;
  totalPages: number;
  /** PDF version of an Office file (opens in the phone's viewer). */
  pdf?: string;
  /** For text-like files: the first part of the content. */
  snippet?: string;
}

export function canPreview(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return IMAGE_EXT.has(ext) || ext === '.pdf' || TEXT_EXT.has(ext) || (process.platform === 'win32' && OFFICE_EXT.has(ext));
}

function cacheDir(file: string): string {
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 12);
  return path.join(path.dirname(file), '.preview', key);
}

// One Office conversion at a time — parallel COM automation is flaky.
let officeQueue: Promise<unknown> = Promise.resolve();

async function officeToPdf(file: string, outDir: string): Promise<string> {
  const out = path.join(outDir, `${path.basename(file, path.extname(file))}.pdf`);
  if (fs.existsSync(out)) return out;
  const job = officeQueue.then(() =>
    run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'office-to-pdf.ps1'), file, out], {
      timeout: 120_000,
      windowsHide: true,
    }),
  );
  officeQueue = job.catch(() => undefined);
  await job;
  if (!fs.existsSync(out)) throw new Error('Office 没有生成 PDF');
  return out;
}

async function renderPages(pdf: string, outDir: string, first: number, count: number): Promise<{ pages: number; images: string[] }> {
  const { stdout } = await run(PYTHON, ['-I', path.join(SCRIPTS, 'render_pdf_pages.py'), pdf, outDir, String(first), String(count)], {
    timeout: 60_000,
    windowsHide: true,
  });
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as { pages: number; images: string[] };
}

/** Build (or reuse) a preview for pages [first, first+count). Throws when the file can't be previewed. */
export async function makePreview(file: string, first = 1, count = PREVIEW_PAGES): Promise<Preview> {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return { images: [file], first: 1, totalPages: 1 };
  if (TEXT_EXT.has(ext)) {
    const text = (await fs.promises.readFile(file, 'utf8')).slice(0, 1500);
    return { images: [], first: 1, totalPages: 1, snippet: text };
  }
  const dir = cacheDir(file);
  await fs.promises.mkdir(dir, { recursive: true });
  let pdf: string | undefined;
  if (ext === '.pdf') pdf = file;
  else if (OFFICE_EXT.has(ext) && process.platform === 'win32') pdf = await officeToPdf(file, dir);
  else throw new Error(`不支持预览 ${ext} 文件`);
  try {
    const r = await renderPages(pdf, dir, first, count);
    return { images: r.images, first, totalPages: r.pages, ...(pdf !== file ? { pdf } : {}) };
  } catch (err) {
    log.warn(`render failed for ${file}`, err);
    throw new Error('页面渲染失败（需要本机 Python + PyMuPDF）');
  }
}

/** Files in a session sandbox whose name contains `query` (newest first), skipping caches/helpers. */
export async function findSandboxFiles(sandbox: string, query: string, limit = 10): Promise<string[]> {
  const q = query.trim().toLowerCase();
  const out: Array<{ file: string; mtime: number }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (canPreview(p) && (!q || e.name.toLowerCase().includes(q)) && e.name !== 'INDEX.md') {
        out.push({ file: p, mtime: (await fs.promises.stat(p)).mtimeMs });
      }
    }
  };
  await walk(sandbox, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((x) => x.file);
}

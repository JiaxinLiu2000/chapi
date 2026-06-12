import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, sessionPaths } from '../config.js';

const SCRIPT = path.join(config.paths.repoRoot, 'tools', 'pdf', 'pdf_tool.py');

export interface PdfToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run the local Python PDF tool via uv (ephemeral pymupdf/pypdf). */
export function runPdfTool(args: string[]): Promise<PdfToolResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'uv',
      ['run', '--with', 'pymupdf', '--with', 'pypdf', 'python', SCRIPT, ...args],
      { cwd: config.paths.repoRoot },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: String(e) }));
  });
}

function resolveInSandbox(sessionId: string, p: string): string {
  const sandbox = sessionPaths(sessionId).sandbox;
  const abs = path.isAbsolute(p) ? p : path.resolve(sandbox, p);
  return abs;
}

export interface PdfEditArgs {
  op: 'info' | 'replace-text' | 'fill-form';
  input: string;
  output?: string;
  /** mapping (replace-text) or field values (fill-form) */
  data?: Record<string, string>;
}

/** High-level PDF edit used by the SDK tool; paths resolved against the sandbox. */
export async function pdfEdit(sessionId: string, args: PdfEditArgs): Promise<PdfToolResult> {
  const input = resolveInSandbox(sessionId, args.input);

  if (args.op === 'info') {
    return runPdfTool(['info', input]);
  }

  const output = resolveInSandbox(sessionId, args.output ?? `out-${Date.now()}.pdf`);
  const dataPath = path.join(sessionPaths(sessionId).sandbox, `.pdf-data-${Date.now()}.json`);
  await fs.writeFile(dataPath, JSON.stringify(args.data ?? {}), 'utf8');
  const sub = args.op === 'replace-text' ? 'replace-text' : 'fill-form';
  const result = await runPdfTool([sub, input, output, dataPath]);
  await fs.rm(dataPath, { force: true }).catch(() => undefined);
  return result;
}

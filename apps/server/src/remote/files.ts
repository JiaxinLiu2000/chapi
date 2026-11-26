/**
 * Shared helpers for remote chats (WeChat / Discord): find the local files a turn
 * produced (registered artifacts + paths mentioned in the reply) and gather a
 * finished turn's output.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Artifact } from '@prisma/client';
import { config, sessionPaths } from '../config.js';
import { prisma } from '../db/client.js';

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const FILE_PATH_RE =
  /(?:[A-Za-z]:[\\/]|\/|\.{0,2}[\\/]?)?(?:[\w\-. ()一-鿿]+[\\/])*[\w\-. ()一-鿿]+\.(?:docx|xlsx|pptx|pdf|csv|png|jpe?g|gif|webp|md|txt|html)\b/gi;

/** "报告在 output/x.docx" → itself, then suffixes starting after each space / CJK char. */
export function pathSuffixes(s: string): string[] {
  const out = [s];
  for (let i = 1; i < s.length && out.length < 24; i++) {
    const prev = s[i - 1]!;
    if (/\s/.test(prev) || /[一-鿿]/.test(prev)) {
      const rest = s.slice(i).trim();
      if (rest && !out.includes(rest)) out.push(rest);
    }
  }
  return out;
}

/** An artifact path / a path mentioned in a reply → a real local file (or null). */
export function resolveLocal(sessionId: string, p: string): string | null {
  const raw = p.trim().replace(/^file:\/\//, '');
  if (!raw || /^https?:/i.test(raw)) return null;
  const sandbox = sessionPaths(sessionId).sandbox;
  const candidates = path.isAbsolute(raw) ? [raw] : [path.join(sandbox, raw), path.join(config.paths.workspaces, raw)];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not there */
    }
  }
  return null;
}

/** Local files to hand over for a turn: registered artifacts first, then paths the reply mentions. */
export function turnFiles(sessionId: string, artifactPaths: string[], text: string, max = 6): string[] {
  const files = new Set<string>();
  for (const p of artifactPaths) {
    const f = resolveLocal(sessionId, p);
    if (f) files.add(f);
  }
  for (const m of text.matchAll(FILE_PATH_RE)) {
    if (files.size >= max) break;
    // The match can swallow prose before the path ("报告在 output/x.docx") — try shorter suffixes.
    for (const cand of pathSuffixes(m[0])) {
      const f = resolveLocal(sessionId, cand);
      if (f) {
        files.add(f);
        break;
      }
    }
  }
  return [...files].slice(0, max);
}

export interface TurnOutput {
  title: string;
  /** All main-agent replies of the turn, joined. */
  text: string;
  artifacts: Artifact[];
}

/**
 * What a finished turn produced, or null when there's nothing to report or the
 * agent is waiting on the user (an open question/approval was already pushed).
 */
export async function collectTurn(sessionId: string, since: Date): Promise<TurnOutput | null> {
  const [openQ, openA] = await Promise.all([
    prisma.pendingQuestion.count({ where: { sessionId, status: 'open', source: 'agent' } }),
    prisma.approval.count({ where: { sessionId, status: 'open' } }),
  ]);
  if (openQ || openA) return null;
  const [msgs, artifacts, session] = await Promise.all([
    prisma.message.findMany({ where: { sessionId, role: 'assistant', type: 'assistant', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } }),
    prisma.artifact.findMany({ where: { sessionId, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } }),
    prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } }),
  ]);
  const text = msgs.map((m) => m.text.trim()).filter(Boolean).join('\n\n');
  if (!text && !artifacts.length) return null;
  return { title: session?.title ?? '', text, artifacts };
}

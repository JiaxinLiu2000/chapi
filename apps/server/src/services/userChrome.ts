import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('userChrome');

/**
 * Per-session opt-in for driving the user's own Chrome (jiaxin.liu@unitpulse.ai
 * profile, already logged in) instead of cloakbrowser. Off by default.
 *
 * Kept in a small JSON file rather than a Session column so toggling it needs no
 * schema push / prisma generate. The sandbox helper (chapi_browser.py) checks it
 * live via GET /api/user-chrome/:sessionId, so a toggle takes effect immediately,
 * even mid-run.
 */
const FILE = path.join(config.paths.data, 'user-chrome-sessions.json');

let enabled: Set<string> | null = null;

function load(): Set<string> {
  if (enabled) return enabled;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    enabled = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    enabled = new Set();
  }
  return enabled;
}

export function isUserChromeEnabled(sessionId: string): boolean {
  return load().has(sessionId);
}

export function setUserChromeEnabled(sessionId: string, on: boolean): void {
  const set = load();
  if (on) set.add(sessionId);
  else set.delete(sessionId);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...set]), 'utf8');
  } catch (err) {
    log.warn('failed to persist user-chrome sessions', err);
  }
}

import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';

const log = createLogger('accounts');

export type AccountName = 'primary' | 'fallback' | 'machine';
export interface ActiveAccount {
  name: AccountName;
  token?: string; // CLAUDE_CODE_OAUTH_TOKEN for the chosen subscription seat
  email?: string;
}

/**
 * Pick which Claude subscription seat a run should use.
 *
 * - No tokens configured → 'machine' (inherit the box's own Claude login, legacy behavior).
 * - `mode` 'primary'/'fallback' pins that seat (manual override, no auto-switch).
 * - `mode` 'auto' (default): prefer primary. Each seat tracks its own reset time
 *   (real, from the SDK, when known); once a seat's reset time has passed it's used
 *   again. If BOTH seats are currently limited, use whichever resets first.
 */
export async function chooseActiveAccount(mode: 'auto' | 'primary' | 'fallback' = 'auto'): Promise<ActiveAccount> {
  const acc = await settings.getClaudeAccounts();
  if (!acc.primaryToken && !acc.fallbackToken) return { name: 'machine' };

  // Manual pin: use the chosen seat directly (fall back to the other if that token is missing).
  if (mode === 'primary') {
    return acc.primaryToken
      ? { name: 'primary', token: acc.primaryToken, email: acc.primaryEmail }
      : { name: 'fallback', token: acc.fallbackToken, email: acc.fallbackEmail };
  }
  if (mode === 'fallback') {
    return acc.fallbackToken
      ? { name: 'fallback', token: acc.fallbackToken, email: acc.fallbackEmail }
      : { name: 'primary', token: acc.primaryToken, email: acc.primaryEmail };
  }

  // Only one seat configured — nothing to compare, just use it.
  if (acc.primaryToken && !acc.fallbackToken) return { name: 'primary', token: acc.primaryToken, email: acc.primaryEmail };
  if (acc.fallbackToken && !acc.primaryToken) return { name: 'fallback', token: acc.fallbackToken, email: acc.fallbackEmail };

  const fo = await settings.getClaudeFailover();
  const now = Date.now();
  // primary/fallbackResetAt are absolute epoch ms already (real SDK resetsAt, or a
  // guessed-cooldown target set at write time by recordAccountLimited) — no extra
  // cooldown math needed here, just compare against now.
  const primaryResetAtMs = fo.primaryResetAt ? Date.parse(fo.primaryResetAt) : 0;
  const fallbackResetAtMs = fo.fallbackResetAt ? Date.parse(fo.fallbackResetAt) : 0;
  const primaryReady = !primaryResetAtMs || now >= primaryResetAtMs;
  const fallbackReady = !fallbackResetAtMs || now >= fallbackResetAtMs;

  let target: 'primary' | 'fallback';
  if (primaryReady) target = 'primary'; // default preference
  else if (fallbackReady) target = 'fallback';
  else target = primaryResetAtMs <= fallbackResetAtMs ? 'primary' : 'fallback'; // both limited — whichever resets first

  if (target !== fo.active) {
    await settings.setClaudeActive(target);
    log.info(`Claude auto account → ${target}`);
  }
  // Once a seat is actually usable again, clear its reset marker.
  if (target === 'primary' && primaryReady && fo.primaryResetAt) await settings.setClaudePrimaryResetAt('');
  if (target === 'fallback' && fallbackReady && fo.fallbackResetAt) await settings.setClaudeFallbackResetAt('');

  return target === 'primary'
    ? { name: 'primary', token: acc.primaryToken, email: acc.primaryEmail }
    : { name: 'fallback', token: acc.fallbackToken, email: acc.fallbackEmail };
}

export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number; // epoch ms — authoritative reset time reported by Anthropic
}

/**
 * Record a seat's rate-limit state.
 *
 * Prefers the Claude Agent SDK's own authoritative `rate_limit_info.resetsAt`
 * (from the `rate_limit_event` message) whenever it's available — that's the
 * real reset time Anthropic reports, not a guess. Only when no such signal was
 * seen (just the coarse `assistant.error === 'rate_limit'` flag) does this fall
 * back to a guessed cooldown (`claude_cooldown_h` from now). A guess never
 * overwrites an already-pending reset time for the same seat (same incident —
 * restamping it would keep sliding the estimate forward on every retry and it
 * might never actually arrive), but real SDK data always wins and corrects it.
 */
export async function recordAccountLimited(account: 'primary' | 'fallback', info?: RateLimitInfo): Promise<void> {
  const fo = await settings.getClaudeFailover();
  const prevIso = account === 'primary' ? fo.primaryResetAt : fo.fallbackResetAt;
  const prevMs = prevIso ? Date.parse(prevIso) : 0;
  const stillPending = prevMs > 0 && Date.now() < prevMs;

  let resetAtMs: number;
  let source: string;
  if (info?.resetsAt) {
    resetAtMs = info.resetsAt;
    source = 'reported by Anthropic';
  } else if (stillPending) {
    log.warn(`Claude ${account} account rate-limited again (still within its existing reset window — clock unchanged)`);
    return;
  } else {
    resetAtMs = Date.now() + fo.cooldownH * 3600_000;
    source = 'guessed cooldown — no rate_limit_event was seen';
  }

  const iso = new Date(resetAtMs).toISOString();
  if (account === 'primary') await settings.setClaudePrimaryResetAt(iso);
  else await settings.setClaudeFallbackResetAt(iso);
  log.warn(`Claude ${account} account rate-limited — resets at ${iso} (${source})`);
}

/** The SDK reported a seat's rate limit is no longer rejecting — clear its marker. */
export async function clearAccountLimit(account: 'primary' | 'fallback'): Promise<void> {
  if (account === 'primary') await settings.setClaudePrimaryResetAt('');
  else await settings.setClaudeFallbackResetAt('');
}

/** Manually go back to the primary seat (clears its reset marker). */
export async function switchToPrimary(): Promise<void> {
  await settings.setClaudeActive('primary');
  await settings.setClaudePrimaryResetAt('');
  log.info('manually switched back to primary Claude account');
}

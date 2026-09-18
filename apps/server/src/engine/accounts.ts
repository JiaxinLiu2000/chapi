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
 * - `mode` 'auto' (default): prefer primary. Each seat's own rate-limit timestamp starts
 *   its own cooldown; once a seat is ready again it's used. If BOTH seats are currently
 *   limited, use whichever seat's cooldown elapses first (soonest to recover).
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
  const cooldownMs = fo.cooldownH * 3600_000;
  const primaryResetAt = fo.primaryLimitedAt ? Date.parse(fo.primaryLimitedAt) + cooldownMs : 0;
  const fallbackResetAt = fo.fallbackLimitedAt ? Date.parse(fo.fallbackLimitedAt) + cooldownMs : 0;
  const primaryReady = !primaryResetAt || now >= primaryResetAt;
  const fallbackReady = !fallbackResetAt || now >= fallbackResetAt;

  let target: 'primary' | 'fallback';
  if (primaryReady) target = 'primary'; // default preference
  else if (fallbackReady) target = 'fallback';
  else target = primaryResetAt <= fallbackResetAt ? 'primary' : 'fallback'; // both limited — whichever cools down first

  if (target !== fo.active) {
    await settings.setClaudeActive(target);
    log.info(`Claude auto account → ${target}`);
  }
  // Once a seat is actually usable again, clear its limited marker.
  if (target === 'primary' && primaryReady && fo.primaryLimitedAt) await settings.setClaudePrimaryLimitedAt('');
  if (target === 'fallback' && fallbackReady && fo.fallbackLimitedAt) await settings.setClaudeFallbackLimitedAt('');

  return target === 'primary'
    ? { name: 'primary', token: acc.primaryToken, email: acc.primaryEmail }
    : { name: 'fallback', token: acc.fallbackToken, email: acc.fallbackEmail };
}

/**
 * Record that a seat just hit its usage limit — starts that seat's own cooldown
 * clock. If a cooldown from an earlier hit on this same seat is still running,
 * this is the same incident (e.g. a retry that predictably failed again while
 * still inside the window) — don't restamp it, or the estimated recovery time
 * would keep sliding forward on every retry and might never actually arrive.
 */
export async function recordAccountLimited(account: 'primary' | 'fallback'): Promise<void> {
  const fo = await settings.getClaudeFailover();
  const prevIso = account === 'primary' ? fo.primaryLimitedAt : fo.fallbackLimitedAt;
  if (prevIso) {
    const prevMs = Date.parse(prevIso);
    if (Number.isFinite(prevMs) && Date.now() - prevMs < fo.cooldownH * 3600_000) {
      log.warn(`Claude ${account} account rate-limited again (still within its existing cooldown — clock unchanged)`);
      return;
    }
  }
  const iso = new Date().toISOString();
  if (account === 'primary') await settings.setClaudePrimaryLimitedAt(iso);
  else await settings.setClaudeFallbackLimitedAt(iso);
  log.warn(`Claude ${account} account rate-limited at ${iso}`);
}

/** Manually go back to the primary seat (clears the limited marker). */
export async function switchToPrimary(): Promise<void> {
  await settings.setClaudeActive('primary');
  await settings.setClaudePrimaryLimitedAt('');
  log.info('manually switched back to primary Claude account');
}

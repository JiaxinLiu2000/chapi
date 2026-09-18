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
 * - `mode` 'auto' (default): primary seat, then stay on fallback after a limit until the
 *   cooldown elapses, then optimistically retry the primary on the next run.
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

  const fo = await settings.getClaudeFailover();
  if (fo.active === 'fallback' && acc.fallbackToken) {
    const limitedMs = fo.primaryLimitedAt ? Date.parse(fo.primaryLimitedAt) : 0;
    const cooled = limitedMs > 0 && Date.now() - limitedMs >= fo.cooldownH * 3600_000;
    if (cooled && acc.primaryToken) {
      await settings.setClaudeActive('primary');
      await settings.setClaudePrimaryLimitedAt('');
      log.info('cooldown elapsed — retrying primary Claude account');
      return { name: 'primary', token: acc.primaryToken, email: acc.primaryEmail };
    }
    return { name: 'fallback', token: acc.fallbackToken, email: acc.fallbackEmail };
  }

  if (acc.primaryToken) return { name: 'primary', token: acc.primaryToken, email: acc.primaryEmail };
  return { name: 'fallback', token: acc.fallbackToken, email: acc.fallbackEmail };
}

/** Primary hit its limit → switch to the fallback seat. Returns it, or null if none configured. */
export async function switchToFallback(): Promise<ActiveAccount | null> {
  const acc = await settings.getClaudeAccounts();
  if (!acc.fallbackToken) return null;
  await settings.setClaudeActive('fallback');
  await settings.setClaudePrimaryLimitedAt(new Date().toISOString());
  log.info(`Claude primary limited — switched to fallback (${acc.fallbackEmail})`);
  return { name: 'fallback', token: acc.fallbackToken, email: acc.fallbackEmail };
}

/** Manually go back to the primary seat (clears the limited marker). */
export async function switchToPrimary(): Promise<void> {
  await settings.setClaudeActive('primary');
  await settings.setClaudePrimaryLimitedAt('');
  log.info('manually switched back to primary Claude account');
}

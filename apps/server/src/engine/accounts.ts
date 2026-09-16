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
 * - Normally the primary seat. After a limit-triggered switch we stay on the fallback until
 *   the cooldown elapses, then optimistically try the primary again on the next run.
 */
export async function chooseActiveAccount(): Promise<ActiveAccount> {
  const acc = await settings.getClaudeAccounts();
  if (!acc.primaryToken && !acc.fallbackToken) return { name: 'machine' };

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

import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = {
  active: 'primary' as 'primary' | 'fallback',
  primaryResetAt: '',
  fallbackResetAt: '',
  cooldownH: 5,
};

vi.mock('../secrets.js', () => ({
  settings: {
    getClaudeAccounts: async () => ({
      primaryToken: 'primary-token',
      fallbackToken: 'fallback-token',
      primaryEmail: 'primary@example.com',
      fallbackEmail: 'fallback@example.com',
    }),
    getClaudeFailover: async () => ({
      active: state.active,
      primaryResetAt: state.primaryResetAt,
      fallbackResetAt: state.fallbackResetAt,
      cooldownH: state.cooldownH,
    }),
    setClaudeActive: async (v: 'primary' | 'fallback') => {
      state.active = v;
    },
    setClaudePrimaryResetAt: async (iso: string) => {
      state.primaryResetAt = iso;
    },
    setClaudeFallbackResetAt: async (iso: string) => {
      state.fallbackResetAt = iso;
    },
  },
}));

const { chooseActiveAccount, recordAccountLimited, clearAccountLimit } = await import('./accounts.js');

describe('dual-account rate-limit tracking', () => {
  beforeEach(() => {
    state.active = 'primary';
    state.primaryResetAt = '';
    state.fallbackResetAt = '';
    state.cooldownH = 5;
  });

  it('records the SDK-reported real resetsAt, not a guessed cooldown', async () => {
    const resetsAt = Date.now() + 60_000; // 1 minute away — nowhere near a 5h guess
    await recordAccountLimited('fallback', { status: 'rejected', resetsAt });
    expect(state.fallbackResetAt).toBe(new Date(resetsAt).toISOString());
  });

  it('falls back to a guessed cooldown when no rate_limit_info was seen', async () => {
    const before = Date.now();
    await recordAccountLimited('primary');
    const resetMs = Date.parse(state.primaryResetAt);
    expect(resetMs).toBeGreaterThan(before + 4 * 3600_000);
    expect(resetMs).toBeLessThan(before + 6 * 3600_000);
  });

  it('does not restamp a guessed cooldown on a repeated hit with no real data (no clock creep)', async () => {
    await recordAccountLimited('primary');
    const first = state.primaryResetAt;
    await recordAccountLimited('primary'); // same incident, still pending, no real data
    expect(state.primaryResetAt).toBe(first);
  });

  it('lets real SDK data override an existing guessed cooldown for the same seat', async () => {
    await recordAccountLimited('primary'); // guessed ~5h out
    const resetsAt = Date.now() + 30_000; // Anthropic says it's actually back in 30s
    await recordAccountLimited('primary', { status: 'rejected', resetsAt });
    expect(state.primaryResetAt).toBe(new Date(resetsAt).toISOString());
  });

  it('clears a seat immediately once the SDK reports it usable again', async () => {
    await recordAccountLimited('fallback', { status: 'rejected', resetsAt: Date.now() + 3600_000 });
    expect(state.fallbackResetAt).not.toBe('');
    await clearAccountLimit('fallback');
    expect(state.fallbackResetAt).toBe('');
  });

  it('auto mode switches to fallback while primary is limited', async () => {
    await recordAccountLimited('primary', { status: 'rejected', resetsAt: Date.now() + 3600_000 });
    const acct = await chooseActiveAccount('auto');
    expect(acct.name).toBe('fallback');
  });

  it('when both seats are limited, picks whichever resets first — instead of refusing both', async () => {
    const now = Date.now();
    await recordAccountLimited('primary', { status: 'rejected', resetsAt: now + 2 * 3600_000 });
    await recordAccountLimited('fallback', { status: 'rejected', resetsAt: now + 1 * 3600_000 });
    const acct = await chooseActiveAccount('auto');
    expect(acct.name).toBe('fallback'); // resets sooner than primary
  });
});

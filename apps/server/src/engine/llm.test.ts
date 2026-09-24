import { describe, expect, it, vi } from 'vitest';

const chooseActiveAccountMock = vi.fn(async (mode?: string) => ({
  name: mode ?? 'auto',
  token: `token-for-${mode ?? 'auto'}`,
}));

vi.mock('./accounts.js', () => ({
  chooseActiveAccount: (mode?: string) => chooseActiveAccountMock(mode),
}));

vi.mock('../secrets.js', () => ({
  settings: {
    getAnthropicKey: async () => undefined,
    getModels: async () => ({ main: 'm', subagent: 'sub', embedding: 'e' }),
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    async function* gen() {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } };
    }
    return gen();
  },
}));

const { complete } = await import('./llm.js');

describe('complete()', () => {
  it('passes a pinned session accountMode through to chooseActiveAccount (not the default auto)', async () => {
    chooseActiveAccountMock.mockClear();
    await complete({ prompt: 'hi', accountMode: 'primary' });
    expect(chooseActiveAccountMock).toHaveBeenCalledWith('primary');
  });

  it('falls back to auto only when no accountMode is supplied', async () => {
    chooseActiveAccountMock.mockClear();
    await complete({ prompt: 'hi' });
    expect(chooseActiveAccountMock).toHaveBeenCalledWith(undefined);
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../secrets.js', () => ({ settings: {} }));

const { summarizeAfterShip, proxyUri } = await import('./emailVerify.js');

// Items in the shape tools/email-verifier (AfterShip email-verifier v1.x Result) emits.
const base = (email: string, over: Record<string, unknown> = {}) => {
  const [username, domain] = email.split('@');
  return {
    email,
    reachable: 'unknown',
    syntax: { username, domain, valid: true },
    smtp: null,
    gravatar: null,
    suggestion: '',
    disposable: false,
    role_account: false,
    free: false,
    has_mx_records: true,
    ...over,
  };
};
const smtp = (over: Record<string, boolean> = {}) => ({
  host_exists: true,
  full_inbox: false,
  catch_all: false,
  deliverable: false,
  disabled: false,
  ...over,
});
const ok = (email: string, over: Record<string, unknown> = {}) => ({
  email,
  result: base(email, over),
  error: null,
  errorKind: null,
});

describe('summarizeAfterShip()', () => {
  it('reports a deliverable personal mailbox as safe', () => {
    const r = summarizeAfterShip(ok('jane@acme.com', { reachable: 'yes', smtp: smtp({ deliverable: true }) }));
    expect(r).toMatchObject({
      status: 'safe',
      syntaxValid: true,
      mxAcceptsMail: true,
      canConnectSmtp: true,
      deliverable: true,
      catchAll: false,
      error: null,
    });
  });

  it('downgrades a deliverable role account to risky', () => {
    const r = summarizeAfterShip(
      ok('info@acme.com', { reachable: 'yes', role_account: true, smtp: smtp({ deliverable: true }) }),
    );
    expect(r).toMatchObject({ status: 'risky', roleAccount: true, deliverable: true });
  });

  it('reports a catch-all domain as risky (individual mailbox unconfirmed)', () => {
    const r = summarizeAfterShip(ok('x@acme.com', { smtp: smtp({ catch_all: true }) }));
    expect(r).toMatchObject({ status: 'risky', catchAll: true, deliverable: false });
  });

  it('reports a mailbox the server refused as invalid', () => {
    const r = summarizeAfterShip(ok('nobody@acme.com', { reachable: 'no', smtp: smtp() }));
    expect(r).toMatchObject({ status: 'invalid', canConnectSmtp: true, deliverable: false });
  });

  it('keeps SMTP fields null and status unknown when the SMTP step errored (port 25 blocked)', () => {
    const r = summarizeAfterShip({
      email: 'someone@gmail.com',
      result: base('someone@gmail.com', { free: true, smtp: smtp({ host_exists: false }) }),
      error: 'The connection to the mail server has timed out : dial tcp 1.2.3.4:25: i/o timeout',
      errorKind: 'The connection to the mail server has timed out',
    });
    expect(r).toMatchObject({
      status: 'unknown',
      free: true,
      mxAcceptsMail: true,
      canConnectSmtp: false,
      deliverable: null,
      catchAll: null,
    });
    expect(r.error).toMatch(/timed out/);
  });

  it('reports a domain that does not exist as invalid', () => {
    const r = summarizeAfterShip({
      email: 'a@no-such-domain-xyz-9911.com',
      result: base('a@no-such-domain-xyz-9911.com', { reachable: 'no', has_mx_records: false }),
      error: 'Mail server does not exist : lookup no-such-domain-xyz-9911.com: no such host',
      errorKind: 'Mail server does not exist',
    });
    expect(r).toMatchObject({ status: 'invalid', mxAcceptsMail: false, canConnectSmtp: null });
  });

  it('reports a domain with no MX records as invalid', () => {
    const r = summarizeAfterShip({
      email: 'a@acme.com',
      result: base('a@acme.com', { has_mx_records: false, smtp: smtp({ host_exists: false }) }),
      error: 'No MX records found : No MX records found',
      errorKind: 'No MX records found',
    });
    expect(r).toMatchObject({ status: 'invalid', mxAcceptsMail: false });
  });

  it('treats a DNS failure other than "no such host" as unknown, not invalid', () => {
    const r = summarizeAfterShip({
      email: 'a@acme.com',
      result: base('a@acme.com', { has_mx_records: false }),
      error: 'lookup acme.com: i/o timeout',
      errorKind: null,
    });
    expect(r).toMatchObject({ status: 'unknown', mxAcceptsMail: null });
  });

  it('flags a disposable address as risky without claiming anything about MX', () => {
    const r = summarizeAfterShip(ok('test@mailinator.com', { disposable: true, has_mx_records: false }));
    expect(r).toMatchObject({ status: 'risky', disposable: true, mxAcceptsMail: null, deliverable: null });
  });

  it('reports bad syntax as invalid', () => {
    const r = summarizeAfterShip(ok('bad@', { syntax: { username: '', domain: '', valid: false } }));
    expect(r).toMatchObject({ status: 'invalid', syntaxValid: false, mxAcceptsMail: null });
  });

  it('turns a domain suggestion into a full-address suggestion', () => {
    const r = summarizeAfterShip(ok('jane@gmial.com', { suggestion: 'gmail.com' }));
    expect(r.suggestion).toBe('jane@gmail.com');
    expect(summarizeAfterShip(ok('jane@gmail.com')).suggestion).toBeNull();
  });

  it('degrades to unknown when the verifier produced no result', () => {
    const r = summarizeAfterShip({ email: 'x@y.com', result: null, error: 'boom', errorKind: null });
    expect(r).toMatchObject({ status: 'unknown', syntaxValid: false, deliverable: null, error: 'boom' });
  });
});

describe('proxyUri()', () => {
  it('builds a socks5 URI, escaping credentials', () => {
    expect(proxyUri(undefined)).toBe('');
    expect(proxyUri({ host: 'p.example.com', port: 1080 })).toBe('socks5://p.example.com:1080');
    expect(proxyUri({ host: 'p.example.com', port: 1080, username: 'u@x', password: 'p:w/d' })).toBe(
      'socks5://u%40x:p%3Aw%2Fd@p.example.com:1080',
    );
  });
});

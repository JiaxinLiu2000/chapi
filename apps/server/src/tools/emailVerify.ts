import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type {
  EmailVerifyResponse,
  EmailVerifyResult,
  EmailVerifyStatusResponse,
} from '@chapi/shared';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import { settings } from '../secrets.js';

const log = createLogger('email-verify');

/**
 * Email verification via github.com/AfterShip/email-verifier, wrapped by the
 * small Go program in tools/email-verifier. chapi builds it on first use
 * (`go build` → data/bin) and runs it once per batch: JSON request on stdin,
 * one JSON item per address on stdout. No daemon, no port, no Docker.
 */
const SRC_DIR = path.join(config.paths.repoRoot, 'tools', 'email-verifier');
const SRC_FILES = ['main.go', 'go.mod', 'go.sum'];
const BIN = path.join(
  config.paths.data,
  'bin',
  `chapi-email-verifier${process.platform === 'win32' ? '.exe' : ''}`,
);
const STAMP = `${BIN}.src-hash`;
// Low on purpose: mail servers rate-limit/blacklist IPs that probe too fast.
const CONCURRENCY = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const OPERATION_TIMEOUT_MS = 10_000;
// Worst case per address: connect + EHLO + MAIL + 2×RCPT, each up to its timeout.
const PER_ROUND_MS = CONNECT_TIMEOUT_MS + 4 * OPERATION_TIMEOUT_MS + 10_000;
const BUILD_TIMEOUT_MS = 10 * 60_000; // first build downloads modules
const PORT25_PROBE_TTL_MS = 10 * 60_000;

// AfterShip's LookupError messages (error.go) the mapping depends on.
const ERR_NO_SUCH_HOST = 'Mail server does not exist';
const ERR_NO_MX = 'No MX records found';

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      stderr += `\n超时(${Math.round(opts.timeoutMs / 1000)}s)，已终止`;
      child.kill();
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr: stderr.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(e) });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

/**
 * `go` on PATH, else the default install locations (a server started before Go
 * was installed has a stale PATH): the MSI's Program Files dir, or the official
 * zip unpacked per-user under %LOCALAPPDATA%\Programs (no admin rights needed).
 */
async function findGo(): Promise<string | null> {
  const candidates = ['go'];
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Go\\bin\\go.exe');
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'go', 'bin', 'go.exe'));
    }
  } else candidates.push('/usr/local/go/bin/go');
  for (const c of candidates) {
    const r = await run(c, ['version'], { timeoutMs: 10_000 });
    if (r.code === 0) return c;
  }
  return null;
}

function sourceHash(): string {
  const h = crypto.createHash('sha1');
  for (const f of SRC_FILES) h.update(fs.readFileSync(path.join(SRC_DIR, f)));
  return h.digest('hex');
}

/** Can this machine open outbound TCP 25 at all? SMTP verification needs it (or a proxy). */
function probePort25(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: 'gmail-smtp-in.l.google.com', port: 25 });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(5000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** socks5:// URI for AfterShip's Proxy(); '' = connect directly. */
export function proxyUri(proxy?: { host: string; port: number; username?: string; password?: string }): string {
  if (!proxy) return '';
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''}@`
    : '';
  return `socks5://${auth}${proxy.host}:${proxy.port}`;
}

/** One item as emitted by tools/email-verifier (`result` is AfterShip's Result). */
export interface VerifierItem {
  email: string;
  result: {
    reachable?: string;
    syntax?: { username?: string; domain?: string; valid?: boolean };
    smtp?: {
      host_exists?: boolean;
      full_inbox?: boolean;
      catch_all?: boolean;
      deliverable?: boolean;
      disabled?: boolean;
    } | null;
    suggestion?: string;
    disposable?: boolean;
    role_account?: boolean;
    free?: boolean;
    has_mx_records?: boolean;
  } | null;
  error: string | null;
  errorKind: string | null;
}

/** Map AfterShip's result (+ its error) onto the compact verdict the agent/UI use. */
export function summarizeAfterShip(item: VerifierItem): EmailVerifyResult {
  const r = item.result;
  const syntaxValid = Boolean(r?.syntax?.valid);
  const disposable = Boolean(r?.disposable);
  const roleAccount = Boolean(r?.role_account);
  const smtp = r?.smtp ?? null;

  // Verify() stops before MX for bad syntax and disposable domains, and a DNS
  // failure other than NXDOMAIN says nothing either way → null ("not checked").
  let mxAcceptsMail: boolean | null = null;
  if (syntaxValid && !disposable) {
    if (item.errorKind === ERR_NO_SUCH_HOST || item.errorKind === ERR_NO_MX) mxAcceptsMail = false;
    else if (smtp || !item.error) mxAcceptsMail = Boolean(r?.has_mx_records);
  }

  // An error during SMTP leaves the booleans at their zero values — not answers.
  const smtpOk = smtp !== null && !item.error;
  const pick = (v: boolean | undefined) => (smtpOk ? Boolean(v) : null);
  const deliverable = pick(smtp?.deliverable);
  const catchAll = pick(smtp?.catch_all);
  const fullInbox = pick(smtp?.full_inbox);

  let status: EmailVerifyResult['status'];
  if (!r) status = 'unknown';
  else if (!syntaxValid) status = 'invalid';
  else if (disposable) status = 'risky';
  else if (mxAcceptsMail === false) status = 'invalid';
  else if (!smtpOk) status = 'unknown';
  else if (deliverable) status = roleAccount || fullInbox ? 'risky' : 'safe';
  // A catch-all domain short-circuits before the real address is asked about.
  else if (catchAll) status = 'risky';
  else status = 'invalid'; // server refused the address itself

  const username = r?.syntax?.username;
  const suggested = r?.suggestion && username ? `${username}@${r.suggestion}` : null;

  return {
    email: item.email,
    status,
    syntaxValid,
    suggestion: suggested && suggested.toLowerCase() !== item.email.toLowerCase() ? suggested : null,
    mxAcceptsMail,
    canConnectSmtp: smtp ? Boolean(smtp.host_exists) : null,
    deliverable,
    catchAll,
    fullInbox,
    disabled: pick(smtp?.disabled),
    disposable,
    roleAccount,
    free: Boolean(r?.free),
    error: item.error,
  };
}

class EmailVerifier {
  private building: Promise<string | null> | null = null;
  private ready = false;
  private goPath: string | null | undefined; // undefined = not looked up yet
  private logs: string[] = [];
  private port25: { open: boolean; at: number } | null = null;

  private pushLog(line: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    this.logs.push(`[${ts}] ${line}`);
    if (this.logs.length > 60) this.logs = this.logs.slice(-60);
    log.info(line);
  }

  private async port25Open(): Promise<boolean> {
    if (this.port25 && Date.now() - this.port25.at < PORT25_PROBE_TTL_MS) return this.port25.open;
    const open = await probePort25();
    this.port25 = { open, at: Date.now() };
    return open;
  }

  /** Is the built binary present and built from the current source? */
  private upToDate(): boolean {
    try {
      return fs.existsSync(BIN) && fs.readFileSync(STAMP, 'utf8').trim() === sourceHash();
    } catch {
      return false;
    }
  }

  /** Idempotent: build the verifier if missing/stale. Resolves to the binary path, or null on failure. */
  ensureBinary(): Promise<string | null> {
    if (this.upToDate()) {
      this.ready = true;
      return Promise.resolve(BIN);
    }
    this.building ??= this.build()
      .catch((e: unknown) => {
        // e.g. a source file missing mid-edit, or data/bin not writable.
        this.pushLog(`编译邮箱验证程序出错：${e instanceof Error ? e.message : String(e)}`);
        return null;
      })
      .finally(() => (this.building = null));
    return this.building;
  }

  /** Warm-up hook for startup / enabling in Settings: build ahead of the first call. */
  async prepare(): Promise<void> {
    if (await settings.getEmailVerifyEnabled()) await this.ensureBinary();
  }

  private async build(): Promise<string | null> {
    this.ready = false;
    this.goPath = await findGo();
    if (!this.goPath) {
      this.pushLog('未找到 Go 工具链，无法编译邮箱验证程序。请安装 Go（Windows: `winget install GoLang.Go`）后重试。');
      return null;
    }
    this.pushLog('编译邮箱验证程序（AfterShip email-verifier；首次需下载依赖）…');
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    const tmp = `${BIN}.tmp`;
    const hash = sourceHash();
    const r = await run(this.goPath, ['build', '-trimpath', '-ldflags', '-s -w', '-o', tmp, '.'], {
      cwd: SRC_DIR,
      timeoutMs: BUILD_TIMEOUT_MS,
      // The launcher's FORCE_COLOR would otherwise leak escape codes into go's output.
      env: { ...process.env, FORCE_COLOR: '0', CGO_ENABLED: '0' },
    });
    if (r.code !== 0) {
      this.pushLog(`go build 失败：${r.stderr.slice(0, 500)}`);
      return null;
    }
    fs.renameSync(tmp, BIN);
    fs.writeFileSync(STAMP, hash);
    this.ready = true;
    this.pushLog(`邮箱验证程序已就绪（${BIN}）`);
    return BIN;
  }

  async status(): Promise<EmailVerifyStatusResponse> {
    const enabled = await settings.getEmailVerifyEnabled();
    const ready = this.ready || this.upToDate();
    const { proxy } = await settings.getEmailVerifyConfig();
    const port25Open = enabled ? await this.port25Open() : (this.port25?.open ?? null);
    return {
      enabled,
      ready,
      building: this.building !== null,
      goInstalled: this.goPath === undefined ? null : this.goPath !== null,
      proxyConfigured: Boolean(proxy),
      port25Open,
      message: !enabled
        ? '未启用邮箱验证。'
        : ready
          ? '邮箱验证程序已就绪。'
          : this.building
            ? '正在编译邮箱验证程序（首次需下载依赖）…'
            : this.goPath === null
              ? '未安装 Go，无法编译邮箱验证程序（Windows: winget install GoLang.Go）。'
              : '邮箱验证程序尚未编译，首次验证时会自动编译。',
      logs: this.logs.slice(),
    };
  }

  /** Verify addresses (deduped). Throws if disabled or the verifier can't be built/run. */
  async verify(emails: string[]): Promise<EmailVerifyResponse & { raw: VerifierItem[] }> {
    if (!(await settings.getEmailVerifyEnabled())) {
      throw new Error('邮箱验证未启用：请在「设置 → 邮箱验证」中勾选启用并保存。');
    }
    const bin = await this.ensureBinary();
    if (!bin) {
      throw new Error(`邮箱验证程序未能编译。最近日志：\n${this.logs.slice(-5).join('\n')}`);
    }
    const list = [...new Set(emails.map((e) => e.trim()).filter(Boolean))];
    const { proxy, fromEmail, helloName } = await settings.getEmailVerifyConfig();
    const r = await run(bin, [], {
      input: JSON.stringify({
        emails: list,
        proxy: proxyUri(proxy),
        fromEmail,
        helloName,
        concurrency: CONCURRENCY,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        operationTimeoutMs: OPERATION_TIMEOUT_MS,
      }),
      timeoutMs: 30_000 + Math.ceil(list.length / CONCURRENCY) * PER_ROUND_MS,
    });
    let raw: VerifierItem[];
    try {
      raw = JSON.parse(r.stdout) as VerifierItem[];
      if (!Array.isArray(raw)) throw new Error('not an array');
    } catch {
      throw new Error(`邮箱验证程序运行失败（exit ${r.code}）：${r.stderr.slice(0, 500)}`);
    }
    const results = raw.map(summarizeAfterShip);

    const notes: string[] = [];
    // Couldn't even open the SMTP connection (Windows reports a blocked port 25 as
    // a "connectex" failure rather than a timeout, so don't key on the error kind).
    const smtpStuck = results.some((x) => x.status === 'unknown' && x.canConnectSmtp === false);
    if (smtpStuck && !proxy && !(await this.port25Open())) {
      notes.push(
        '本机出站 25 端口被封（家用宽带常见），SMTP 层无法验证，所以结果多为 unknown——只有语法/MX/一次性邮箱/角色账号/免费邮箱检测有效。' +
          '要做真正的收件箱级验证，请在「设置 → 邮箱验证」配置一个开放 25 端口的 SOCKS5 代理。',
      );
    }
    return { results, notes, raw };
  }
}

export const emailVerifier = new EmailVerifier();

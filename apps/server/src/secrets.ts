import crypto from 'node:crypto';
import { MODEL_OPTIONS, type PublicSettingsDTO, type UpdateSettingsInput } from '@chapi/shared';
import { config } from './config.js';
import { prisma } from './db/client.js';
import { createLogger } from './logger.js';

const log = createLogger('secrets');

const KEY_OPENAI = 'openai_key';
const KEY_ANTHROPIC = 'anthropic_key';
const KEY_GOOGLE_ID = 'google_oauth_client_id';
const KEY_GOOGLE_SECRET = 'google_oauth_client_secret';
const KEY_GOOGLE_EMAIL = 'google_user_email';
const KEY_GOOGLE_CONNECTED = 'google_connected';
const KEY_MAIN_MODEL = 'main_model';
const KEY_SUBAGENT_MODEL = 'subagent_model';
const KEY_QUALITY_MODEL = 'quality_model';
const KEY_LEARNING_MODEL = 'learning_model';
const KEY_EMBEDDING_MODEL = 'embedding_model';
const KEY_CANVA_ENABLED = 'canva_enabled';
const KEY_BROWSER_ENABLED = 'browser_enabled';
const KEY_BROWSER_HIDDEN = 'browser_hidden';
const KEY_MAX_SUBAGENTS = 'max_subagents';
const KEY_MAX_BROWSER_PAGES = 'max_browser_pages';
// Claude account failover (two subscription seats).
const KEY_CLAUDE_TOKEN_PRIMARY = 'claude_token_primary';
const KEY_CLAUDE_TOKEN_FALLBACK = 'claude_token_fallback';
const KEY_CLAUDE_EMAIL_PRIMARY = 'claude_email_primary';
const KEY_CLAUDE_EMAIL_FALLBACK = 'claude_email_fallback';
const KEY_CLAUDE_ACTIVE = 'claude_active'; // 'primary' | 'fallback'
// ISO timestamp for when a seat's rate limit resets — the SDK's real `resetsAt`
// when known, else a `claude_cooldown_h`-based guess (see accounts.ts).
const KEY_CLAUDE_PRIMARY_RESET_AT = 'claude_primary_reset_at';
const KEY_CLAUDE_FALLBACK_RESET_AT = 'claude_fallback_reset_at';
const KEY_CLAUDE_COOLDOWN_H = 'claude_cooldown_h';
const KEY_CLAUDE_MODELS_PRIMARY = 'claude_models_primary'; // comma-separated model IDs
const KEY_CLAUDE_MODELS_FALLBACK = 'claude_models_fallback';
// Email verification (AfterShip email-verifier) + optional SOCKS5 proxy for SMTP.
const KEY_EMAIL_VERIFY_ENABLED = 'email_verify_enabled';
const KEY_EMAIL_PROXY_HOST = 'email_verify_proxy_host';
const KEY_EMAIL_PROXY_PORT = 'email_verify_proxy_port';
const KEY_EMAIL_PROXY_USERNAME = 'email_verify_proxy_username';
const KEY_EMAIL_PROXY_PASSWORD = 'email_verify_proxy_password';
const KEY_EMAIL_FROM_EMAIL = 'email_verify_from_email';
const KEY_EMAIL_HELLO_NAME = 'email_verify_hello_name';

const KEY_DISCORD_TOKEN = 'discord_bot_token';
const KEY_DISCORD_CHANNEL = 'discord_channel_id';
const KEY_DISCORD_PREFS = 'discord_prefs';

export interface DiscordPrefs {
  /** Board automation runs (cron or "run now" on the computer) get a Discord thread by themselves. */
  autoAutomations: boolean;
  /** Manual-mode automations ping the channel when their slot comes (with a ▶ button). */
  remindManual: boolean;
}
const DEFAULT_DISCORD_PREFS: DiscordPrefs = { autoAutomations: true, remindManual: true };

const ALL_MODEL_IDS = MODEL_OPTIONS.map((m) => m.id);

const SECRET_KEYS = new Set([
  KEY_DISCORD_TOKEN,
  KEY_OPENAI,
  KEY_ANTHROPIC,
  KEY_GOOGLE_ID,
  KEY_GOOGLE_SECRET,
  KEY_CLAUDE_TOKEN_PRIMARY,
  KEY_CLAUDE_TOKEN_FALLBACK,
  KEY_EMAIL_PROXY_PASSWORD,
]);

/** Derive a stable 32-byte key from the configured secret (any format). */
function encryptionKey(): Buffer | null {
  if (!config.secretsKey) return null;
  return crypto.createHash('sha256').update(config.secretsKey).digest();
}

function encrypt(plain: string): { value: string; encrypted: boolean } {
  const key = encryptionKey();
  if (!key) {
    log.warn('SECRETS_KEY not set — storing secret unencrypted. Set SECRETS_KEY in .env.');
    return { value: plain, encrypted: false };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    value: `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`,
    encrypted: true,
  };
}

function decrypt(payload: string): string {
  const key = encryptionKey();
  if (!key) return payload;
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return payload;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    log.error('Failed to decrypt a stored secret (wrong SECRETS_KEY?).', err);
    return '';
  }
}

class SettingsStore {
  private async readRaw(key: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key } });
    if (!row) return null;
    return row.encrypted ? decrypt(row.value) : row.value;
  }

  private async write(key: string, value: string): Promise<void> {
    const isSecret = SECRET_KEYS.has(key);
    const { value: stored, encrypted } = isSecret
      ? encrypt(value)
      : { value, encrypted: false };
    await prisma.setting.upsert({
      where: { key },
      update: { value: stored, encrypted },
      create: { key, value: stored, encrypted },
    });
  }

  async getOpenAiKey(): Promise<string | undefined> {
    return (await this.readRaw(KEY_OPENAI)) || config.openAiApiKey;
  }

  async getAnthropicKey(): Promise<string | undefined> {
    return (await this.readRaw(KEY_ANTHROPIC)) || config.anthropicApiKey;
  }

  async getGoogleOAuth(): Promise<{ clientId?: string; clientSecret?: string }> {
    return {
      clientId: (await this.readRaw(KEY_GOOGLE_ID)) || config.googleOAuthClientId,
      clientSecret:
        (await this.readRaw(KEY_GOOGLE_SECRET)) || config.googleOAuthClientSecret,
    };
  }

  async getGoogleUserEmail(): Promise<string | undefined> {
    return (await this.readRaw(KEY_GOOGLE_EMAIL)) || config.googleUserEmail;
  }

  async getGoogleConnected(): Promise<boolean> {
    return (await this.readRaw(KEY_GOOGLE_CONNECTED)) === 'true';
  }

  async setGoogleConnected(value: boolean): Promise<void> {
    await this.write(KEY_GOOGLE_CONNECTED, String(value));
  }

  async getModels(): Promise<{ main: string; subagent: string; embedding: string; quality: string; learning: string }> {
    const subagent = (await this.readRaw(KEY_SUBAGENT_MODEL)) || config.subagentModel;
    return {
      main: (await this.readRaw(KEY_MAIN_MODEL)) || config.mainModel,
      subagent,
      embedding: (await this.readRaw(KEY_EMBEDDING_MODEL)) || config.embeddingModel,
      // "" = follow the sub-agent model
      quality: (await this.readRaw(KEY_QUALITY_MODEL)) || subagent,
      learning: (await this.readRaw(KEY_LEARNING_MODEL)) || subagent,
    };
  }

  async getCanvaEnabled(): Promise<boolean> {
    return (await this.readRaw(KEY_CANVA_ENABLED)) === 'true';
  }

  async getBrowserEnabled(): Promise<boolean> {
    const raw = await this.readRaw(KEY_BROWSER_ENABLED);
    if (raw === null) return process.env.CHAPI_ENABLE_BROWSER === '1';
    return raw === 'true';
  }

  /** Run the browser headless (no taskbar window); still visible via the CDP screencast. */
  async getBrowserHidden(): Promise<boolean> {
    return (await this.readRaw(KEY_BROWSER_HIDDEN)) === 'true';
  }

  async getMaxSubagents(): Promise<number> {
    const raw = await this.readRaw(KEY_MAX_SUBAGENTS);
    const n = raw ? Number.parseInt(raw, 10) : config.maxSubagents;
    return Number.isFinite(n) ? Math.min(8, Math.max(1, n)) : config.maxSubagents;
  }

  async getMaxBrowserPages(): Promise<number> {
    const raw = await this.readRaw(KEY_MAX_BROWSER_PAGES);
    const n = raw ? Number.parseInt(raw, 10) : config.maxBrowserPages;
    return Number.isFinite(n) ? Math.min(2, Math.max(1, n)) : config.maxBrowserPages;
  }

  // ── Claude account failover ────────────────────────────────────────────
  async getClaudeAccounts(): Promise<{
    primaryToken?: string;
    fallbackToken?: string;
    primaryEmail: string;
    fallbackEmail: string;
  }> {
    return {
      primaryToken: (await this.readRaw(KEY_CLAUDE_TOKEN_PRIMARY)) || undefined,
      fallbackToken: (await this.readRaw(KEY_CLAUDE_TOKEN_FALLBACK)) || undefined,
      primaryEmail: (await this.readRaw(KEY_CLAUDE_EMAIL_PRIMARY)) || 'jiaxin.liu@unitpulse.ai',
      fallbackEmail: (await this.readRaw(KEY_CLAUDE_EMAIL_FALLBACK)) || 'liu.j37@northeastern.edu',
    };
  }

  async getClaudeFailover(): Promise<{
    active: 'primary' | 'fallback';
    primaryResetAt: string;
    fallbackResetAt: string;
    cooldownH: number;
  }> {
    const active = (await this.readRaw(KEY_CLAUDE_ACTIVE)) === 'fallback' ? 'fallback' : 'primary';
    const n = Number.parseInt((await this.readRaw(KEY_CLAUDE_COOLDOWN_H)) || '5', 10);
    return {
      active,
      primaryResetAt: (await this.readRaw(KEY_CLAUDE_PRIMARY_RESET_AT)) || '',
      fallbackResetAt: (await this.readRaw(KEY_CLAUDE_FALLBACK_RESET_AT)) || '',
      cooldownH: Number.isFinite(n) ? Math.min(72, Math.max(1, n)) : 5,
    };
  }

  async setClaudeActive(v: 'primary' | 'fallback'): Promise<void> {
    await this.write(KEY_CLAUDE_ACTIVE, v);
  }

  async setClaudePrimaryResetAt(iso: string): Promise<void> {
    await this.write(KEY_CLAUDE_PRIMARY_RESET_AT, iso);
  }

  async setClaudeFallbackResetAt(iso: string): Promise<void> {
    await this.write(KEY_CLAUDE_FALLBACK_RESET_AT, iso);
  }

  private async modelsFor(key: string): Promise<string[]> {
    const raw = await this.readRaw(key);
    if (!raw) return [...ALL_MODEL_IDS];
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return ids.length ? ids : [...ALL_MODEL_IDS];
  }

  async getClaudeModels(): Promise<{ primary: string[]; fallback: string[] }> {
    return {
      primary: await this.modelsFor(KEY_CLAUDE_MODELS_PRIMARY),
      fallback: await this.modelsFor(KEY_CLAUDE_MODELS_FALLBACK),
    };
  }

  /** Discord remote: bot token (secret) + the channel threads are created in. */
  async getDiscord(): Promise<{ token?: string; channelId?: string }> {
    return {
      token: (await this.readRaw(KEY_DISCORD_TOKEN)) || undefined,
      channelId: (await this.readRaw(KEY_DISCORD_CHANNEL)) || undefined,
    };
  }

  async setDiscord(input: { token?: string | null; channelId?: string | null }): Promise<void> {
    // Clearing deletes the row: an encrypted empty string doesn't decrypt back to ''.
    const put = async (key: string, v: string | null | undefined) => {
      if (v === undefined) return;
      if (v) await this.write(key, v);
      else await prisma.setting.deleteMany({ where: { key } });
    };
    await put(KEY_DISCORD_TOKEN, input.token);
    await put(KEY_DISCORD_CHANNEL, input.channelId);
  }

  async getDiscordPrefs(): Promise<DiscordPrefs> {
    const raw = await this.readRaw(KEY_DISCORD_PREFS);
    if (!raw) return { ...DEFAULT_DISCORD_PREFS };
    try {
      const v = JSON.parse(raw) as Partial<DiscordPrefs>;
      return {
        autoAutomations: typeof v.autoAutomations === 'boolean' ? v.autoAutomations : DEFAULT_DISCORD_PREFS.autoAutomations,
        remindManual: typeof v.remindManual === 'boolean' ? v.remindManual : DEFAULT_DISCORD_PREFS.remindManual,
      };
    } catch {
      return { ...DEFAULT_DISCORD_PREFS };
    }
  }

  async setDiscordPrefs(patch: Partial<DiscordPrefs>): Promise<DiscordPrefs> {
    const next = { ...(await this.getDiscordPrefs()), ...patch };
    await this.write(KEY_DISCORD_PREFS, JSON.stringify(next));
    return next;
  }

  async getEmailVerifyEnabled(): Promise<boolean> {
    return (await this.readRaw(KEY_EMAIL_VERIFY_ENABLED)) === 'true';
  }

  /** SMTP options for the verifier; `proxy` is set only when a SOCKS5 host+port are configured. */
  async getEmailVerifyConfig(): Promise<{
    proxy?: { host: string; port: number; username?: string; password?: string };
    fromEmail: string;
    helloName: string;
  }> {
    const host = ((await this.readRaw(KEY_EMAIL_PROXY_HOST)) || '').trim();
    const port = Number.parseInt((await this.readRaw(KEY_EMAIL_PROXY_PORT)) || '', 10);
    const username = (await this.readRaw(KEY_EMAIL_PROXY_USERNAME)) || undefined;
    const password = (await this.readRaw(KEY_EMAIL_PROXY_PASSWORD)) || undefined;
    return {
      ...(host && Number.isFinite(port) ? { proxy: { host, port, username, password } } : {}),
      fromEmail: (await this.readRaw(KEY_EMAIL_FROM_EMAIL)) || '',
      helloName: (await this.readRaw(KEY_EMAIL_HELLO_NAME)) || '',
    };
  }

  async getPublic(): Promise<PublicSettingsDTO> {
    const models = await this.getModels();
    const google = await this.getGoogleOAuth();
    return {
      mainModel: models.main,
      subagentModel: models.subagent,
      qualityModel: (await this.readRaw(KEY_QUALITY_MODEL)) || '',
      learningModel: (await this.readRaw(KEY_LEARNING_MODEL)) || '',
      embeddingModel: models.embedding,
      hasOpenAiKey: Boolean(await this.getOpenAiKey()),
      hasAnthropicKey: Boolean(await this.getAnthropicKey()),
      hasGoogleOAuth: Boolean(google.clientId && google.clientSecret),
      googleConnected: await this.getGoogleConnected(),
      googleUserEmail: (await this.getGoogleUserEmail()) ?? '',
      canvaEnabled: await this.getCanvaEnabled(),
      enableBrowser: await this.getBrowserEnabled(),
      browserHidden: await this.getBrowserHidden(),
      maxSubagents: await this.getMaxSubagents(),
      maxBrowserPages: await this.getMaxBrowserPages(),
      hasClaudeTokenPrimary: Boolean((await this.readRaw(KEY_CLAUDE_TOKEN_PRIMARY)) || ''),
      hasClaudeTokenFallback: Boolean((await this.readRaw(KEY_CLAUDE_TOKEN_FALLBACK)) || ''),
      claudeEmailPrimary: (await this.readRaw(KEY_CLAUDE_EMAIL_PRIMARY)) || 'jiaxin.liu@unitpulse.ai',
      claudeEmailFallback: (await this.readRaw(KEY_CLAUDE_EMAIL_FALLBACK)) || 'liu.j37@northeastern.edu',
      claudeActive: (await this.getClaudeFailover()).active,
      claudePrimaryResetAt: (await this.readRaw(KEY_CLAUDE_PRIMARY_RESET_AT)) || '',
      claudeCooldownH: (await this.getClaudeFailover()).cooldownH,
      claudeModelsPrimary: await this.modelsFor(KEY_CLAUDE_MODELS_PRIMARY),
      claudeModelsFallback: await this.modelsFor(KEY_CLAUDE_MODELS_FALLBACK),
      emailVerifyEnabled: await this.getEmailVerifyEnabled(),
      emailVerifyProxyHost: (await this.readRaw(KEY_EMAIL_PROXY_HOST)) || '',
      emailVerifyProxyPort:
        Number.parseInt((await this.readRaw(KEY_EMAIL_PROXY_PORT)) || '', 10) || null,
      emailVerifyProxyUsername: (await this.readRaw(KEY_EMAIL_PROXY_USERNAME)) || '',
      hasEmailVerifyProxyPassword: Boolean(await this.readRaw(KEY_EMAIL_PROXY_PASSWORD)),
      emailVerifyFromEmail: (await this.readRaw(KEY_EMAIL_FROM_EMAIL)) || '',
      emailVerifyHelloName: (await this.readRaw(KEY_EMAIL_HELLO_NAME)) || '',
    };
  }

  async update(input: UpdateSettingsInput): Promise<void> {
    const entries: Array<[string, string | undefined]> = [
      [KEY_OPENAI, input.openAiKey],
      [KEY_ANTHROPIC, input.anthropicKey],
      [KEY_GOOGLE_ID, input.googleOAuthClientId],
      [KEY_GOOGLE_SECRET, input.googleOAuthClientSecret],
      [KEY_GOOGLE_EMAIL, input.googleUserEmail],
      [KEY_MAIN_MODEL, input.mainModel],
      [KEY_SUBAGENT_MODEL, input.subagentModel],
      [KEY_EMBEDDING_MODEL, input.embeddingModel],
      [
        KEY_CANVA_ENABLED,
        input.canvaEnabled === undefined ? undefined : String(input.canvaEnabled),
      ],
      [
        KEY_BROWSER_ENABLED,
        input.enableBrowser === undefined ? undefined : String(input.enableBrowser),
      ],
      [
        KEY_BROWSER_HIDDEN,
        input.browserHidden === undefined ? undefined : String(input.browserHidden),
      ],
      [
        KEY_MAX_SUBAGENTS,
        input.maxSubagents === undefined ? undefined : String(input.maxSubagents),
      ],
      [
        KEY_MAX_BROWSER_PAGES,
        input.maxBrowserPages === undefined ? undefined : String(input.maxBrowserPages),
      ],
      [KEY_CLAUDE_TOKEN_PRIMARY, input.claudeTokenPrimary],
      [KEY_CLAUDE_TOKEN_FALLBACK, input.claudeTokenFallback],
      [KEY_CLAUDE_EMAIL_PRIMARY, input.claudeEmailPrimary],
      [KEY_CLAUDE_EMAIL_FALLBACK, input.claudeEmailFallback],
      [
        KEY_CLAUDE_COOLDOWN_H,
        input.claudeCooldownH === undefined ? undefined : String(input.claudeCooldownH),
      ],
      [
        KEY_CLAUDE_MODELS_PRIMARY,
        input.claudeModelsPrimary === undefined ? undefined : input.claudeModelsPrimary.join(','),
      ],
      [
        KEY_CLAUDE_MODELS_FALLBACK,
        input.claudeModelsFallback === undefined ? undefined : input.claudeModelsFallback.join(','),
      ],
    ];
    for (const [key, value] of entries) {
      if (value !== undefined && value !== '') await this.write(key, value);
    }
    // Email-verify fields may be cleared (blank host = no proxy), so '' is written
    // too; only the write-only proxy password keeps the "blank = unchanged" rule.
    const clearable: Array<[string, string | undefined]> = [
      // '' = follow the sub-agent model
      [KEY_QUALITY_MODEL, input.qualityModel],
      [KEY_LEARNING_MODEL, input.learningModel],
      [
        KEY_EMAIL_VERIFY_ENABLED,
        input.emailVerifyEnabled === undefined ? undefined : String(input.emailVerifyEnabled),
      ],
      [KEY_EMAIL_PROXY_HOST, input.emailVerifyProxyHost?.trim()],
      [
        KEY_EMAIL_PROXY_PORT,
        input.emailVerifyProxyPort === undefined ? undefined : String(input.emailVerifyProxyPort ?? ''),
      ],
      [KEY_EMAIL_PROXY_USERNAME, input.emailVerifyProxyUsername?.trim()],
      [KEY_EMAIL_FROM_EMAIL, input.emailVerifyFromEmail?.trim()],
      [KEY_EMAIL_HELLO_NAME, input.emailVerifyHelloName?.trim()],
    ];
    for (const [key, value] of clearable) {
      if (value !== undefined) await this.write(key, value);
    }
    if (input.emailVerifyProxyPassword) {
      await this.write(KEY_EMAIL_PROXY_PASSWORD, input.emailVerifyProxyPassword);
    }
  }
}

export const settings = new SettingsStore();

/** Encrypt a secret for storage outside the Setting table (e.g. the WeChat bot token). */
export function sealSecret(plain: string): string {
  const { value, encrypted } = encrypt(plain);
  return encrypted ? `enc:${value}` : plain;
}

/** Reverse of sealSecret (plain values pass through unchanged). */
export function openSecret(stored: string): string {
  return stored.startsWith('enc:') ? decrypt(stored.slice(4)) : stored;
}

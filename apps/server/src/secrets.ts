import crypto from 'node:crypto';
import type { PublicSettingsDTO, UpdateSettingsInput } from '@chapi/shared';
import { config } from './config.js';
import { prisma } from './db/client.js';
import { createLogger } from './logger.js';

const log = createLogger('secrets');

const KEY_OPENAI = 'openai_key';
const KEY_ANTHROPIC = 'anthropic_key';
const KEY_GOOGLE_ID = 'google_oauth_client_id';
const KEY_GOOGLE_SECRET = 'google_oauth_client_secret';
const KEY_MAIN_MODEL = 'main_model';
const KEY_SUBAGENT_MODEL = 'subagent_model';
const KEY_EMBEDDING_MODEL = 'embedding_model';
const KEY_CANVA_ENABLED = 'canva_enabled';

const SECRET_KEYS = new Set([KEY_OPENAI, KEY_ANTHROPIC, KEY_GOOGLE_ID, KEY_GOOGLE_SECRET]);

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

  async getModels(): Promise<{ main: string; subagent: string; embedding: string }> {
    return {
      main: (await this.readRaw(KEY_MAIN_MODEL)) || config.mainModel,
      subagent: (await this.readRaw(KEY_SUBAGENT_MODEL)) || config.subagentModel,
      embedding: (await this.readRaw(KEY_EMBEDDING_MODEL)) || config.embeddingModel,
    };
  }

  async getCanvaEnabled(): Promise<boolean> {
    return (await this.readRaw(KEY_CANVA_ENABLED)) === 'true';
  }

  async getPublic(): Promise<PublicSettingsDTO> {
    const models = await this.getModels();
    const google = await this.getGoogleOAuth();
    return {
      mainModel: models.main,
      subagentModel: models.subagent,
      embeddingModel: models.embedding,
      hasOpenAiKey: Boolean(await this.getOpenAiKey()),
      hasAnthropicKey: Boolean(await this.getAnthropicKey()),
      hasGoogleOAuth: Boolean(google.clientId && google.clientSecret),
      canvaEnabled: await this.getCanvaEnabled(),
    };
  }

  async update(input: UpdateSettingsInput): Promise<void> {
    const entries: Array<[string, string | undefined]> = [
      [KEY_OPENAI, input.openAiKey],
      [KEY_ANTHROPIC, input.anthropicKey],
      [KEY_GOOGLE_ID, input.googleOAuthClientId],
      [KEY_GOOGLE_SECRET, input.googleOAuthClientSecret],
      [KEY_MAIN_MODEL, input.mainModel],
      [KEY_SUBAGENT_MODEL, input.subagentModel],
      [KEY_EMBEDDING_MODEL, input.embeddingModel],
      [
        KEY_CANVA_ENABLED,
        input.canvaEnabled === undefined ? undefined : String(input.canvaEnabled),
      ],
    ];
    for (const [key, value] of entries) {
      if (value !== undefined && value !== '') await this.write(key, value);
    }
  }
}

export const settings = new SettingsStore();

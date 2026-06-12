import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url)); // apps/server/src
export const REPO_ROOT = path.resolve(here, '../../..');

// Load .env from repo root (if present).
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  SERVER_PORT: z.coerce.number().default(8123),
  WEB_PORT: z.coerce.number().default(3100),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().default('mysql://chapi:chapi@127.0.0.1:3307/chapi'),
  SECRETS_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  MAIN_MODEL: z.string().default('claude-opus-4-8'),
  SUBAGENT_MODEL: z.string().default('claude-sonnet-4-6'),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  WORKSPACES_DIR: z.string().default('./workspaces'),
  SESSIONS_DIR: z.string().default('./sessions'),
  DATA_DIR: z.string().default('./data'),
  CLOAKBROWSER_CDP_PORT: z.coerce.number().default(9222),
  CLOAKBROWSER_PROFILE_DIR: z.string().default('./.browser-profile'),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
});

const env = envSchema.parse(process.env);

function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

export const config = {
  env: env.NODE_ENV,
  isDev: env.NODE_ENV !== 'production',
  serverPort: env.SERVER_PORT,
  webPort: env.WEB_PORT,
  host: env.HOST,
  databaseUrl: env.DATABASE_URL,
  secretsKey: env.SECRETS_KEY,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  mainModel: env.MAIN_MODEL,
  subagentModel: env.SUBAGENT_MODEL,
  openAiApiKey: env.OPENAI_API_KEY,
  embeddingModel: env.EMBEDDING_MODEL,
  cloakbrowserCdpPort: env.CLOAKBROWSER_CDP_PORT,
  cloakbrowserProfileDir: abs(env.CLOAKBROWSER_PROFILE_DIR),
  googleOAuthClientId: env.GOOGLE_OAUTH_CLIENT_ID,
  googleOAuthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
  paths: {
    repoRoot: REPO_ROOT,
    workspaces: abs(env.WORKSPACES_DIR),
    rawMaterials: path.join(abs(env.WORKSPACES_DIR), 'raw-materials'),
    skills: path.join(abs(env.WORKSPACES_DIR), 'skills'),
    aiWiki: path.join(abs(env.WORKSPACES_DIR), 'ai-wiki'),
    sessions: abs(env.SESSIONS_DIR),
    data: abs(env.DATA_DIR),
    lancedb: path.join(abs(env.DATA_DIR), 'lancedb'),
    uploads: path.join(abs(env.DATA_DIR), 'uploads'),
  },
} as const;

export type AppConfig = typeof config;

/** Resolve the private workspace directories for a session. */
export function sessionPaths(sessionId: string) {
  const root = path.join(config.paths.sessions, sessionId);
  return {
    root,
    memory: path.join(root, 'memory'),
    sandbox: path.join(root, 'sandbox'),
  };
}

/** Ensure the shared + base runtime directories exist. */
export function ensureBaseDirs(): void {
  for (const dir of [
    config.paths.workspaces,
    config.paths.rawMaterials,
    config.paths.skills,
    config.paths.aiWiki,
    config.paths.sessions,
    config.paths.data,
    config.paths.lancedb,
    config.paths.uploads,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

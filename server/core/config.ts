import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  dataDir: path.resolve(env.VECTOR_DATA_DIR ?? './data'),
  isProd: env.NODE_ENV === 'production',
  /** Model used by every agent. */
  model: env.VECTOR_MODEL ?? 'claude-fable-5-2',
  effort: (env.VECTOR_EFFORT ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  /** Scripted offline model for demos and tests; no API calls are made. */
  mockLlm: env.VECTOR_MOCK_LLM === '1',
  /** Server-side refusal fallback + compaction betas; set to 0 if your account rejects them. */
  useFallbacks: env.VECTOR_FALLBACKS !== '0',
  useCompaction: env.VECTOR_COMPACTION !== '0',
  /** Path to a Chromium binary for the browser agent. Empty = Playwright's default lookup. */
  chromiumPath: env.VECTOR_CHROMIUM_PATH ?? '',
  /** Hard cap on browser-agent steps per run. */
  handoffMaxSteps: Number(env.VECTOR_HANDOFF_MAX_STEPS ?? 40),
  /** Allow sign-ups. Turn off after creating your account on a public deployment. */
  allowSignup: env.VECTOR_ALLOW_SIGNUP !== '0',
  /** Public origin (scheme://host[:port]) used for Origin checks. Empty = same-host check. */
  publicOrigin: env.VECTOR_PUBLIC_ORIGIN ?? '',
};

export function hasLlmCredentials(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
}

export function ensureDataDir(): string {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(config.dataDir, 'shots'), { recursive: true, mode: 0o700 });
  return config.dataDir;
}

let cachedMasterKey: Buffer | null = null;

/**
 * 32-byte master key that wraps every vault entry. Taken from VECTOR_MASTER_KEY (base64) when set,
 * otherwise generated once into <dataDir>/master.key with 0600 permissions.
 * Keep it out of backups of the database: the database alone is useless without it.
 */
export function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  if (env.VECTOR_MASTER_KEY) {
    const key = Buffer.from(env.VECTOR_MASTER_KEY, 'base64');
    if (key.length !== 32) throw new Error('VECTOR_MASTER_KEY must be 32 bytes, base64 encoded');
    return (cachedMasterKey = key);
  }
  const file = path.join(ensureDataDir(), 'master.key');
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${file} is corrupt (expected 32 bytes)`);
  return (cachedMasterKey = key);
}

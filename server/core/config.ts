import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const env = process.env;

/** Which model API the agents talk to. */
export type Provider = 'anthropic' | 'gemini' | 'groq' | 'openai-compatible';

const PROVIDER_DEFAULTS: Record<Exclude<Provider, 'anthropic'>, { baseUrl: string; model: string; keyEnv: string }> = {
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', keyEnv: 'GEMINI_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', keyEnv: 'GROQ_API_KEY' },
  // Any server that speaks the OpenAI chat-completions API (Ollama, OpenRouter, LM Studio…).
  'openai-compatible': { baseUrl: env.VECTOR_OPENAI_BASE_URL ?? '', model: '', keyEnv: 'VECTOR_OPENAI_API_KEY' },
};

/** VECTOR_PROVIDER wins; otherwise the first provider whose key is set, Claude first. */
function pickProvider(): Provider {
  const explicit = env.VECTOR_PROVIDER as Provider | undefined;
  if (explicit) {
    if (explicit !== 'anthropic' && !(explicit in PROVIDER_DEFAULTS)) throw new Error(`Unknown VECTOR_PROVIDER "${explicit}". Use anthropic, gemini, groq or openai-compatible.`);
    return explicit;
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return 'anthropic';
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.GROQ_API_KEY) return 'groq';
  if (env.VECTOR_OPENAI_BASE_URL) return 'openai-compatible';
  return 'anthropic';
}
const provider = pickProvider();
const compat = provider === 'anthropic' ? null : PROVIDER_DEFAULTS[provider];

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  dataDir: path.resolve(env.VECTOR_DATA_DIR ?? './data'),
  isProd: env.NODE_ENV === 'production',
  provider,
  /** Model used by every agent. */
  model: env.VECTOR_MODEL ?? (compat ? compat.model : 'claude-fable-5-2'),
  /** Base URL and key of the OpenAI-compatible endpoint (unused with Claude). */
  compatBaseUrl: (compat?.baseUrl ?? '').replace(/\/+$/, ''),
  compatApiKey: compat ? (env[compat.keyEnv] ?? '') : '',
  compatKeyEnv: compat?.keyEnv ?? '',
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
  /**
   * Mark the session cookie Secure. True when the public origin is https. A phone reaching the
   * server over plain http on home Wi-Fi needs this off, or the browser drops the cookie.
   */
  secureCookies: (env.VECTOR_PUBLIC_ORIGIN ?? '').startsWith('https://'),
  /** Set to 1 when running behind a reverse proxy, so client IPs come from X-Forwarded-For. */
  trustProxy: env.VECTOR_TRUST_PROXY === '1',
};

export function hasLlmCredentials(): boolean {
  if (config.provider === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
  // A local OpenAI-compatible server (Ollama) needs no key, only an address and a model name.
  if (config.provider === 'openai-compatible') return Boolean(config.compatBaseUrl && config.model);
  return Boolean(config.compatApiKey);
}

/** What to tell the operator when no credentials are configured. */
export function credentialsHint(): string {
  if (config.provider === 'anthropic') return 'Set ANTHROPIC_API_KEY (Claude), GEMINI_API_KEY or GROQ_API_KEY and restart.';
  if (config.provider === 'openai-compatible') return 'Set VECTOR_OPENAI_BASE_URL and VECTOR_MODEL and restart.';
  return `Set ${config.compatKeyEnv} and restart.`;
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

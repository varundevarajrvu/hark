import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../core/config.ts';
import { audit, sessions, users } from '../core/db.ts';
import type { Id, User } from '../../shared/types.ts';
import { HttpError, parse } from './errors.ts';
import type { StreamRegistry } from './sse.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireUser` on every authenticated route. */
    user: User;
    sessionHash: string;
  }
}

// ───────────────────────── passwords ─────────────────────────

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200; // bounds the work one request can ask of scrypt
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

function derive(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$N$r$p$<salt b64>$<key b64>. Self-describing so the cost can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

let dummyHash: Promise<string> | null = null;

/**
 * Constant-shape check: when `stored` is missing or unreadable a real hash is still computed against a
 * throwaway value, so the response time does not reveal whether the account exists.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = stored ? parseHash(stored) : null;
  if (!parsed) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    const d = parseHash(await dummyHash)!;
    await derive(password, d.salt, d.N, d.r, d.p, d.key.length);
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

function parseHash(stored: string): { N: number; r: number; p: number; salt: Buffer; key: Buffer } | null {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return null;
  const out = { N: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(salt, 'base64'), key: Buffer.from(key, 'base64') };
  const sane = Number.isInteger(out.N) && out.N >= 1 << 14 && out.N <= 1 << 20 && (out.N & (out.N - 1)) === 0
    && Number.isInteger(out.r) && out.r >= 1 && out.r <= 32 && Number.isInteger(out.p) && out.p >= 1 && out.p <= 16
    && out.salt.length >= 8 && out.key.length >= 16 && out.key.length <= 128;
  return sane ? out : null;
}

// ───────────────────────── sessions ─────────────────────────

export const SESSION_COOKIE = 'vector_session';
const SESSION_TTL_S = 30 * 24 * 60 * 60;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function startSession(reply: FastifyReply, userId: Id): void {
  const token = randomBytes(32).toString('base64url');
  sessions.create(hashToken(token), userId, new Date(Date.now() + SESSION_TTL_S * 1000));
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', path: '/', secure: config.secureCookies, maxAge: SESSION_TTL_S,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/', secure: config.secureCookies });
}

/** onRequest hook for every authenticated route. */
export async function requireUser(req: FastifyRequest): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token && token.length <= 128) {
    const hash = hashToken(token);
    const userId = sessions.resolve(hash);
    const user = userId ? users.get(userId) : null;
    if (user) {
      req.user = user;
      req.sessionHash = hash;
      return;
    }
  }
  throw new HttpError(401, 'Please sign in.');
}

// ───────────────────────── routes ─────────────────────────

const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address.'));
const signupBody = z.object({
  email,
  name: z.string().trim().min(1, 'Enter your name.').max(200),
  password: z.string()
    .min(MIN_PASSWORD_LENGTH, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(MAX_PASSWORD_LENGTH, `Use a password of at most ${MAX_PASSWORD_LENGTH} characters.`),
});
const loginBody = z.object({ email: z.string().trim().max(254), password: z.string().max(MAX_PASSWORD_LENGTH) });

/** About 10 attempts a minute per IP on anything that checks or sets a password. */
export const AUTH_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const BAD_LOGIN = 'Wrong email or password.';

/** /auth/signup and /auth/login: the only routes that work without a session. */
export function publicAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/signup', { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    if (!config.allowSignup) throw new HttpError(403, 'Sign-ups are turned off on this server.');
    const body = parse(signupBody, req.body);
    if (users.getAuthByEmail(body.email)) throw new HttpError(409, 'An account with that email already exists.');
    const passwordHash = await hashPassword(body.password);
    let user: User;
    try {
      user = users.create({ email: body.email, name: body.name, passwordHash });
    } catch (err) {
      // Two sign-ups for the same address raced past the check above.
      if (/UNIQUE/i.test((err as Error).message)) throw new HttpError(409, 'An account with that email already exists.');
      throw err;
    }
    audit(user.id, 'auth.signup');
    startSession(reply, user.id);
    return { user };
  });

  app.post('/auth/login', { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const found = users.getAuthByEmail(body.email);
    const ok = await verifyPassword(body.password, found?.passwordHash ?? null);
    if (!found || !ok) {
      if (found) audit(found.user.id, 'auth.login_failed');
      throw new HttpError(401, BAD_LOGIN);
    }
    audit(found.user.id, 'auth.login');
    startSession(reply, found.user.id);
    return { user: found.user };
  });
}

export function sessionAuthRoutes(app: FastifyInstance, ctx: { streams: StreamRegistry }): void {
  app.post('/auth/logout', async (req, reply) => {
    sessions.delete(req.sessionHash);
    audit(req.user.id, 'auth.logout');
    clearSessionCookie(reply);
    // The cookie is gone but an EventSource opened with it would keep streaming; end it.
    ctx.streams.closeFor(req.user.id);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => ({ user: req.user }));
}

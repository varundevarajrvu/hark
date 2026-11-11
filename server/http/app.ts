import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController } from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from '../core/config.ts';
import { publicAuthRoutes, requireUser, sessionAuthRoutes } from './auth.ts';
import type { AppContext, AppDeps } from './context.ts';
import { HttpError } from './errors.ts';
import { accountRoutes } from './routes/account.ts';
import { chatRoutes } from './routes/chat.ts';
import { homeRoutes } from './routes/home.ts';
import { createStreamRegistry } from './sse.ts';

export type { AppDeps } from './context.ts';

const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    // Fastify's own request logging is off; one concise line per API response is written below.
    // Neither includes headers (cookies) or bodies.
    logger: process.env.VITEST ? false : { level: 'info' },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
  });
  const ctx: AppContext = { ...deps, streams: createStreamRegistry() };

  await app.register(cookie);
  await app.register(rateLimit, { global: false }); // only routes that opt in (auth) are limited

  // JSON bodies, tolerating an empty one (a bodyless POST sent with a JSON content type).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = body as string;
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, 'The request body is not valid JSON.'));
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', APP_CSP); // the panel frame route replaces this

    // CSRF. The session cookie is SameSite=Strict; this is the second line of defence.
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin, req.headers.host)) {
      throw new HttpError(403, 'Cross-origin requests are not allowed.');
    }
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new HttpError(403, 'Send request bodies as application/json.');
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    req.log.info(`${req.method} ${req.url.split('?')[0]} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
  });

  app.addHook('onClose', async () => ctx.streams.closeAll());

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: err.message });
    req.log.error({ err: { name: err.name, message: err.message, stack: err.stack } }, 'request failed');
    return reply.code(500).send({ error: 'Something went wrong on the server.' });
  });

  await app.register(async (api) => {
    publicAuthRoutes(api);
    // Everything registered in this inner scope requires a session.
    await api.register(async (authed) => {
      authed.decorateRequest('user');
      authed.decorateRequest('sessionHash', '');
      authed.addHook('onRequest', requireUser);
      sessionAuthRoutes(authed, ctx);
      chatRoutes(authed, ctx);
      homeRoutes(authed, ctx);
      accountRoutes(authed, ctx);
    });
  }, { prefix: '/api' });

  const hasWeb = existsSync(path.join(WEB_DIST, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      setHeaders(reply, file) {
        // Vite fingerprints everything under assets/; index.html must always be revalidated.
        reply.header('cache-control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url === '/api' || req.url.startsWith('/api/');
    if (hasWeb && !isApi && req.method === 'GET') return reply.sendFile('index.html'); // client-side routes
    return reply.code(404).send({ error: 'Not found.' });
  });

  return app;
}

/** True when `origin` is this server: the configured public origin, or the Host the request was sent to. */
function originAllowed(origin: string, host: string | undefined): boolean {
  if (config.publicOrigin && origin === config.publicOrigin.replace(/\/+$/, '')) return true;
  try {
    if (host === undefined) return false;
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // Parse Host the same way so a default port (":80", ":443") compares equal to its absence.
    return url.host === new URL(`${url.protocol}//${host}`).host;
  } catch {
    return false; // "null" (sandboxed frames, e.g. a panel) and garbage
  }
}

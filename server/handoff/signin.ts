import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { config } from '../core/config.ts';
import { BrowserUnavailableError, launchPersistentBrowser } from './browser.ts';
import { ensureProfileDir, lockProfile } from './profile.ts';

/**
 * `npm run browser -- <email> [url]`: open a user's Vector browser profile in a visible window on
 * this computer, so they can sign in to sites themselves (passwords, 2FA, captchas). No model and no
 * automation beyond launching the window; no guard proxy either, since this is the user browsing as
 * themselves. Vector's browser agent then uses the same profile and is signed in where they are.
 */

const USAGE = `Usage: npm run browser -- <your Vector account email> [url]

Opens your Vector browser in a window on this computer so you can sign in to sites yourself.
Vector's browser agent stays signed in there afterwards.
Example: npm run browser -- you@example.com https://mail.google.com`;

/**
 * Read-only lookup. It deliberately does not go through core/db.ts: opening the database there runs
 * the start-up recovery (pending approvals expired, running browser runs marked failed), which would
 * break the server that is running alongside this command.
 */
async function findUserId(email: string): Promise<string | null> {
  const file = path.join(config.dataDir, 'vector.db');
  if (!existsSync(file)) return null;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (!/SQLite is an experimental feature/.test(String(warning))) (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id?: unknown } | undefined;
    return typeof row?.id === 'string' ? row.id : null;
  } finally {
    db.close();
  }
}

function parseUrl(raw: string): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Resolves when the user has closed the window (or every tab in it), or on Ctrl+C. */
function untilClosed(context: BrowserContext): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    context.on('close', finish);
    // On macOS the browser keeps running with no windows: treat "no tabs left" as closed too.
    const watch = (p: Page) => p.on('close', () => setTimeout(() => context.pages().length === 0 && finish(), 500));
    context.pages().forEach(watch);
    context.on('page', watch);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, finish);
  });
}

async function main(argv: string[]): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  if (args.length === 0 || args.length > 2 || args[0] === '-h' || args[0] === '--help') {
    console.log(USAGE);
    return args[0] === '-h' || args[0] === '--help' ? 0 : 2;
  }
  const [email, rawUrl] = args as [string, string | undefined];
  const url = rawUrl ? parseUrl(rawUrl) : null;
  if (rawUrl && !url) {
    console.error(`That is not a web address: ${rawUrl}\n\n${USAGE}`);
    return 2;
  }

  let userId: string | null;
  try {
    userId = await findUserId(email);
  } catch (err) {
    console.error(`Could not read Vector's database in ${config.dataDir}: ${String((err as Error)?.message ?? err).split('\n')[0]}`);
    return 1;
  }
  if (!userId) {
    console.error(`No account with that email.\n\n${USAGE}`);
    return 1;
  }

  const dir = ensureProfileDir(userId);
  const lock = lockProfile(userId, 'signin');
  if ('heldBy' in lock) {
    const why = {
      server: 'Vector is using this browser right now (a browser task is running). Wait for it to finish, or stop it in the app, then run this again.',
      signin: 'This browser is already open in another sign-in window. Use that window, or close it first.',
      browser: 'This browser profile is already open in another browser window. Close it, then run this again.',
    }[lock.heldBy.by];
    console.error(why);
    return 1;
  }

  let context: BrowserContext;
  try {
    context = await launchPersistentBrowser(dir, {
      headless: false,
      viewport: null, // a normal, resizable window
      ignoreDefaultArgs: ['--enable-automation'], // no "controlled by automated test software" bar: the user drives this window
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, // closed gracefully below, so cookies are saved
    });
  } catch (err) {
    lock.release();
    const msg = String((err as Error)?.message ?? err);
    if (err instanceof BrowserUnavailableError) console.error(msg);
    else if (/ProcessSingleton|already in use/i.test(msg)) console.error('This browser profile is already open in another browser window. Close it, then run this again.');
    else if (/display|DISPLAY|headed browser|XServer/i.test(msg)) console.error('Could not open a browser window: this computer has no screen to show it on. Run this on the computer where you can see the desktop.');
    else console.error(`Could not open the browser: ${msg.split('\n')[0]}`);
    return 1;
  }

  try {
    const closed = untilClosed(context); // from here on, Ctrl+C closes the window gracefully
    const page = context.pages()[0] ?? (await context.newPage());
    console.log('A browser window is open. Sign in to the sites you want Vector to use, then close the window.');
    if (url) {
      void page.goto(url, { waitUntil: 'commit', timeout: 60_000 }).catch((err) => {
        if (context.pages().length > 0) console.error(`Could not open ${url}: ${String(err?.message ?? err).split('\n')[0]}`);
      });
    }
    await closed;
  } finally {
    await context.close().catch(() => {});
    lock.release();
  }
  console.log('Saved. Vector’s browser agent is now signed in wherever you signed in.');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

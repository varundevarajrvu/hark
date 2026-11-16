import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright-core';
import { config } from '../core/config.ts';

/**
 * Finding and launching a browser, shared by the browser agent and `npm run browser` (signin.ts), so
 * both open a profile with the same browser. Order:
 *  1. VECTOR_CHROMIUM_PATH (config.chromiumPath), when set: that binary and nothing else;
 *  2. VECTOR_BROWSER_CHANNEL, when set: that Playwright channel and nothing else;
 *  3. otherwise the first that works of Playwright's own Chromium (if installed), then an installed
 *     Google Chrome, then Microsoft Edge (present on every Windows machine), so no download is needed.
 * The first choice that launches is cached for the process.
 */

const REMEDY =
  'To fix this, install Google Chrome or Microsoft Edge, or run `npx playwright-core install chromium`, or set VECTOR_CHROMIUM_PATH to a Chrome or Chromium executable.';

export class BrowserUnavailableError extends Error {
  override name = 'BrowserUnavailableError';
}

interface Choice {
  label: string;
  opts: { executablePath?: string; channel?: string };
  /** Skip without trying when this returns false (cheap presence check). */
  present?: () => boolean;
}

/** Errors that mean "this browser is not installed", as opposed to a browser that failed to run. */
const NOT_INSTALLED = /Unsupported chromium channel|is not found at|Executable doesn't exist|ENOENT|no such file/i;

function plan(): { key: string; forced: boolean; choices: Choice[] } {
  const path = config.chromiumPath.trim();
  if (path) return { key: `path:${path}`, forced: true, choices: [{ label: `the browser at VECTOR_CHROMIUM_PATH (${path})`, opts: { executablePath: path } }] };
  const channel = (process.env.VECTOR_BROWSER_CHANNEL ?? '').trim();
  if (channel) return { key: `channel:${channel}`, forced: true, choices: [{ label: `browser channel "${channel}" (VECTOR_BROWSER_CHANNEL)`, opts: { channel } }] };
  return {
    key: 'auto',
    forced: false,
    choices: [
      // channel 'chromium' = Playwright's full Chromium build (also in headless mode), so the agent and
      // the visible sign-in window use the very same binary on one profile.
      { label: 'Playwright’s Chromium', opts: { channel: 'chromium' }, present: () => safeExists(chromium.executablePath()) },
      { label: 'Google Chrome', opts: { channel: 'chrome' } },
      { label: 'Microsoft Edge', opts: { channel: 'msedge' } },
    ],
  };
}

function safeExists(p: string): boolean {
  try {
    return Boolean(p) && existsSync(p);
  } catch {
    return false;
  }
}

const firstLine = (err: unknown) =>
  String((err as Error)?.message ?? err).split('\n')[0]!.replace(/^browserType\.\w+:\s*/, '').slice(0, 240);

let cached: { key: string; choice: Choice } | null = null;

/** Which browser this process launches, once one has launched (for logs and tests). */
export function browserChoice(): string | null {
  return cached && cached.key === plan().key ? cached.choice.label : null;
}

/** Forget the cached choice (tests). */
export function resetBrowserChoice(): void {
  cached = null;
}

async function withBrowser<T>(launch: (opts: Choice['opts']) => Promise<T>): Promise<T> {
  const { key, forced, choices } = plan();
  if (cached && cached.key === key) {
    try {
      return await launch(cached.choice.opts);
    } catch (err) {
      if (!NOT_INSTALLED.test(String((err as Error)?.message))) throw err;
      const label = cached.choice.label;
      cached = null; // it was uninstalled or moved: probe again next time
      throw new BrowserUnavailableError(`Could not start ${label}: ${firstLine(err)}. ${REMEDY}`);
    }
  }
  const tried: string[] = [];
  for (const choice of choices) {
    if (choice.present && !choice.present()) {
      tried.push(`${choice.label} is not installed`);
      continue;
    }
    try {
      const out = await launch(choice.opts);
      cached = { key, choice };
      return out;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (forced) throw new BrowserUnavailableError(`Could not start ${choice.label}: ${firstLine(err)}. ${REMEDY}`);
      // A browser that is installed but failed for another reason (a locked profile, a crash) is not
      // a reason to silently switch to a different browser.
      if (!NOT_INSTALLED.test(msg)) throw err;
      tried.push(`${choice.label} was not found`);
    }
  }
  throw new BrowserUnavailableError(`No browser found (${tried.join('; ')}). ${REMEDY}`);
}

/** A throwaway browser (fresh mode). */
export function launchBrowser(opts: LaunchOptions): Promise<Browser> {
  return withBrowser((choice) => chromium.launch({ ...opts, ...choice }));
}

/** A browser on a persistent profile directory; closing the returned context closes the browser. */
export function launchPersistentBrowser(userDataDir: string, opts: LaunchOptions & BrowserContextOptions): Promise<BrowserContext> {
  return withBrowser((choice) => chromium.launchPersistentContext(userDataDir, { ...opts, ...choice }));
}

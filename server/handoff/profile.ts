import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../core/config.ts';
import type { Id } from '../../shared/types.ts';

/**
 * Per-user persistent browser profiles: <dataDir>/profiles/<userId>, mode 0700. Sign in to a site
 * once (with `npm run browser`, or through the agent with a vault login) and later runs are signed in.
 *
 * A Chromium profile can be open in only one browser at a time, so access is serialised:
 *  - within this process, a per-user queue: a second run of the same user waits its turn (bounded);
 *  - across processes (the server vs. `npm run browser`), a lock file <profiles>/<userId>.lock holding
 *    the owner's pid, created with O_EXCL; a lock whose pid is gone is stale and taken over;
 *  - and Chromium's own profile lock (SingletonLock / lockfile) is checked as well, for a profile left
 *    open by some other browser window.
 *
 * VECTOR_BROWSER_PROFILE=fresh turns all of this off: every run gets a throwaway browser.
 */

export type ProfileMode = 'persistent' | 'fresh';

export function profileMode(): ProfileMode {
  return process.env.VECTOR_BROWSER_PROFILE === 'fresh' ? 'fresh' : 'persistent';
}

export function profilesRoot(): string {
  return path.resolve(config.dataDir, 'profiles');
}

/** The profile directory of a user, after checking that it really is one directory inside the root. */
export function profileDir(userId: Id): string {
  const root = profilesRoot();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(userId)) throw new Error('invalid user id for a browser profile');
  const dir = path.resolve(root, userId);
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) throw new Error('browser profile path escapes the profiles directory');
  return dir;
}

export function ensureProfileDir(userId: Id): string {
  const root = profilesRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = profileDir(userId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
    chmodSync(dir, 0o700);
  } catch {
    /* not supported on this filesystem (Windows) */
  }
  return dir;
}

// ───────────────────────── cross-process lock ─────────────────────────

export type LockRole = 'server' | 'signin';
export type LockHolder = { by: LockRole | 'browser'; pid: number };

function lockFile(userId: Id): string {
  profileDir(userId); // validates the id
  return path.join(profilesRoot(), `${userId}.lock`);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is Chromium itself holding this profile (some browser window has it open)? */
export function chromiumHolder(dir: string): LockHolder | null {
  try {
    // Linux and macOS: a symlink SingletonLock -> "<hostname>-<pid>".
    const m = /^(.*)-(\d+)$/.exec(readlinkSync(path.join(dir, 'SingletonLock')));
    if (m) {
      const pid = Number(m[2]);
      if (m[1] !== os.hostname() || pidAlive(pid)) return { by: 'browser', pid };
    }
  } catch {
    /* no lock */
  }
  if (process.platform === 'win32') {
    // Windows: "lockfile" is held open (and deleted on close) by the running browser.
    const f = path.join(dir, 'lockfile');
    if (existsSync(f)) {
      try {
        rmSync(f);
      } catch {
        return { by: 'browser', pid: 0 };
      }
    }
  }
  return null;
}

/** Who holds the profile of `userId` right now, if anyone (another process, or a browser window). */
export function profileHolder(userId: Id): LockHolder | null {
  const file = lockFile(userId);
  try {
    const held = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; role: LockRole };
    if (pidAlive(held.pid)) return { by: held.role, pid: held.pid };
  } catch {
    /* no lock file, or unreadable: treat as free */
  }
  const dir = profileDir(userId);
  return existsSync(dir) ? chromiumHolder(dir) : null;
}

/**
 * Take the cross-process lock for a user's profile. Returns a release function, or who holds it.
 * Callers in this process must hold the in-process queue first (see `waitForProfile`).
 */
export function lockProfile(userId: Id, role: LockRole): { release: () => void } | { heldBy: LockHolder } {
  ensureProfileDir(userId);
  const file = lockFile(userId);
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let held: { pid: number; role: LockRole } | null = null;
      try {
        held = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        /* half-written or corrupt: stale */
      }
      if (held && held.pid !== process.pid && pidAlive(held.pid)) return { heldBy: { by: held.role, pid: held.pid } };
      rmSync(file, { force: true }); // stale: its process is gone (or it is ours from an earlier run)
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, role, at: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    const browser = chromiumHolder(profileDir(userId));
    if (browser) {
      rmSync(file, { force: true });
      return { heldBy: browser };
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        try {
          const held = JSON.parse(readFileSync(file, 'utf8')) as { pid: number };
          if (held.pid === process.pid) rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      },
    };
  }
  return { heldBy: { by: 'browser', pid: 0 } };
}

// ───────────────────────── in-process queue ─────────────────────────

/** userId → resolvers of runs waiting for the profile. Presence of the key means it is in use. */
const queues = new Map<Id, Array<() => void>>();

export type Wait = { release: () => void } | { timedOut: true } | { aborted: true };

/**
 * Wait for this process's turn on a user's profile: runs of one user go one at a time, in order.
 * `onQueued` is called once if the caller has to wait.
 */
export function waitForProfile(userId: Id, opts: { signal?: AbortSignal; timeoutMs: number; onQueued?: () => void }): Promise<Wait> {
  const makeRelease = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const q = queues.get(userId);
      const next = q?.shift();
      if (next) next(); // hand over directly to the next in line
      else queues.delete(userId);
    };
  };
  if (opts.signal?.aborted) return Promise.resolve({ aborted: true });
  const q = queues.get(userId);
  if (!q) {
    queues.set(userId, []);
    return Promise.resolve({ release: makeRelease() });
  }
  opts.onQueued?.();
  return new Promise<Wait>((resolve) => {
    const turn = () => {
      cleanup();
      resolve({ release: makeRelease() });
    };
    const leave = (out: Wait) => {
      cleanup();
      const i = q.indexOf(turn);
      if (i >= 0) q.splice(i, 1);
      resolve(out);
    };
    const onAbort = () => leave({ aborted: true });
    const timer = setTimeout(() => leave({ timedOut: true }), opts.timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    q.push(turn);
  });
}

/** True while a run in this process has the user's profile. */
export function profileBusy(userId: Id): boolean {
  return queues.has(userId);
}

/**
 * Remove a user's browser profile (account deletion). Waits briefly for a run that is still closing
 * its browser, then deletes the directory, after confirming it is inside the profiles root.
 */
export async function deleteBrowserProfile(userId: Id): Promise<void> {
  const root = profilesRoot();
  const dir = profileDir(userId);
  const real = path.resolve(dir);
  if (path.dirname(real) !== root) throw new Error('refusing to delete a browser profile outside the profiles directory');
  const turn = await waitForProfile(userId, { timeoutMs: 30_000 });
  try {
    rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(lockFile(userId), { force: true });
  } finally {
    if ('release' in turn) turn.release();
  }
}

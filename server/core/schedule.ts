import { Cron } from 'croner';

/** Shortest interval a scheduled task may repeat at. */
export const MIN_INTERVAL_MS = 5 * 60_000;

/**
 * Validate a 5-field cron expression in an IANA timezone and return its next run time.
 * Throws an Error with a user-readable message when it is invalid or fires too often.
 */
export function nextRun(cron: string, timezone: string, from: Date = new Date()): Date {
  const expr = cron.trim();
  if (expr.split(/\s+/).length !== 5) throw new Error('Use a 5-field cron expression: minute hour day-of-month month day-of-week.');
  let job: Cron;
  try {
    job = new Cron(expr, { timezone, paused: true });
  } catch (e) {
    throw new Error(`Invalid schedule: ${(e as Error).message}`);
  }
  const [first, second] = job.nextRuns(2, from);
  if (!first) throw new Error('That schedule never fires.');
  if (second && second.getTime() - first.getTime() < MIN_INTERVAL_MS) throw new Error('Scheduled tasks can run at most every 5 minutes.');
  return first;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

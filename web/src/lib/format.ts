/** Dates, times and cron expressions in words. No libraries: Intl only. */

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function timezoneList(): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [];
  }
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

function formatter(options: Intl.DateTimeFormatOptions, timeZone?: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(undefined, { ...options, timeZone });
  } catch {
    return new Intl.DateTimeFormat(undefined, options); // unknown zone: fall back to the browser's
  }
}

export function formatTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return formatter({ hour: '2-digit', minute: '2-digit' }, timeZone).format(date);
}

export function formatDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return formatter({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, timeZone).format(date);
}

export function dayKey(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return formatter({ year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone).format(date);
}

export function formatDay(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = dayKey(new Date().toISOString(), timeZone);
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString(), timeZone);
  const key = dayKey(iso, timeZone);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return formatter({ weekday: 'long', day: 'numeric', month: 'long' }, timeZone).format(date);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "in 3 hours", "5 minutes ago", "now". */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '';
  const diff = at - now;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return diff >= 0 ? 'in under a minute' : 'just now';
}

export function greeting(timeZone?: string): string {
  let hour = new Date().getHours();
  try {
    const part = formatter({ hour: 'numeric', hourCycle: 'h23' }, timeZone)
      .formatToParts(new Date())
      .find((p) => p.type === 'hour');
    if (part) hour = Number(part.value);
  } catch {
    /* keep the local hour */
  }
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// ───────────────────────── Cron in words ─────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ALIASES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const pad = (n: number): string => String(n).padStart(2, '0');

function int(field: string, lo: number, hi: number): number | null {
  if (!/^\d{1,2}$/.test(field)) return null;
  const n = Number(field);
  return n >= lo && n <= hi ? n : null;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function weekday(token: string): number | null {
  const alias = DAY_ALIASES[token.toUpperCase()];
  if (alias !== undefined) return alias;
  const n = int(token, 0, 7);
  return n === null ? null : n % 7;
}

function weekdays(field: string): number[] | null {
  const days = new Set<number>();
  for (const piece of field.split(',')) {
    const range = piece.split('-');
    if (range.length === 1) {
      const d = weekday(range[0] ?? '');
      if (d === null) return null;
      days.add(d);
    } else if (range.length === 2) {
      const from = weekday(range[0] ?? '');
      const rawTo = int(range[1] ?? '', 0, 7) ?? weekday(range[1] ?? '');
      if (from === null || rawTo === null || rawTo < from) return null;
      for (let d = from; d <= rawTo; d++) days.add(d % 7);
    } else return null;
  }
  return [...days].sort((a, b) => a - b);
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * Describes the common shapes of a 5-field cron expression. Returns null for anything it cannot
 * describe with certainty (lists of hours, steps with offsets, month filters…): the caller then
 * shows the raw expression instead of a guess.
 */
export function describeCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [min = '', hour = '', dom = '', month = '', dow = ''] = fields;
  if (month !== '*') return null;
  const anyDay = dom === '*' && dow === '*';

  if (min === '*' && hour === '*' && anyDay) return 'Every minute';
  const minuteStep = /^\*\/(\d{1,2})$/.exec(min);
  if (minuteStep && hour === '*' && anyDay) {
    const n = Number(minuteStep[1]);
    if (n === 1) return 'Every minute';
    return n > 1 && n < 60 && 60 % n === 0 ? `Every ${n} minutes` : null;
  }

  const m = int(min, 0, 59);
  if (m === null) return null;
  if (hour === '*' && anyDay) return m === 0 ? 'Every hour, on the hour' : `Every hour at ${m} minutes past`;
  const hourStep = /^\*\/(\d{1,2})$/.exec(hour);
  if (hourStep && anyDay) {
    const n = Number(hourStep[1]);
    if (n < 2 || n > 12 || 24 % n !== 0) return null;
    return `Every ${n} hours${m === 0 ? '' : ` at ${m} minutes past`}, starting at midnight`;
  }

  const h = int(hour, 0, 23);
  if (h === null) return null;
  const at = `at ${pad(h)}:${pad(m)}`;
  if (anyDay) return `Every day ${at}`;

  if (dom === '*') {
    const days = weekdays(dow);
    if (!days || days.length === 0) return null;
    const key = days.join(',');
    if (days.length === 7) return `Every day ${at}`;
    if (key === '1,2,3,4,5') return `Every weekday ${at}`;
    if (key === '0,6') return `Every Saturday and Sunday ${at}`;
    return `Every ${joinWords(days.map((d) => DAY_NAMES[d] ?? ''))} ${at}`;
  }

  if (dow === '*') {
    const d = int(dom, 1, 31);
    if (d === null) return null;
    const caveat = d > 28 ? ' (skipped in shorter months)' : '';
    return `On the ${ordinal(d)} of every month ${at}${caveat}`;
  }
  return null;
}

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every morning 8:00', cron: '0 8 * * *' },
  { label: 'Weekdays 9:00', cron: '0 9 * * 1-5' },
  { label: 'Every Monday 9:00', cron: '0 9 * * 1' },
  { label: 'First of the month', cron: '0 9 1 * *' },
];

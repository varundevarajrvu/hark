/** Long URLs, shown short: the host in full, the path cut in the middle. The full URL always stays reachable. */

export interface UrlParts {
  host: string;
  path: string;
  query: string;
  secure: boolean;
}

export function urlParts(url: string): UrlParts {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname === '/' ? '' : u.pathname, query: u.search + u.hash, secure: u.protocol === 'https:' };
  } catch {
    return { host: url, path: '', query: '', secure: false };
  }
}

/** Keep the start and the end of a string, drop the middle: "/v3/sign…identifier". */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const keep = max - 1;
  const head = Math.ceil(keep * 0.45);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/**
 * The path that fits in `budget` characters, best first: whole; query folded to "?…"; first and last
 * segments ("/v3/…/identifier?…"); last segment only ("…/identifier?…"); cut in the middle.
 */
export function fitPath(path: string, query: string, budget: number): string {
  if (path.length + query.length <= budget) return path + query;
  if (budget < 8) return path || query ? '/…' : ''; // too little room to say anything useful: the host carries it
  const tail = query ? '?…' : '';
  if (path.length + tail.length <= budget) return path + tail;
  const segments = path.split('/').filter(Boolean);
  const first = segments[0] ?? '';
  const last = segments[segments.length - 1] ?? '';
  if (segments.length > 2) {
    const both = `/${first}/…/${last}${tail}`;
    if (both.length <= budget) return both;
  }
  if (segments.length > 1) {
    const end = `/…/${last}${tail}`;
    if (end.length <= budget) return end;
  }
  return middleEllipsis(path, Math.max(4, budget - tail.length)) + tail;
}

/** "accounts.google.com/v3/…/identifier?…" in about `max` characters, for link text. */
export function shortUrl(url: string, max = 44): string {
  const at = urlParts(url);
  if (!at.host || at.host === url) return middleEllipsis(url, max);
  const host = middleEllipsis(at.host.replace(/^www\./, ''), Math.max(12, max - 8));
  return host + fitPath(at.path, at.query, Math.max(6, max - host.length));
}

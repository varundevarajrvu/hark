import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Network safety for the browser agent. A web page (or the model, if a page talks it into it) must
 * not be able to reach the server's own machine, its private network or a cloud metadata service.
 *
 * Two layers use the same check:
 *  - `context.route` aborts requests to blocked hosts early. Playwright does not call route handlers
 *    for redirect hops, so on its own this is bypassable by a public URL that redirects inward.
 *  - The browser is therefore launched behind `startGuardProxy()`: every connection it makes (pages,
 *    subresources, redirects, WebSockets) is resolved and checked here, and the proxy connects to
 *    the address it checked, which also closes the DNS-rebinding gap.
 */

const blocked = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [
  ['::', 127], // unspecified + loopback
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64: can embed any IPv4 address
  ['2002::', 16], // 6to4, likewise
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(prefix, bits, 'ipv6');

/** True for loopback, private, link-local (incl. 169.254.169.254), CGNAT, multicast and reserved addresses. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return blocked.check(ip, 'ipv4');
  if (kind !== 6) return true;
  const mapped = /^::ffff:(.+)$/i.exec(ip)?.[1];
  if (mapped) {
    if (net.isIP(mapped) === 4) return blocked.check(mapped, 'ipv4');
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped); // ::ffff:7f00:1
    if (!hex) return true;
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4');
  }
  return blocked.check(ip, 'ipv6');
}

export const localAllowed = (): boolean => process.env.VECTOR_HANDOFF_ALLOW_LOCAL === '1';

export type HostCheck = (hostname: string) => Promise<{ address: string; family: 4 | 6 } | null>;

/**
 * Resolve a hostname and return an address that is safe to connect to, or null when the host is
 * local/private (any of its addresses) or cannot be resolved.
 */
export const resolvePublicHost: HostCheck = async (rawHost) => {
  const host = rawHost.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const allowLocal = localAllowed();
  const literal = net.isIP(host);
  if (literal) return !allowLocal && isBlockedAddress(host) ? null : { address: host, family: literal as 4 | 6 };
  if (!allowLocal && (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host) || !host.includes('.'))) return null;
  try {
    const found = await lookup(host, { all: true, verbatim: true });
    if (found.length === 0) return null;
    if (!allowLocal && found.some((a) => isBlockedAddress(a.address))) return null;
    const pick = found.find((a) => a.family === 4) ?? found[0]!;
    return { address: pick.address, family: pick.family as 4 | 6 };
  } catch {
    return null;
  }
};

/** Why the agent may not open this URL, or null when it may. Does not resolve DNS. */
export function urlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That is not a valid URL. Use a full address starting with https://';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `Only http and https pages can be opened (not ${url.protocol}).`;
  if (url.username || url.password) return 'URLs that contain a username or password are not allowed.';
  return null;
}

export const BLOCKED_HEADER = 'x-vector-blocked';

/** A forward proxy on 127.0.0.1 that only connects to hosts `check` approves. One per browser run. */
export async function startGuardProxy(check: HostCheck = resolvePublicHost): Promise<{ url: string; close: () => void }> {
  const sockets = new Set<Duplex>();
  const track = (s: Duplex) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => s.destroy());
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      let target: URL;
      try {
        target = new URL(req.url ?? '');
        if (target.protocol !== 'http:') throw new Error('not http');
      } catch {
        res.writeHead(400).end();
        return;
      }
      const addr = await check(target.hostname);
      if (!addr) {
        res.writeHead(403, { [BLOCKED_HEADER]: '1', 'content-type': 'text/plain' }).end('Blocked: this address is on a private or local network.');
        return;
      }
      const headers = { ...req.headers };
      for (const h of ['proxy-connection', 'proxy-authorization']) delete headers[h];
      const upstream = http.request(
        { host: addr.address, family: addr.family, port: target.port || 80, method: req.method, path: target.pathname + target.search, headers, setHost: false },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => res.destroy());
  });

  // https:// and WebSocket traffic arrives as CONNECT host:port.
  server.on('connect', (req, client: Duplex, head: Buffer) => {
    track(client);
    void (async () => {
      const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
      const addr = m ? await check(m[1]!) : null;
      if (!m || !addr) {
        client.end(`HTTP/1.1 403 Forbidden\r\n${BLOCKED_HEADER}: 1\r\n\r\n`);
        return;
      }
      const upstream = net.connect({ host: addr.address, family: addr.family, port: Number(m[2]) });
      track(upstream);
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    })().catch(() => client.destroy());
  });
  server.on('connection', track);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
}

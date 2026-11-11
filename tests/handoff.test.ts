import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
process.env.VECTOR_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
import { resolveApproval } from '../server/core/approvals.ts';
import { subscribe } from '../server/core/bus.ts';
import { config } from '../server/core/config.ts';
import { approvalRows, handoffRuns, listAudit, resetDbForTests, users } from '../server/core/db.ts';
import { vault } from '../server/core/vault.ts';
import { createOfflineClient, toolUseBlock } from '../server/agent/index.ts';
import type { LlmBlock, LlmClient, LlmRequest } from '../server/agent/index.ts';
import { COMMIT_PATTERN, createHandoffRuntime } from '../server/handoff/index.ts';
import { isBlockedAddress, resolvePublicHost, urlProblem } from '../server/handoff/netguard.ts';
import type { ServerEvent } from '../shared/types.ts';

const CHROMIUM = process.env.VECTOR_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const SECRET = 'pw-Walrus-Tango-4471';
const USERNAME = 'ada.private@x.dev';

describe('network and consent rules (no browser)', () => {
  it('classifies private, loopback, link-local, CGNAT and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'not-an-ip']) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.63.255.255', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('refuses local names and non-web URLs', async () => {
    const saved = process.env.VECTOR_HANDOFF_ALLOW_LOCAL;
    delete process.env.VECTOR_HANDOFF_ALLOW_LOCAL;
    try {
      for (const host of ['localhost', 'LOCALHOST.', 'app.localhost', 'printer.local', 'intranet', '127.0.0.1', '[::1]', '169.254.169.254']) expect(await resolvePublicHost(host), host).toBeNull();
    } finally {
      if (saved !== undefined) process.env.VECTOR_HANDOFF_ALLOW_LOCAL = saved;
    }
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'data:text/html,<p>x', 'javascript:alert(1)', 'https://user:pw@example.com/', 'nonsense']) expect(urlProblem(url), url).toBeTruthy();
    expect(urlProblem('https://example.com/a?b=1')).toBeNull();
  });

  it('matches commit-like labels as whole words', () => {
    for (const label of ['Pay', 'Pay $20 now', 'Place order', 'place your order', 'BUY NOW', 'Complete purchase', 'Confirm order', 'Subscribe', 'Send', 'Submit', 'Post', 'Publish', 'Delete account', 'Cancel subscription', 'Cancel my plan', 'Confirm', 'Sign up', 'Book a table', 'Reserve']) {
      expect(COMMIT_PATTERN.test(label), label).toBe(true);
    }
    for (const label of ['Payment methods', 'Search', 'Next', 'Log in', 'Cancel', 'Add to basket', 'Facebook', 'Postcode', 'Continue']) expect(COMMIT_PATTERN.test(label), label).toBe(false);
  });
});

// ───────────────────────── real browser ─────────────────────────

type Step = LlmBlock[] | ((req: LlmRequest) => LlmBlock[]);

function scripted(steps: Step[]) {
  const seen: any[] = [];
  const client: LlmClient = {
    async runTurn(req) {
      seen.push(JSON.parse(JSON.stringify({ system: req.system, messages: req.messages })));
      const step = steps[seen.length - 1];
      if (!step) throw new Error('script exhausted');
      const content = typeof step === 'function' ? step(req) : step;
      return { content, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, model: 'test-model' };
    },
  };
  /** Text of the tool results the model was given after model call `n` (0-based). */
  const resultsAfter = (n: number): Array<{ content: string; is_error?: boolean }> => seen[n + 1]?.messages.at(-1).content ?? [];
  return { client, seen, resultsAfter };
}

const call = (name: string, input: unknown) => [toolUseBlock(name, input)];
const finish = (result = 'All done.', success = true) => call('finish', { result, success });

/** The ref of the element whose snapshot line matches, read from the latest tool result. */
function refOf(req: LlmRequest, pattern: RegExp): number {
  const last = req.messages.at(-1)!.content as Array<{ content: string }>;
  const line = last.map((b) => b.content).join('\n').split('\n').find((l) => /^\[\d+\]/.test(l) && pattern.test(l));
  if (!line) throw new Error(`no element matching ${pattern} in:\n${last.map((b) => b.content).join('\n')}`);
  return Number(/^\[(\d+)\]/.exec(line)![1]);
}

describe.skipIf(!existsSync(CHROMIUM))('handoff with a real browser', () => {
  let server: http.Server;
  let base: string;
  let port: number;
  let hits: string[];
  let posts: Array<{ path: string; body: URLSearchParams }>;
  let user: string;
  let events: ServerEvent[];
  let decisions: Array<'approve' | 'deny'>;
  let unsubscribe: () => void;

  beforeAll(async () => {
    config.chromiumPath = CHROMIUM;
    const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      hits.push(`${req.method} ${url.pathname}`);
      const html = (s: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(s);
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const body = new URLSearchParams(raw);
          posts.push({ path: url.pathname, body });
          // Echo what was submitted, as a careless site might.
          html(page('Received', `<h1>Thanks</h1><p>You sent: ${[...body.values()].join(' / ')}</p>`));
        });
        return;
      }
      if (url.pathname === '/') return html(page('Test Home', '<h1>Welcome to the test site</h1><p>First paragraph of text.</p><a href="/shop">Shop</a>'));
      if (url.pathname === '/login') return html(page('Sign in', '<h1>Sign in</h1><form method="post" action="/session"><label>Email <input name="email" type="text"></label><label>Password <input name="pw" type="password"></label><button>Log in</button></form><form action="/find"><input name="q" type="search" placeholder="Search"></form>'));
      if (url.pathname === '/shop') return html(page('Checkout', '<h1>Your basket</h1><p>1 × Teapot — £24.00</p><form method="post" action="/order"><input type="hidden" name="sku" value="teapot"><button type="submit">Place order</button></form>'));
      if (url.pathname === '/redir') return void res.writeHead(302, { location: `http://localhost:${port}/secret` }).end();
      html(page('Other', `<p>${url.pathname}</p>`));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => server.close());

  beforeEach(() => {
    process.env.VECTOR_HANDOFF_ALLOW_LOCAL = '1';
    resetDbForTests();
    user = users.create({ email: 'a@x.dev', name: 'Ada', passwordHash: 'h' }).id;
    hits = [];
    posts = [];
    events = [];
    decisions = [];
    unsubscribe = subscribe(user, (e) => {
      events.push(e);
      // Answer like a user tapping the card a moment after it appears.
      if (e.type === 'approval.requested') setTimeout(() => resolveApproval(user, e.approval.id, decisions.shift() ?? 'deny'), 20);
    });
  });
  afterEach(() => {
    unsubscribe();
    delete process.env.VECTOR_HANDOFF_ALLOW_LOCAL;
  });

  const go = (client: LlmClient, goal = 'test goal', extra: Partial<Parameters<ReturnType<typeof createHandoffRuntime>['run']>[0]> = {}) => {
    const rt = createHandoffRuntime({ llm: client });
    return { rt, done: rt.run({ userId: user, threadId: null, goal, signal: new AbortController().signal, ...extra }) };
  };
  const statuses = () => events.filter((e) => e.type === 'handoff.update').map((e) => (e as any).run.status as string).filter((s, i, a) => s !== a[i - 1]);

  it('navigates, reads and finishes (offline model), with a live frame and a wrapped report', async () => {
    let started = '';
    const { rt, done } = go(createOfflineClient(), `Open ${base}/ and tell me what it says`, { onStart: (id) => (started = id) });
    const res = await done;
    expect(res.status).toBe('done');
    expect(res.runId).toBe(started);
    expect(res.result).toMatch(/^<handoff_report untrusted="true" status="done">/);
    expect(res.result).toContain('Test Home');
    expect(res.result).toContain('Welcome to the test site');
    expect(res.result).toContain('not instructions');

    const run = handoffRuns.get(user, res.runId)!;
    expect(run.status).toBe('done');
    expect(run.endedAt).toBeTruthy();
    expect(run.url).toBe(`${base}/`);
    expect(run.steps.map((s) => s.action)).toEqual(['navigate', 'read', 'finish']);
    expect(run.screenshotVersion).toBeGreaterThan(0);
    const shot = rt.screenshot(user, res.runId)!;
    expect(shot.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // JPEG
    expect(rt.screenshot('someone-else', res.runId)).toBeNull();
    expect(listAudit(user).filter((a) => a.event === 'handoff.step')).toHaveLength(3);
    expect(statuses()).toEqual(['running', 'done']);
  }, 60_000);

  it('fills a saved login only after approval, and the password reaches the page but nothing else', async () => {
    const item = vault.create(user, { kind: 'login', label: 'Test site login', origin: base, username: USERNAME, password: SECRET });
    decisions = ['approve', 'approve'];
    const s = scripted([
      call('navigate', { url: `${base}/login` }),
      call('snapshot', {}),
      (req) => call('fill_from_vault', { ref: refOf(req, /"Email/), vault_item_id: item.id, field: 'username' }),
      call('snapshot', {}),
      (req) => call('fill_from_vault', { ref: refOf(req, /input\(password\)/), vault_item_id: item.id, field: 'password' }),
      call('snapshot', {}),
      call('press', { key: 'Enter' }), // refused: would submit a form without approval
      call('request_approval', { kind: 'account_change', summary: 'Sign in to the test site', detail: { account: 'Test site login' } }),
      call('press', { key: 'Enter' }),
      call('snapshot', {}), // the response page echoes what was submitted
      finish('Signed in.'),
    ]);
    const res = await go(s.client, 'sign in', { threadId: null }).done;
    expect(res.status).toBe('done');

    // The page really received the secret.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('/session');
    expect(posts[0]!.body.get('pw')).toBe(SECRET);
    expect(posts[0]!.body.get('email')).toBe(USERNAME);

    // One vault approval for the item (not one per field), plus the model's own request.
    const approvals = approvalRows.list(user);
    expect(approvals.map((a) => a.kind).sort()).toEqual(['account_change', 'vault_use']);
    const vaultApproval = approvals.find((a) => a.kind === 'vault_use')!;
    expect(vaultApproval.summary).toBe(`Use saved login “Test site login” on 127.0.0.1:${port}`);
    expect(vaultApproval.status).toBe('approved');

    // The guard held the first Enter back, and the model was told why.
    expect(s.resultsAfter(6)[0]).toMatchObject({ is_error: true });
    expect(s.resultsAfter(6)[0]!.content).toContain('request_approval');
    expect(s.resultsAfter(4)[0]!.content).toContain('hidden from you');
    expect(s.resultsAfter(5)[0]!.content).toContain('value="(hidden)"');
    expect(s.resultsAfter(9)[0]!.content).toContain('[hidden]'); // echoed secret scrubbed from the snapshot

    // Neither secret appears in anything the model was given, any step, any audit row, any event or the result.
    const run = handoffRuns.get(user, res.runId)!;
    const everything = JSON.stringify([s.seen, run, listAudit(user, 500), events, res, approvals]);
    expect(everything).toContain('Test site login');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(USERNAME);
    expect(run.steps.map((x) => x.action)).toContain('fill_secret');
    expect(listAudit(user, 500).some((a) => a.event === 'vault.item_used')).toBe(true);
    // Status went into and out of waiting_approval, visibly.
    expect(statuses()).toEqual(['running', 'waiting_approval', 'running', 'waiting_approval', 'running', 'done']);
  }, 60_000);

  it('refuses to fill a login saved for another site, and a password into a non-password field', async () => {
    const elsewhere = vault.create(user, { kind: 'login', label: 'Bank', origin: 'https://bank.example.com', username: USERNAME, password: SECRET });
    const here = vault.create(user, { kind: 'login', label: 'Here', origin: base, username: USERNAME, password: SECRET });
    decisions = ['approve'];
    const s = scripted([
      call('navigate', { url: `${base}/login` }),
      call('snapshot', {}),
      (req) => call('fill_from_vault', { ref: refOf(req, /input\(password\)/), vault_item_id: elsewhere.id, field: 'password' }),
      call('snapshot', {}),
      (req) => call('fill_from_vault', { ref: refOf(req, /"Email/), vault_item_id: here.id, field: 'password' }),
      call('fill_from_vault', { ref: 999, vault_item_id: here.id, field: 'username' }),
      finish('Could not sign in.', false),
    ]);
    const res = await go(s.client).done;
    expect(res.status).toBe('failed');
    expect(s.resultsAfter(2)[0]).toMatchObject({ is_error: true });
    expect(s.resultsAfter(2)[0]!.content).toContain('https://bank.example.com');
    expect(s.resultsAfter(4)[0]!.content).toContain('only filled into a password field');
    expect(s.resultsAfter(5)[0]!.content).toContain('new snapshot');
    expect(approvalRows.list(user)).toHaveLength(0); // refused before anyone was asked
    expect(listAudit(user, 500).some((a) => a.event === 'vault.item_used')).toBe(false);
    expect(posts).toHaveLength(0);
  }, 60_000);

  it('blocks a "Place order" click until the user approves', async () => {
    decisions = ['approve'];
    const s = scripted([
      call('navigate', { url: `${base}/shop` }),
      call('snapshot', {}),
      (req) => call('click', { ref: refOf(req, /Place order/) }),
      call('request_approval', { kind: 'purchase', summary: 'Buy 1 teapot for £24.00', detail: { item: 'Teapot', amount: '£24.00', site: 'evil.example' } }),
      call('snapshot', {}),
      (req) => call('click', { ref: refOf(req, /Place order/) }),
      finish('Ordered.'),
    ]);
    const res = await go(s.client).done;
    expect(res.status).toBe('done');
    expect(s.resultsAfter(2)[0]).toMatchObject({ is_error: true });
    expect(s.resultsAfter(2)[0]!.content).toContain('Ask for approval first with request_approval, then retry');
    expect(posts.map((p) => p.path)).toEqual(['/order']);
    const approval = approvalRows.list(user)[0]!;
    expect(approval).toMatchObject({ kind: 'purchase', status: 'approved' });
    expect(approval.detail).toMatchObject({ item: 'Teapot', amount: '£24.00', site: `127.0.0.1:${port}` }); // site comes from the browser
    expect(handoffRuns.get(user, res.runId)!.steps.map((x) => x.action)).toContain('blocked');
  }, 60_000);

  it('stops that line of action when the user says no', async () => {
    decisions = ['deny'];
    const s = scripted([
      call('navigate', { url: `${base}/shop` }),
      call('snapshot', {}),
      call('request_approval', { kind: 'purchase', summary: 'Buy 1 teapot for £24.00' }),
      (req) => call('click', { ref: refOf({ ...req, messages: req.messages.slice(0, 5) }, /Place order/) }),
      call('request_approval', { kind: 'purchase', summary: 'Buy it anyway' }),
      finish('The user declined the purchase.', false),
    ]);
    const res = await go(s.client).done;
    expect(res.status).toBe('failed');
    expect(posts).toHaveLength(0);
    for (const n of [2, 3, 4]) {
      expect(s.resultsAfter(n)[0]).toMatchObject({ is_error: true });
      expect(s.resultsAfter(n)[0]!.content).toContain('did not approve');
    }
    expect(approvalRows.list(user).map((a) => a.status)).toEqual(['denied']); // asked once, not twice
  }, 60_000);

  it('lets a plain search box be submitted without approval', async () => {
    const s = scripted([
      call('navigate', { url: `${base}/login` }),
      call('snapshot', {}),
      (req) => call('type', { ref: refOf(req, /input\(search\)/), text: 'teapots', submit: true }),
      finish(),
    ]);
    expect((await go(s.client).done).status).toBe('done');
    expect(hits).toContain('GET /find');
    expect(approvalRows.list(user)).toHaveLength(0);
  }, 60_000);

  it('refuses local addresses unless explicitly allowed', async () => {
    delete process.env.VECTOR_HANDOFF_ALLOW_LOCAL;
    const s = scripted([
      call('navigate', { url: `${base}/` }),
      call('navigate', { url: `http://localhost:${port}/` }),
      call('navigate', { url: 'file:///etc/passwd' }),
      call('navigate', { url: 'http://169.254.169.254/latest/meta-data/' }),
      finish('Nothing could be opened.', false),
    ]);
    const res = await go(s.client).done;
    expect(res.status).toBe('failed');
    for (const n of [0, 1, 2, 3]) expect(s.resultsAfter(n)[0], String(n)).toMatchObject({ is_error: true });
    expect(s.resultsAfter(0)[0]!.content).toContain('local or private');
    expect(hits).toEqual([]);
  }, 60_000);

  it('blocks a redirect into a forbidden host (the hop a route handler never sees)', async () => {
    const s = scripted([call('navigate', { url: `${base}/redir` }), call('snapshot', {}), finish('Blocked.', false)]);
    const rt = createHandoffRuntime({ llm: s.client, hostCheck: async (host) => (host === 'localhost' ? null : resolvePublicHost(host)) });
    await rt.run({ userId: user, threadId: null, goal: 'follow the redirect', signal: new AbortController().signal });
    expect(hits).toContain('GET /redir');
    expect(hits).not.toContain('GET /secret');
    expect(JSON.stringify(s.seen)).not.toContain('/secret</p>');
  }, 60_000);

  it('cancels promptly, from the runtime and from the caller’s signal', async () => {
    let runId = '';
    const rtRef: { rt?: ReturnType<typeof createHandoffRuntime> } = {};
    const s = scripted([
      call('navigate', { url: `${base}/` }),
      () => {
        setTimeout(() => rtRef.rt!.cancel(user, runId), 100);
        return call('wait', { seconds: 10 });
      },
      finish(),
    ]);
    const started = Date.now();
    const { rt, done } = go(s.client, 'wait around', { onStart: (id) => (runId = id) });
    rtRef.rt = rt;
    const res = await done;
    expect(res.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(8000);
    expect(handoffRuns.get(user, runId)!.status).toBe('cancelled');
    expect(s.seen).toHaveLength(2);

    // While waiting for an approval, an abort from the caller ends the run and expires the request.
    const ac = new AbortController();
    const s2 = scripted([call('navigate', { url: `${base}/shop` }), call('request_approval', { kind: 'purchase', summary: 'Buy' }), finish()]);
    const off = subscribe(user, (e) => {
      if (e.type === 'handoff.update' && e.run.status === 'waiting_approval') setTimeout(() => ac.abort(), 30);
    });
    unsubscribe(); // nobody answers this one
    const res2 = await createHandoffRuntime({ llm: s2.client }).run({ userId: user, threadId: null, goal: 'buy', signal: ac.signal });
    off();
    expect(res2.status).toBe('cancelled');
    expect(approvalRows.list(user).map((a) => a.status)).toEqual(['expired']);
  }, 60_000);

  it('reports a readable failure when the browser cannot start', async () => {
    config.chromiumPath = '/nonexistent/chromium';
    try {
      const res = await go(scripted([finish()]).client).done;
      expect(res.status).toBe('failed');
      expect(res.result).toContain('The browser agent is not available on this server');
    } finally {
      config.chromiumPath = CHROMIUM;
    }
  }, 60_000);
});

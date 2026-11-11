import { afterEach, beforeEach, describe, expect, it } from 'vitest';
process.env.VECTOR_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/http/app.ts';
import { startScheduler } from '../server/http/scheduler.ts';
import { requestApproval } from '../server/core/approvals.ts';
import { publish } from '../server/core/bus.ts';
import {
  actions, db, handoffRuns, listAudit, messages, panels, resetDbForTests, tasks, threads, users,
} from '../server/core/db.ts';
import { AgentBusyError } from '../server/core/runtime.ts';
import type { AgentRuntime, HandoffRuntime } from '../server/core/runtime.ts';

type TurnOpts = Parameters<AgentRuntime['startTurn']>[0];
type TurnStatus = 'ok' | 'error' | 'cancelled';

/** Records every turn and lets the test decide when and how it ends. */
function fakeAgent() {
  const state = {
    turns: [] as Array<{ opts: TurnOpts; finish: (s: TurnStatus) => void }>,
    busy: false,
    cancelledAll: [] as string[],
  };
  const runtime: AgentRuntime = {
    startTurn(opts) {
      if (state.busy) throw new AgentBusyError();
      let finish!: (s: TurnStatus) => void;
      const done = new Promise<TurnStatus>((resolve) => (finish = resolve));
      state.turns.push({ opts, finish });
      return { runId: `run_${state.turns.length}`, done };
    },
    cancel() {},
    isRunning: () => false,
    cancelAll: (userId) => void state.cancelledAll.push(userId),
  };
  return { state, runtime };
}

function fakeHandoff() {
  const state = { cancelledAll: [] as string[], cancelled: [] as string[] };
  const runtime: HandoffRuntime = {
    run: async () => ({ runId: 'x', status: 'done', result: '' }),
    screenshot: () => Buffer.from([0xff, 0xd8, 0xff]),
    cancel: (_userId, runId) => void state.cancelled.push(runId),
    cancelAll: (userId) => void state.cancelledAll.push(userId),
  };
  return { state, runtime };
}

const PASSWORD = 'correct horse battery';
const tick = () => new Promise((resolve) => setImmediate(resolve));

let app: FastifyInstance;
let agent: ReturnType<typeof fakeAgent>;
let handoff: ReturnType<typeof fakeHandoff>;

beforeEach(async () => {
  resetDbForTests();
  agent = fakeAgent();
  handoff = fakeHandoff();
  app = await buildApp({ agent: agent.runtime, handoff: handoff.runtime });
});
afterEach(async () => {
  await app.close();
});

/** Sign up and return a client bound to that session. */
async function signup(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: PASSWORD, name: email.split('@')[0] } });
  expect(res.statusCode).toBe(200);
  const token = res.cookies.find((c) => c.name === 'vector_session')!.value;
  const userId = res.json().user.id as string;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api${url}`, cookies: { vector_session: token }, ...(payload ? { payload } : {}) });
  return { userId, token, call };
}

describe('auth', () => {
  it('signs up, signs in and out, and keeps only a hash of the session token', async () => {
    const short = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'a@x.dev', password: 'short', name: 'A' } });
    expect(short.statusCode).toBe(400);
    expect(short.json().error).toMatch(/at least 10/);

    const a = await signup('a@x.dev');
    const stored = db().prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(stored.password_hash).toMatch(/^scrypt\$/);
    expect(stored.password_hash).not.toContain(PASSWORD);
    expect(JSON.stringify(db().prepare('SELECT * FROM sessions').all())).not.toContain(a.token);

    const me = await a.call('GET', '/auth/me');
    expect(me.json().user).toMatchObject({ id: a.userId, email: 'a@x.dev' });
    expect(JSON.stringify(me.json())).not.toMatch(/scrypt|password/i);

    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.dev', password: 'not the password' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@x.dev', password: PASSWORD } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.cookies).toHaveLength(0);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'A@X.dev', password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.find((c) => c.name === 'vector_session')!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(cookie.maxAge).toBe(30 * 24 * 60 * 60);

    expect((await a.call('POST', '/auth/logout')).json()).toEqual({ ok: true });
    expect((await a.call('GET', '/auth/me')).statusCode).toBe(401);
    // The other session (from the explicit login) is still valid.
    expect((await app.inject({ url: '/api/auth/me', cookies: { vector_session: cookie.value } })).statusCode).toBe(200);

    expect(listAudit(a.userId).map((e) => e.event)).toEqual(
      expect.arrayContaining(['auth.signup', 'auth.login_failed', 'auth.login', 'auth.logout']));
  });

  it('refuses a duplicate email, anonymous access and unknown API routes', async () => {
    await signup('a@x.dev');
    const dup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'A@x.dev', password: PASSWORD, name: 'A' } });
    expect(dup.statusCode).toBe(409);
    for (const url of ['/api/bootstrap', '/api/vault', '/api/export', '/api/events', '/api/auth/me']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBeTruthy();
    }
    const missing = await app.inject({ url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBeTruthy();
  });

  it('rate-limits sign-in attempts', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.dev', password: 'x' } })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[11]).toBe(429);
  });
});

describe('request hardening', () => {
  it('rejects cross-origin and non-JSON writes, and sends security headers', async () => {
    const a = await signup('a@x.dev');
    const post = (headers: Record<string, string>, payload: object | string = { content: 'likes tea' }) =>
      app.inject({ method: 'POST', url: '/api/memories', cookies: { vector_session: a.token }, headers, payload });

    expect((await post({ origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ origin: 'null' })).statusCode).toBe(403);
    expect((await post({ origin: 'http://localhost:80.evil.example' })).statusCode).toBe(403);
    expect((await post({ 'content-type': 'text/plain' }, '{"content":"likes tea"}')).statusCode).toBe(403);
    expect((await a.call('GET', '/memories')).json().memories).toHaveLength(0);

    const ok = await post({ origin: 'http://localhost:80' }); // inject's default Host
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    expect(ok.headers['content-security-policy']).toContain("frame-ancestors 'none'");

    const tooLong = await a.call('POST', '/memories', { content: 'x'.repeat(2001) });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toMatch(/content/);
  });
});

describe('isolation between users', () => {
  it("answers 404 for every id that belongs to someone else", async () => {
    const a = await signup('a@x.dev');
    const b = await signup('b@x.dev');

    const thread = threads.main(a.userId);
    messages.append({ userId: a.userId, threadId: thread.id, role: 'user', api: null, parts: [{ type: 'text', id: 'p', text: 'private words' }] });
    const panel = panels.create(a.userId, { title: 'Budget', html: '<p>private panel</p>' });
    const vaultItem = (await a.call('POST', '/vault', { kind: 'note', label: 'pin', text: '1234' })).json().item;
    let approvalId = '';
    const pending = requestApproval({ userId: a.userId, threadId: null, kind: 'purchase', summary: 'Buy', onCreated: (x) => (approvalId = x.id) });
    const run = handoffRuns.create(a.userId, null, 'book a table');
    const project = (await a.call('POST', '/projects', { name: 'Trip' })).json().project;
    const task = (await a.call('POST', '/tasks', { title: 'Digest', prompt: 'Summarise', cron: '0 9 * * *' })).json().task;
    const memory = (await a.call('POST', '/memories', { content: 'likes tea' })).json().memory;
    const action = actions.create(a.userId, { verb: 'Pay', title: 'Rent', prompt: 'Pay the rent' });

    const attempts: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, object?]> = [
      ['GET', `/threads/${thread.id}/messages`],
      ['POST', `/threads/${thread.id}/messages`, { text: 'hi' }],
      ['GET', `/threads/${thread.id}/status`],
      ['POST', `/threads/${thread.id}/cancel`],
      ['GET', `/panels/${panel.id}/frame`],
      ['POST', `/panels/${panel.id}/reply`, { text: 'change it' }],
      ['DELETE', `/panels/${panel.id}`],
      ['DELETE', `/vault/${vaultItem.id}`],
      ['POST', `/approvals/${approvalId}`, { decision: 'approve' }],
      ['GET', `/handoff/${run.id}`],
      ['GET', `/handoff/${run.id}/screenshot`],
      ['POST', `/handoff/${run.id}/cancel`],
      ['PATCH', `/projects/${project.id}`, { name: 'Mine now' }],
      ['DELETE', `/projects/${project.id}`],
      ['PATCH', `/tasks/${task.id}`, { title: 'Mine now' }],
      ['POST', `/tasks/${task.id}/run`],
      ['DELETE', `/tasks/${task.id}`],
      ['PATCH', `/memories/${memory.id}`, { content: 'overwritten' }],
      ['DELETE', `/memories/${memory.id}`],
      ['POST', `/actions/${action.id}/run`],
      ['POST', `/actions/${action.id}/dismiss`],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await b.call(method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.body).not.toMatch(/private|likes tea|Budget/);
    }
    expect(agent.state.turns).toHaveLength(0);
    expect(handoff.state.cancelled).toHaveLength(0);

    // Nothing of A's was touched, and A can still decide the approval B tried to take.
    expect((await a.call('GET', `/threads/${thread.id}/messages`)).json().messages).toHaveLength(1);
    expect((await a.call('GET', '/projects')).json().projects[0].name).toBe('Trip');
    expect((await a.call('GET', '/memories')).json().memories[0].content).toBe('likes tea');
    expect((await a.call('GET', '/vault')).json().items).toHaveLength(1);
    expect((await a.call('GET', `/handoff/${run.id}`)).json().run.goal).toBe('book a table');
    expect((await a.call('GET', `/handoff/${run.id}/screenshot`)).headers['content-type']).toBe('image/jpeg');
    for (const list of ['/projects', '/tasks', '/memories', '/panels', '/actions', '/approvals']) {
      expect(Object.values((await b.call('GET', list)).json())[0]).toEqual([]);
    }
    expect((await a.call('POST', `/approvals/${approvalId}`, { decision: 'deny' })).statusCode).toBe(200);
    expect((await pending).decision).toBe('denied');
  });
});

describe('vault', () => {
  it('never returns secret material from any route', async () => {
    const a = await signup('a@x.dev');
    const secret = 'hunter2-Sup3rSecret!';
    const created = await a.call('POST', '/vault', { kind: 'login', label: 'Shop', origin: 'shop.example.com', username: 'varun@x.dev', password: secret });
    expect(created.statusCode).toBe(200);
    expect(Object.keys(created.json().item).sort()).toEqual(['createdAt', 'hint', 'id', 'kind', 'label', 'origin']);
    await a.call('POST', '/vault', { kind: 'card', label: 'Visa', number: '4242 4242 4242 4242', expMonth: '12', expYear: '2030', cvc: '987', nameOnCard: 'V' });

    const responses = [created, await a.call('GET', '/vault'), await a.call('GET', '/export'), await a.call('GET', '/bootstrap'), await a.call('GET', '/audit')];
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(secret);
      expect(res.body).not.toContain('varun@x.dev');
      expect(res.body).not.toContain('4242424242424242');
      expect(res.body).not.toMatch(/payload_?enc/i);
    }
    const exported = await a.call('GET', '/export');
    expect(exported.headers['content-disposition']).toMatch(/^attachment; filename="vector-export-/);
    expect(exported.json().vault).toHaveLength(2);
    expect(exported.json().user.email).toBe('a@x.dev');

    const bad = await a.call('POST', '/vault', { kind: 'login', label: 'Shop', origin: 'http://shop.example.com', username: 'u', password: secret });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/https/);
    expect(bad.body).not.toContain(secret);
  });
});

describe('panels', () => {
  it('serves the frame as a sandboxed document and relays replies to the main thread', async () => {
    const a = await signup('a@x.dev');
    const panel = panels.create(a.userId, { title: 'Budget', html: '<script>document.title = document.cookie</script>' });
    const frame = await a.call('GET', `/panels/${panel.id}/frame`);
    expect(frame.statusCode).toBe(200);
    expect(frame.headers['content-type']).toMatch(/^text\/html/);
    expect(frame.body).toBe('<script>document.title = document.cookie</script>');
    expect(frame.headers['content-security-policy']).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
    expect(frame.headers['cache-control']).toBe('no-store');
    expect(frame.headers['x-content-type-options']).toBe('nosniff');
    // The list never carries the HTML.
    expect((await a.call('GET', '/panels')).body).not.toContain('<script');

    const reply = await a.call('POST', `/panels/${panel.id}/reply`, { text: 'add a savings row' });
    expect(reply.statusCode).toBe(202);
    expect(reply.json().threadId).toBe(threads.main(a.userId).id);
    expect(agent.state.turns[0]!.opts).toMatchObject({
      source: 'panel', threadId: threads.main(a.userId).id,
      text: `[About the panel "Budget" (panel id ${panel.id})] add a savings row`,
    });
    expect((await a.call('POST', `/panels/${panel.id}/reply`, { text: 'x'.repeat(4001) })).statusCode).toBe(400);
  });
});

describe('chat and approvals', () => {
  it('starts a turn, reports a busy thread as 409 and pages messages', async () => {
    const a = await signup('a@x.dev');
    const threadId = threads.main(a.userId).id;
    const sent = await a.call('POST', `/threads/${threadId}/messages`, { text: 'hello' });
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toEqual({ runId: 'run_1' });
    expect(agent.state.turns[0]!.opts).toEqual({ userId: a.userId, threadId, text: 'hello', source: 'user' });

    agent.state.busy = true;
    expect((await a.call('POST', `/threads/${threadId}/messages`, { text: 'again' })).statusCode).toBe(409);
    expect((await a.call('POST', `/threads/${threadId}/messages`, { text: '   ' })).statusCode).toBe(400);
    expect((await a.call('POST', `/threads/${threadId}/messages`, { text: 'x'.repeat(20_001) })).statusCode).toBe(400);

    for (let i = 0; i < 3; i++) messages.append({ userId: a.userId, threadId, role: 'user', api: null, parts: [{ type: 'text', id: `p${i}`, text: `m${i}` }] });
    const page = (await a.call('GET', `/threads/${threadId}/messages?limit=2`)).json();
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((m: any) => m.parts[0].text)).toEqual(['m1', 'm2']);
  });

  it('resolves a pending approval exactly once', async () => {
    const a = await signup('a@x.dev');
    let id = '';
    const pending = requestApproval({ userId: a.userId, threadId: null, kind: 'purchase', summary: 'Buy socks', onCreated: (x) => (id = x.id) });
    expect((await a.call('GET', '/approvals?status=pending')).json().approvals.map((x: any) => x.id)).toEqual([id]);
    expect((await a.call('POST', `/approvals/${id}`, { decision: 'maybe' })).statusCode).toBe(400);

    const res = await a.call('POST', `/approvals/${id}`, { decision: 'approve' });
    expect(res.statusCode).toBe(200);
    expect(res.json().approval).toMatchObject({ id, status: 'approved' });
    expect((await pending).decision).toBe('approved');
    expect((await a.call('POST', `/approvals/${id}`, { decision: 'deny' })).statusCode).toBe(404);
  });
});

describe('action buttons', () => {
  it('runs in the main thread and ends done, or reopens on failure and when busy', async () => {
    const a = await signup('a@x.dev');
    const status = (id: string) => actions.get(a.userId, id)!.status;
    const pay = actions.create(a.userId, { verb: 'Pay', title: 'Rent', prompt: 'Pay the rent' });

    const res = await a.call('POST', `/actions/${pay.id}/run`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: 'run_1', threadId: threads.main(a.userId).id });
    expect(agent.state.turns[0]!.opts).toMatchObject({ source: 'action', text: '[Action button: Pay — Rent] Pay the rent' });
    expect(status(pay.id)).toBe('running');
    expect((await a.call('POST', `/actions/${pay.id}/run`)).statusCode).toBe(404); // not open any more
    agent.state.turns[0]!.finish('ok');
    await tick();
    expect(status(pay.id)).toBe('done');
    expect((await a.call('GET', '/actions')).json().actions).toHaveLength(0);

    const book = actions.create(a.userId, { verb: 'Book', title: 'Dentist', prompt: 'Book it' });
    await a.call('POST', `/actions/${book.id}/run`);
    agent.state.turns[1]!.finish('error');
    await tick();
    expect(status(book.id)).toBe('open');

    agent.state.busy = true;
    expect((await a.call('POST', `/actions/${book.id}/run`)).statusCode).toBe(409);
    expect(status(book.id)).toBe('open');
  });
});

describe('scheduled tasks', () => {
  it('validates schedules and keeps nextRunAt in step with cron and enabled', async () => {
    const a = await signup('a@x.dev');
    const base = { title: 'Digest', prompt: 'Summarise my inbox' };
    expect((await a.call('POST', '/tasks', { ...base, cron: 'every day' })).statusCode).toBe(400);
    expect((await a.call('POST', '/tasks', { ...base, cron: '* * * * *' })).json().error).toMatch(/5 minutes/);
    expect((await a.call('POST', '/tasks', { ...base, cron: '0 9 * * *', timezone: 'Mars/Olympus' })).statusCode).toBe(400);

    await a.call('PATCH', '/settings', { timezone: 'Europe/Paris' });
    const task = (await a.call('POST', '/tasks', { ...base, cron: '0 9 * * *' })).json().task;
    expect(task).toMatchObject({ timezone: 'Europe/Paris', enabled: true });
    expect(Date.parse(task.nextRunAt)).toBeGreaterThan(Date.now());

    const renamed = (await a.call('PATCH', `/tasks/${task.id}`, { title: 'Morning digest' })).json().task;
    expect(renamed).toMatchObject({ title: 'Morning digest', nextRunAt: task.nextRunAt });
    expect((await a.call('PATCH', `/tasks/${task.id}`, { enabled: false })).json().task.nextRunAt).toBeNull();
    const moved = (await a.call('PATCH', `/tasks/${task.id}`, { enabled: true, cron: '30 18 * * *' })).json().task;
    expect(new Date(moved.nextRunAt).getUTCMinutes()).toBe(30);
    expect((await a.call('PATCH', `/tasks/${task.id}`, { cron: 'nope' })).statusCode).toBe(400);
  });

  it('fires a due task once, advances nextRunAt and records the result', async () => {
    const a = await signup('a@x.dev');
    const scheduler = startScheduler({ agent: agent.runtime });
    try {
      const task = (await a.call('POST', '/tasks', { title: 'Digest', prompt: 'Summarise my inbox', cron: '0 9 * * *' })).json().task;
      const later = (await a.call('POST', '/tasks', { title: 'Later', prompt: 'p', cron: '0 10 * * *' })).json().task;

      await scheduler.tick();
      expect(agent.state.turns).toHaveLength(0); // nothing is due yet

      const now = new Date();
      const due = new Date(now.getTime() - 60_000).toISOString();
      tasks.update(a.userId, task.id, { nextRunAt: due });

      agent.state.busy = true;
      await scheduler.tick(now);
      expect(tasks.get(a.userId, task.id)!.nextRunAt).toBe(due); // busy: left for the next tick
      agent.state.busy = false;

      await scheduler.tick(now);
      await scheduler.tick(now);
      expect(agent.state.turns).toHaveLength(1);
      expect(agent.state.turns[0]!.opts).toEqual({
        userId: a.userId, threadId: threads.main(a.userId).id, source: 'task', unattended: true,
        text: '[Scheduled task: Digest] Summarise my inbox',
      });
      const after = tasks.get(a.userId, task.id)!;
      expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(now.getTime());
      expect(after.lastStatus).toBeNull();
      expect(tasks.get(a.userId, later.id)!.nextRunAt).toBe(later.nextRunAt);

      agent.state.turns[0]!.finish('ok');
      await tick();
      expect(tasks.get(a.userId, task.id)).toMatchObject({ lastStatus: 'ok', nextRunAt: after.nextRunAt });
      expect(tasks.get(a.userId, task.id)!.lastRunAt).toBeTruthy();

      // A schedule that stops validating disables the task instead of breaking the loop.
      db().prepare("UPDATE tasks SET cron='broken', next_run_at=? WHERE id=?").run(due, later.id);
      await scheduler.tick(now);
      expect(tasks.get(a.userId, later.id)).toMatchObject({ enabled: false, nextRunAt: null });
      expect(agent.state.turns).toHaveLength(1);

      // "Run now" goes through the same path.
      const manual = await a.call('POST', `/tasks/${task.id}/run`);
      expect(manual.statusCode).toBe(202);
      expect(agent.state.turns[1]!.opts).toMatchObject({ source: 'task', unattended: true });
      agent.state.turns[1]!.finish('cancelled');
      await tick();
      expect(tasks.get(a.userId, task.id)!.lastStatus).toBe('error');
    } finally {
      scheduler.stop();
    }
  });
});

describe('settings', () => {
  it('accepts only known approval kinds and valid timezones', async () => {
    const a = await signup('a@x.dev');
    expect((await a.call('PATCH', '/settings', { timezone: 'Nowhere/Land' })).statusCode).toBe(400);
    expect((await a.call('PATCH', '/settings', { autoApprove: { everything: true } })).statusCode).toBe(400);
    expect((await a.call('PATCH', '/settings', { autoApprove: { purchase: 'yes' } })).statusCode).toBe(400);

    const res = await a.call('PATCH', '/settings', { name: 'Ada', autoApprove: { other: true }, memoryEnabled: false });
    expect(res.json().user).toMatchObject({ name: 'Ada', settings: { memoryEnabled: false, autoApprove: { other: true, purchase: false } } });
    expect(listAudit(a.userId)[0]).toMatchObject({ event: 'settings.changed', detail: { changed: ['name', 'memoryEnabled', 'autoApprove.other'] } });
    expect((await a.call('GET', '/settings')).json().settings.autoApprove.other).toBe(true);
  });
});

describe('events', () => {
  it('streams hello and then only this user\'s events', async () => {
    const a = await signup('a@x.dev');
    const b = await signup('b@x.dev');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const abort = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { cookie: `vector_session=${a.token}` }, signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const readUntil = async (needle: string) => {
      while (!seen.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}`);
        seen += decoder.decode(value, { stream: true });
      }
    };
    await readUntil('data: {"type":"hello"}\n\n');
    publish(b.userId, { type: 'invalidate', resource: 'vault' });
    publish(a.userId, { type: 'invalidate', resource: 'tasks' });
    await readUntil('data: {"type":"invalidate","resource":"tasks"}\n\n');
    expect(seen).not.toContain('vault');
    abort.abort();
  });
});

describe('account deletion', () => {
  it('needs the current password and then erases everything', async () => {
    const a = await signup('a@x.dev');
    const b = await signup('b@x.dev');
    await a.call('POST', '/memories', { content: 'likes tea' });
    await a.call('POST', '/vault', { kind: 'note', label: 'pin', text: '1234' });
    const pending = requestApproval({ userId: a.userId, threadId: null, kind: 'purchase', summary: 'Buy' });

    const wrong = await a.call('DELETE', '/account', { password: 'not the password' });
    expect(wrong.statusCode).toBe(403);
    expect((await a.call('DELETE', '/account', {})).statusCode).toBe(400);
    expect(users.get(a.userId)).not.toBeNull();
    expect(agent.state.cancelledAll).toHaveLength(0);

    const res = await a.call('DELETE', '/account', { password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.cookies.find((c) => c.name === 'vector_session')!.value).toBe('');
    expect(agent.state.cancelledAll).toEqual([a.userId]);
    expect(handoff.state.cancelledAll).toEqual([a.userId]);
    expect((await pending).decision).toBe('expired');

    expect(users.get(a.userId)).toBeNull();
    for (const table of ['sessions', 'threads', 'memories', 'vault_items', 'approvals', 'audit_log']) {
      expect(db().prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(a.userId), table).toMatchObject({ n: 0 });
    }
    expect((await a.call('GET', '/auth/me')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.dev', password: PASSWORD } })).statusCode).toBe(401);
    expect((await b.call('GET', '/auth/me')).statusCode).toBe(200);
  });
});

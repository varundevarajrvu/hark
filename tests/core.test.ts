import { beforeEach, describe, expect, it } from 'vitest';
process.env.VECTOR_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
import { resetDbForTests, users, vaultRows, db, threads, messages, projects } from '../server/core/db.ts';
import { vault, originAllows, normalizeOrigin } from '../server/core/vault.ts';
import { requestApproval, resolveApproval } from '../server/core/approvals.ts';

let a: string, b: string;
beforeEach(() => {
  resetDbForTests();
  a = users.create({ email: 'a@x.dev', name: 'A', passwordHash: 'h' }).id;
  b = users.create({ email: 'b@x.dev', name: 'B', passwordHash: 'h' }).id;
});

describe('vault', () => {
  it('stores ciphertext only and round-trips', () => {
    const item = vault.create(a, { kind: 'login', label: 'Shop', origin: 'shop.example.com', username: 'varun@x.dev', password: 'hunter2!' });
    const raw = db().prepare('SELECT * FROM vault_items').all().map((r) => JSON.stringify(r)).join();
    expect(raw).not.toContain('hunter2!');
    expect(raw).not.toContain('varun@x.dev');
    expect(item.hint).toBe('v•••@x.dev');
    expect(item.origin).toBe('https://shop.example.com');
    expect(vault.reveal(a, item.id, { usedOn: 'test' })).toMatchObject({ password: 'hunter2!' });
  });
  it('is isolated per user and bound to its row', () => {
    const item = vault.create(a, { kind: 'note', label: 'n', text: 'secret' });
    expect(vault.reveal(b, item.id, { usedOn: 'test' })).toBeNull();
    const other = vault.create(a, { kind: 'note', label: 'm', text: 'other' });
    vaultRows.setPayload(a, other.id, vaultRows.get(a, item.id)!.payloadEnc); // swap ciphertexts
    expect(() => vault.reveal(a, other.id, { usedOn: 'test' })).toThrow();
  });
  it('checks origins', () => {
    expect(originAllows('https://example.com', 'https://login.example.com/x')).toBe(true);
    expect(originAllows('https://example.com', 'https://example.com.evil.io/')).toBe(false);
    expect(originAllows('https://example.com', 'http://example.com/')).toBe(false);
    expect(originAllows('https://example.com', 'https://notexample.com/')).toBe(false);
    expect(() => normalizeOrigin('http://example.com')).toThrow();
  });
});

describe('approvals', () => {
  it('waits for the owner and ignores other users', async () => {
    let id = '';
    const p = requestApproval({ userId: a, threadId: null, kind: 'purchase', summary: 'Buy', onCreated: (x) => (id = x.id) });
    expect(resolveApproval(b, id, 'approve')).toBeNull();
    expect(resolveApproval(a, id, 'deny')!.status).toBe('denied');
    expect(resolveApproval(a, id, 'approve')).toBeNull(); // no double decision
    expect((await p).decision).toBe('denied');
  });
  it('auto-approves only when the user opted in, and expires on abort', async () => {
    users.update(a, { settings: { autoApprove: { other: true } as any } });
    expect((await requestApproval({ userId: a, threadId: null, kind: 'other', summary: 's' })).decision).toBe('approved');
    const ac = new AbortController();
    const p = requestApproval({ userId: a, threadId: null, kind: 'purchase', summary: 's', signal: ac.signal });
    ac.abort();
    expect((await p).decision).toBe('expired');
  });
});

describe('ownership', () => {
  it('scopes threads, messages and cascades deletes', () => {
    const t = threads.main(a);
    messages.append({ userId: a, threadId: t.id, role: 'user', api: { role: 'user', content: 'hi' }, parts: [{ type: 'text', id: 'p', text: 'hi' }] });
    expect(threads.get(b, t.id)).toBeNull();
    expect(messages.list(b, t.id).messages).toHaveLength(0);
    expect(messages.list(a, t.id).messages).toHaveLength(1);
    const p = projects.create(a, 'Trip');
    expect(p.threadId).toBeTruthy();
    users.delete(a);
    expect(db().prepare('SELECT COUNT(*) n FROM messages').get()).toMatchObject({ n: 0 });
    expect(db().prepare('SELECT COUNT(*) n FROM threads WHERE user_id=?').get(a)).toMatchObject({ n: 0 });
  });
});

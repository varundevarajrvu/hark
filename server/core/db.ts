import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { config, ensureDataDir } from './config.ts';
import type {
  ActionItem, ActionStatus, Approval, ApprovalKind, ApprovalStatus, AuditEntry, ChatMessage, HandoffRun,
  HandoffStep, Id, Memory, MessagePart, Panel, Project, ScheduledTask, Specialty, Thread, ThreadKind, User,
  UserSettings, VaultItem, VaultKind,
} from '../../shared/types.ts';

// ───────────────────────── connection + schema ─────────────────────────

let _db: DatabaseSync | null = null;

/** The shared connection. Use it directly for queries this module does not cover. */
export function db(): DatabaseSync {
  if (_db) return _db;
  const file = config.dataDir === ':memory:' ? ':memory:' : path.join(ensureDataDir(), 'vector.db');
  _db = new DatabaseSync(file);
  _db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  _db.exec(SCHEMA);
  // Approvals and runs cannot survive a restart: their waiters lived in memory.
  _db.exec(`UPDATE approvals SET status='expired', resolved_at=datetime('now') WHERE status='pending';
            UPDATE handoff_runs SET status='failed', result='Interrupted by a server restart.', ended_at=datetime('now')
              WHERE status IN ('running','waiting_approval');
            UPDATE actions SET status='open' WHERE status='running';`);
  return _db;
}

/** Open a fresh in-memory database (tests). */
export function resetDbForTests(): void {
  _db?.close();
  _db = new DatabaseSync(':memory:');
  _db.exec('PRAGMA foreign_keys = ON;');
  _db.exec(SCHEMA);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, vault_salt BLOB NOT NULL, settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS threads_user ON threads(user_id, kind);
-- One row per conversation message. api_json is the exact Messages API message (role + content
-- blocks) replayed to the model, append-only and never edited. parts_json is what the UI shows;
-- NULL parts = hidden plumbing (tool results).
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, api_json TEXT, parts_json TEXT, source TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, seq);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS memories_user ON memories(user_id);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verb TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2, status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS actions_user ON actions(user_id, status);
CREATE TABLE IF NOT EXISTS panels (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', html TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT NOT NULL, timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, last_status TEXT, next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS specialties (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Secret columns hold AES-256-GCM ciphertext only (see vault.ts).
CREATE TABLE IF NOT EXISTS vault_items (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, label TEXT NOT NULL, origin TEXT NOT NULL DEFAULT '', hint TEXT NOT NULL DEFAULT '',
  payload_enc TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_user ON approvals(user_id, status);
CREATE TABLE IF NOT EXISTS handoff_runs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT, goal TEXT NOT NULL, status TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]', result TEXT, screenshot_version INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), ended_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS audit_user ON audit_log(user_id, seq);
CREATE TABLE IF NOT EXISTS usage (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ───────────────────────── helpers ─────────────────────────

export function newId(prefix: string): Id {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}
type Row = Record<string, any>;
const iso = (s: string | null): string | null =>
  s == null ? null : s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
const all = (sql: string, ...p: any[]) => db().prepare(sql).all(...p) as Row[];
const get = (sql: string, ...p: any[]) => db().prepare(sql).get(...p) as Row | undefined;
const run = (sql: string, ...p: any[]) => db().prepare(sql).run(...p);

export function transaction<T>(fn: () => T): T {
  db().exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db().exec('COMMIT');
    return out;
  } catch (e) {
    db().exec('ROLLBACK');
    throw e;
  }
}

// ───────────────────────── users + sessions ─────────────────────────

export const DEFAULT_SETTINGS: UserSettings = {
  memoryEnabled: true,
  autoApprove: { purchase: false, send_message: false, share_personal_info: false, account_change: false, vault_use: false, other: false },
  timezone: 'UTC',
};

function toUser(r: Row): User {
  const saved = JSON.parse(r.settings_json) as Partial<UserSettings>;
  return {
    id: r.id, email: r.email, name: r.name, createdAt: iso(r.created_at)!,
    settings: { ...DEFAULT_SETTINGS, ...saved, autoApprove: { ...DEFAULT_SETTINGS.autoApprove, ...(saved.autoApprove ?? {}) } },
  };
}

export const users = {
  /** Creates the user and their permanent main thread. */
  create(input: { email: string; name: string; passwordHash: string; timezone?: string }): User {
    const id = newId('usr');
    return transaction(() => {
      run('INSERT INTO users (id,email,name,password_hash,vault_salt,settings_json) VALUES (?,?,?,?,?,?)',
        id, input.email.trim().toLowerCase(), input.name.trim(), input.passwordHash, randomBytes(16),
        JSON.stringify({ ...DEFAULT_SETTINGS, timezone: input.timezone ?? 'UTC' }));
      run('INSERT INTO threads (id,user_id,kind,title) VALUES (?,?,?,?)', newId('thr'), id, 'main', 'Main');
      return users.get(id)!;
    });
  },
  get(id: Id): User | null {
    const r = get('SELECT * FROM users WHERE id=?', id);
    return r ? toUser(r) : null;
  },
  getAuthByEmail(email: string): { user: User; passwordHash: string } | null {
    const r = get('SELECT * FROM users WHERE email=?', email.trim().toLowerCase());
    return r ? { user: toUser(r), passwordHash: r.password_hash } : null;
  },
  passwordHash(id: Id): string | null {
    return (get('SELECT password_hash FROM users WHERE id=?', id)?.password_hash as string) ?? null;
  },
  vaultSalt(id: Id): Buffer | null {
    const r = get('SELECT vault_salt FROM users WHERE id=?', id);
    return r ? Buffer.from(r.vault_salt) : null;
  },
  update(id: Id, patch: { name?: string; settings?: Partial<UserSettings> }): User {
    const cur = users.get(id);
    if (!cur) throw new Error('user not found');
    const settings: UserSettings = {
      ...cur.settings, ...(patch.settings ?? {}),
      autoApprove: { ...cur.settings.autoApprove, ...(patch.settings?.autoApprove ?? {}) },
    };
    run('UPDATE users SET name=?, settings_json=? WHERE id=?', patch.name?.trim() || cur.name, JSON.stringify(settings), id);
    return users.get(id)!;
  },
  /** Erases the account and, by cascade, every row that belongs to it. */
  delete(id: Id): void {
    run('DELETE FROM users WHERE id=?', id);
  },
  count(): number {
    return Number(get('SELECT COUNT(*) AS n FROM users')!.n);
  },
  allIds(): Id[] {
    return all('SELECT id FROM users').map((r) => r.id);
  },
};

export const sessions = {
  create(tokenHash: string, userId: Id, expiresAt: Date): void {
    run('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)', tokenHash, userId, expiresAt.toISOString());
  },
  /** Returns the owning user id when the session exists and has not expired. */
  resolve(tokenHash: string): Id | null {
    const r = get('SELECT user_id, expires_at FROM sessions WHERE token_hash=?', tokenHash);
    if (!r) return null;
    if (new Date(r.expires_at).getTime() < Date.now()) {
      run('DELETE FROM sessions WHERE token_hash=?', tokenHash);
      return null;
    }
    return r.user_id;
  },
  delete(tokenHash: string): void {
    run('DELETE FROM sessions WHERE token_hash=?', tokenHash);
  },
  deleteAllFor(userId: Id): void {
    run('DELETE FROM sessions WHERE user_id=?', userId);
  },
};

// ───────────────────────── threads + messages ─────────────────────────

const toThread = (r: Row): Thread => ({ id: r.id, kind: r.kind, title: r.title, projectId: r.project_id ?? null, createdAt: iso(r.created_at)! });

export const threads = {
  main(userId: Id): Thread {
    return toThread(get("SELECT * FROM threads WHERE user_id=? AND kind='main'", userId)!);
  },
  /** Ownership-checked lookup: returns null for another user's thread. */
  get(userId: Id, id: Id): Thread | null {
    const r = get('SELECT * FROM threads WHERE id=? AND user_id=?', id, userId);
    return r ? toThread(r) : null;
  },
  create(userId: Id, kind: ThreadKind, title: string, projectId: Id | null = null): Thread {
    const id = newId('thr');
    run('INSERT INTO threads (id,user_id,kind,title,project_id) VALUES (?,?,?,?,?)', id, userId, kind, title, projectId);
    return threads.get(userId, id)!;
  },
  project(userId: Id, threadId: Id): Project | null {
    const r = get('SELECT p.*, t.id AS thread_id FROM threads t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND t.user_id=?', threadId, userId);
    return r ? toProject(r) : null;
  },
};

function toMessage(r: Row): ChatMessage {
  return {
    id: r.id, threadId: r.thread_id, role: r.role, createdAt: r.created_at,
    parts: JSON.parse(r.parts_json) as MessagePart[], ...(r.source ? { source: r.source } : {}),
  };
}

export const messages = {
  /**
   * Append one message. `api` is the Messages API message replayed to the model (null = UI only);
   * `parts` is the UI rendering (null = hidden from the UI, e.g. tool results).
   */
  append(input: { userId: Id; threadId: Id; role: 'user' | 'assistant'; api: unknown | null; parts: MessagePart[] | null; source?: ChatMessage['source']; id?: Id }): Id {
    const id = input.id ?? newId('msg');
    run('INSERT INTO messages (id,thread_id,user_id,role,api_json,parts_json,source) VALUES (?,?,?,?,?,?,?)',
      id, input.threadId, input.userId, input.role, input.api == null ? null : JSON.stringify(input.api),
      input.parts == null ? null : JSON.stringify(input.parts), input.source ?? null);
    return id;
  },
  /** Rewrite only the UI rendering of a message (e.g. a tool chip's final status). Never touches api_json. */
  setParts(id: Id, parts: MessagePart[]): void {
    run('UPDATE messages SET parts_json=? WHERE id=?', JSON.stringify(parts), id);
  },
  get(userId: Id, id: Id): ChatMessage | null {
    const r = get('SELECT * FROM messages WHERE id=? AND user_id=? AND parts_json IS NOT NULL', id, userId);
    return r ? toMessage(r) : null;
  },
  /** Visible messages, oldest → newest, paginated backwards from `before`. */
  list(userId: Id, threadId: Id, opts: { before?: Id; limit?: number } = {}): { messages: ChatMessage[]; hasMore: boolean } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const beforeSeq = opts.before ? (get('SELECT seq FROM messages WHERE id=? AND user_id=?', opts.before, userId)?.seq as number | undefined) : undefined;
    const rows = all(
      `SELECT * FROM messages WHERE thread_id=? AND user_id=? AND parts_json IS NOT NULL ${beforeSeq ? 'AND seq < ?' : ''} ORDER BY seq DESC LIMIT ?`,
      ...(beforeSeq ? [threadId, userId, beforeSeq, limit + 1] : [threadId, userId, limit + 1]));
    const hasMore = rows.length > limit;
    return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore };
  },
  /** The exact API transcript of a thread, in order, for replay to the model. */
  apiHistory(userId: Id, threadId: Id): unknown[] {
    return all('SELECT api_json FROM messages WHERE thread_id=? AND user_id=? AND api_json IS NOT NULL ORDER BY seq', threadId, userId)
      .map((r) => JSON.parse(r.api_json));
  },
};

// ───────────────────────── projects ─────────────────────────

function toProject(r: Row): Project {
  return { id: r.id, name: r.name, description: r.description, threadId: r.thread_id, createdAt: iso(r.created_at)! };
}
const PROJECT_SELECT = "SELECT p.*, (SELECT id FROM threads t WHERE t.project_id=p.id AND t.kind='project' LIMIT 1) AS thread_id FROM projects p";

export const projects = {
  list(userId: Id): Project[] {
    return all(`${PROJECT_SELECT} WHERE p.user_id=? ORDER BY p.created_at DESC`, userId).map(toProject);
  },
  get(userId: Id, id: Id): Project | null {
    const r = get(`${PROJECT_SELECT} WHERE p.id=? AND p.user_id=?`, id, userId);
    return r ? toProject(r) : null;
  },
  create(userId: Id, name: string, description = ''): Project {
    const id = newId('prj');
    return transaction(() => {
      run('INSERT INTO projects (id,user_id,name,description) VALUES (?,?,?,?)', id, userId, name.trim(), description.trim());
      run('INSERT INTO threads (id,user_id,kind,title,project_id) VALUES (?,?,?,?,?)', newId('thr'), userId, 'project', name.trim(), id);
      return projects.get(userId, id)!;
    });
  },
  update(userId: Id, id: Id, patch: { name?: string; description?: string }): Project | null {
    const cur = projects.get(userId, id);
    if (!cur) return null;
    run('UPDATE projects SET name=?, description=? WHERE id=? AND user_id=?', patch.name?.trim() || cur.name, patch.description ?? cur.description, id, userId);
    return projects.get(userId, id);
  },
  delete(userId: Id, id: Id): boolean {
    return run('DELETE FROM projects WHERE id=? AND user_id=?', id, userId).changes > 0;
  },
};

// ───────────────────────── memories ─────────────────────────

const toMemory = (r: Row): Memory => ({ id: r.id, content: r.content, category: r.category, createdAt: iso(r.created_at)! });

export const memories = {
  list(userId: Id): Memory[] {
    return all('SELECT * FROM memories WHERE user_id=? ORDER BY created_at DESC, rowid DESC', userId).map(toMemory);
  },
  create(userId: Id, content: string, category = 'general'): Memory {
    const id = newId('mem');
    run('INSERT INTO memories (id,user_id,content,category) VALUES (?,?,?,?)', id, userId, content.trim(), category.trim() || 'general');
    return toMemory(get('SELECT * FROM memories WHERE id=?', id)!);
  },
  update(userId: Id, id: Id, content: string): Memory | null {
    run('UPDATE memories SET content=? WHERE id=? AND user_id=?', content.trim(), id, userId);
    const r = get('SELECT * FROM memories WHERE id=? AND user_id=?', id, userId);
    return r ? toMemory(r) : null;
  },
  delete(userId: Id, id: Id): boolean {
    return run('DELETE FROM memories WHERE id=? AND user_id=?', id, userId).changes > 0;
  },
  deleteAll(userId: Id): void {
    run('DELETE FROM memories WHERE user_id=?', userId);
  },
};

// ───────────────────────── actions ─────────────────────────

const toAction = (r: Row): ActionItem => ({
  id: r.id, verb: r.verb, title: r.title, detail: r.detail, prompt: r.prompt, priority: r.priority, status: r.status, createdAt: iso(r.created_at)!,
});

export const actions = {
  /** Open and running buttons, most urgent first. */
  listActive(userId: Id): ActionItem[] {
    return all("SELECT * FROM actions WHERE user_id=? AND status IN ('open','running') ORDER BY priority, created_at DESC", userId).map(toAction);
  },
  get(userId: Id, id: Id): ActionItem | null {
    const r = get('SELECT * FROM actions WHERE id=? AND user_id=?', id, userId);
    return r ? toAction(r) : null;
  },
  create(userId: Id, input: { verb: string; title: string; detail?: string; prompt: string; priority?: 1 | 2 | 3 }): ActionItem {
    const id = newId('act');
    run('INSERT INTO actions (id,user_id,verb,title,detail,prompt,priority) VALUES (?,?,?,?,?,?,?)',
      id, userId, input.verb.trim(), input.title.trim(), input.detail?.trim() ?? '', input.prompt, input.priority ?? 2);
    return actions.get(userId, id)!;
  },
  setStatus(userId: Id, id: Id, status: ActionStatus): boolean {
    return run('UPDATE actions SET status=? WHERE id=? AND user_id=?', status, id, userId).changes > 0;
  },
};

// ───────────────────────── panels ─────────────────────────

const toPanel = (r: Row): Panel => ({ id: r.id, title: r.title, description: r.description, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)! });

export const panels = {
  list(userId: Id): Panel[] {
    return all('SELECT id,title,description,created_at,updated_at FROM panels WHERE user_id=? ORDER BY created_at DESC', userId).map(toPanel);
  },
  get(userId: Id, id: Id): (Panel & { html: string }) | null {
    const r = get('SELECT * FROM panels WHERE id=? AND user_id=?', id, userId);
    return r ? { ...toPanel(r), html: r.html } : null;
  },
  create(userId: Id, input: { title: string; description?: string; html: string }): Panel {
    const id = newId('pnl');
    run('INSERT INTO panels (id,user_id,title,description,html) VALUES (?,?,?,?,?)', id, userId, input.title.trim(), input.description?.trim() ?? '', input.html);
    return toPanel(get('SELECT * FROM panels WHERE id=?', id)!);
  },
  update(userId: Id, id: Id, patch: { title?: string; description?: string; html?: string }): Panel | null {
    const cur = panels.get(userId, id);
    if (!cur) return null;
    run("UPDATE panels SET title=?, description=?, html=?, updated_at=datetime('now') WHERE id=? AND user_id=?",
      patch.title?.trim() || cur.title, patch.description ?? cur.description, patch.html ?? cur.html, id, userId);
    return toPanel(get('SELECT * FROM panels WHERE id=?', id)!);
  },
  delete(userId: Id, id: Id): boolean {
    return run('DELETE FROM panels WHERE id=? AND user_id=?', id, userId).changes > 0;
  },
};

// ───────────────────────── scheduled tasks ─────────────────────────

const toTask = (r: Row): ScheduledTask => ({
  id: r.id, title: r.title, prompt: r.prompt, cron: r.cron, timezone: r.timezone, enabled: !!r.enabled,
  lastRunAt: iso(r.last_run_at), lastStatus: r.last_status ?? null, nextRunAt: iso(r.next_run_at), createdAt: iso(r.created_at)!,
});

export const tasks = {
  list(userId: Id): ScheduledTask[] {
    return all('SELECT * FROM tasks WHERE user_id=? ORDER BY created_at DESC', userId).map(toTask);
  },
  get(userId: Id, id: Id): ScheduledTask | null {
    const r = get('SELECT * FROM tasks WHERE id=? AND user_id=?', id, userId);
    return r ? toTask(r) : null;
  },
  create(userId: Id, input: { title: string; prompt: string; cron: string; timezone: string; enabled?: boolean; nextRunAt?: string | null }): ScheduledTask {
    const id = newId('tsk');
    run('INSERT INTO tasks (id,user_id,title,prompt,cron,timezone,enabled,next_run_at) VALUES (?,?,?,?,?,?,?,?)',
      id, userId, input.title.trim(), input.prompt, input.cron.trim(), input.timezone, input.enabled === false ? 0 : 1, input.nextRunAt ?? null);
    return tasks.get(userId, id)!;
  },
  update(userId: Id, id: Id, patch: Partial<{ title: string; prompt: string; cron: string; timezone: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string; lastStatus: 'ok' | 'error' }>): ScheduledTask | null {
    const cur = tasks.get(userId, id);
    if (!cur) return null;
    run('UPDATE tasks SET title=?, prompt=?, cron=?, timezone=?, enabled=?, next_run_at=?, last_run_at=?, last_status=? WHERE id=? AND user_id=?',
      patch.title ?? cur.title, patch.prompt ?? cur.prompt, patch.cron ?? cur.cron, patch.timezone ?? cur.timezone,
      (patch.enabled ?? cur.enabled) ? 1 : 0, patch.nextRunAt === undefined ? cur.nextRunAt : patch.nextRunAt,
      patch.lastRunAt ?? cur.lastRunAt, patch.lastStatus ?? cur.lastStatus, id, userId);
    return tasks.get(userId, id);
  },
  delete(userId: Id, id: Id): boolean {
    return run('DELETE FROM tasks WHERE id=? AND user_id=?', id, userId).changes > 0;
  },
  /** Every enabled task of every user, for the scheduler. */
  allEnabled(): Array<ScheduledTask & { userId: Id }> {
    return all('SELECT * FROM tasks WHERE enabled=1').map((r) => ({ ...toTask(r), userId: r.user_id }));
  },
};

// ───────────────────────── specialties ─────────────────────────

const toSpecialty = (r: Row): Specialty => ({ id: r.id, name: r.name, description: r.description, steps: r.steps, createdAt: iso(r.created_at)! });

export const specialties = {
  list(userId: Id): Specialty[] {
    return all('SELECT * FROM specialties WHERE user_id=? ORDER BY name', userId).map(toSpecialty);
  },
  /** Create, or replace the one with the same name. */
  upsert(userId: Id, input: { name: string; description?: string; steps: string }): Specialty {
    const existing = get('SELECT id FROM specialties WHERE user_id=? AND name=? COLLATE NOCASE', userId, input.name.trim());
    const id = (existing?.id as string) ?? newId('spc');
    if (existing) run('UPDATE specialties SET description=?, steps=? WHERE id=?', input.description?.trim() ?? '', input.steps, id);
    else run('INSERT INTO specialties (id,user_id,name,description,steps) VALUES (?,?,?,?,?)', id, userId, input.name.trim(), input.description?.trim() ?? '', input.steps);
    return toSpecialty(get('SELECT * FROM specialties WHERE id=?', id)!);
  },
  delete(userId: Id, id: Id): boolean {
    return run('DELETE FROM specialties WHERE id=? AND user_id=?', id, userId).changes > 0;
  },
};

// ───────────────────────── vault rows (ciphertext only; use vault.ts) ─────────────────────────

const toVaultItem = (r: Row): VaultItem => ({ id: r.id, kind: r.kind, label: r.label, origin: r.origin, hint: r.hint, createdAt: iso(r.created_at)! });

export const vaultRows = {
  list(userId: Id): VaultItem[] {
    return all('SELECT id,kind,label,origin,hint,created_at FROM vault_items WHERE user_id=? ORDER BY label', userId).map(toVaultItem);
  },
  get(userId: Id, id: Id): (VaultItem & { payloadEnc: string }) | null {
    const r = get('SELECT * FROM vault_items WHERE id=? AND user_id=?', id, userId);
    return r ? { ...toVaultItem(r), payloadEnc: r.payload_enc } : null;
  },
  insert(userId: Id, input: { kind: VaultKind; label: string; origin: string; hint: string; payloadEnc: string }): VaultItem {
    const id = newId('vlt');
    run('INSERT INTO vault_items (id,user_id,kind,label,origin,hint,payload_enc) VALUES (?,?,?,?,?,?,?)', id, userId, input.kind, input.label.trim(), input.origin, input.hint, input.payloadEnc);
    return toVaultItem(get('SELECT * FROM vault_items WHERE id=?', id)!);
  },
  setPayload(userId: Id, id: Id, payloadEnc: string): void {
    run('UPDATE vault_items SET payload_enc=? WHERE id=? AND user_id=?', payloadEnc, id, userId);
  },
  delete(userId: Id, id: Id): boolean {
    return run('DELETE FROM vault_items WHERE id=? AND user_id=?', id, userId).changes > 0;
  },
};

// ───────────────────────── approvals (rows; use approvals.ts to wait on them) ─────────────────────────

const toApproval = (r: Row): Approval => ({
  id: r.id, threadId: r.thread_id ?? null, kind: r.kind, summary: r.summary, detail: JSON.parse(r.detail_json),
  status: r.status, createdAt: r.created_at, resolvedAt: iso(r.resolved_at),
});

export const approvalRows = {
  list(userId: Id, status?: ApprovalStatus): Approval[] {
    return (status
      ? all('SELECT * FROM approvals WHERE user_id=? AND status=? ORDER BY created_at DESC LIMIT 200', userId, status)
      : all('SELECT * FROM approvals WHERE user_id=? ORDER BY created_at DESC LIMIT 200', userId)).map(toApproval);
  },
  get(userId: Id, id: Id): Approval | null {
    const r = get('SELECT * FROM approvals WHERE id=? AND user_id=?', id, userId);
    return r ? toApproval(r) : null;
  },
  insert(userId: Id, input: { threadId: Id | null; kind: ApprovalKind; summary: string; detail: Record<string, string>; status?: ApprovalStatus }): Approval {
    const id = newId('apr');
    const status = input.status ?? 'pending';
    run(`INSERT INTO approvals (id,user_id,thread_id,kind,summary,detail_json,status,resolved_at) VALUES (?,?,?,?,?,?,?,${status === 'pending' ? 'NULL' : "datetime('now')"})`,
      id, userId, input.threadId, input.kind, input.summary, JSON.stringify(input.detail), status);
    return approvalRows.get(userId, id)!;
  },
  /** Moves a pending approval to a final state. Returns null if it was not pending (no double decisions). */
  resolve(userId: Id, id: Id, status: Exclude<ApprovalStatus, 'pending'>): Approval | null {
    const res = run("UPDATE approvals SET status=?, resolved_at=datetime('now') WHERE id=? AND user_id=? AND status='pending'", status, id, userId);
    return res.changes > 0 ? approvalRows.get(userId, id) : null;
  },
};

// ───────────────────────── handoff runs ─────────────────────────

const toRun = (r: Row): HandoffRun => ({
  id: r.id, threadId: r.thread_id ?? null, goal: r.goal, status: r.status, url: r.url, steps: JSON.parse(r.steps_json) as HandoffStep[],
  result: r.result ?? null, screenshotVersion: r.screenshot_version, startedAt: r.started_at, endedAt: iso(r.ended_at),
});

export const handoffRuns = {
  create(userId: Id, threadId: Id | null, goal: string): HandoffRun {
    const id = newId('hnd');
    run("INSERT INTO handoff_runs (id,user_id,thread_id,goal,status) VALUES (?,?,?,?,'running')", id, userId, threadId, goal);
    return handoffRuns.get(userId, id)!;
  },
  get(userId: Id, id: Id): HandoffRun | null {
    const r = get('SELECT * FROM handoff_runs WHERE id=? AND user_id=?', id, userId);
    return r ? toRun(r) : null;
  },
  update(userId: Id, id: Id, patch: Partial<Pick<HandoffRun, 'status' | 'url' | 'steps' | 'result' | 'screenshotVersion'>> & { ended?: boolean }): HandoffRun | null {
    const cur = handoffRuns.get(userId, id);
    if (!cur) return null;
    run(`UPDATE handoff_runs SET status=?, url=?, steps_json=?, result=?, screenshot_version=?${patch.ended ? ", ended_at=datetime('now')" : ''} WHERE id=? AND user_id=?`,
      patch.status ?? cur.status, patch.url ?? cur.url, JSON.stringify(patch.steps ?? cur.steps), patch.result ?? cur.result,
      patch.screenshotVersion ?? cur.screenshotVersion, id, userId);
    return handoffRuns.get(userId, id);
  },
};

// ───────────────────────── audit + usage ─────────────────────────

/** Append-only record of everything sensitive: sign-ins, vault use, approvals, browser actions. Never log secrets. */
export function audit(userId: Id, event: string, detail: Record<string, unknown> = {}): void {
  run('INSERT INTO audit_log (id,user_id,event,detail_json) VALUES (?,?,?,?)', newId('aud'), userId, event, JSON.stringify(detail));
}
export function listAudit(userId: Id, limit = 100): AuditEntry[] {
  return all('SELECT * FROM audit_log WHERE user_id=? ORDER BY seq DESC LIMIT ?', userId, Math.min(Math.max(limit, 1), 500))
    .map((r) => ({ id: r.id, event: r.event, detail: JSON.parse(r.detail_json), at: r.at }));
}
export function recordUsage(userId: Id, threadId: Id | null, model: string, inputTokens: number, outputTokens: number): void {
  run('INSERT INTO usage (user_id,thread_id,model,input_tokens,output_tokens) VALUES (?,?,?,?,?)', userId, threadId, model, inputTokens, outputTokens);
}

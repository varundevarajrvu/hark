/**
 * Shared contract between the server and the web client.
 * Everything that crosses the HTTP/SSE boundary is typed here. Import with `import type`.
 */

export type Id = string;
export type IsoTime = string;

// ───────────────────────── Entities (DTOs) ─────────────────────────

export type ApprovalKind =
  | 'purchase' // spending money
  | 'send_message' // email / form / message sent to a third party in the user's name
  | 'share_personal_info' // personal data submitted to a third party
  | 'account_change' // cancel / sign up / change settings on an external account
  | 'vault_use' // using a saved login or card on a page
  | 'other';

export const APPROVAL_KINDS: ApprovalKind[] = [
  'purchase',
  'send_message',
  'share_personal_info',
  'account_change',
  'vault_use',
  'other',
];

export interface UserSettings {
  /** When false the agent neither reads nor writes memories. */
  memoryEnabled: boolean;
  /** Per-kind opt-out of the confirmation prompt. All false by default (default to consent). */
  autoApprove: Record<ApprovalKind, boolean>;
  /** IANA zone used for scheduled tasks and for telling the agent the local time. */
  timezone: string;
}

export interface User {
  id: Id;
  email: string;
  name: string;
  createdAt: IsoTime;
  settings: UserSettings;
}

export type ThreadKind = 'main' | 'project' | 'task';

export interface Thread {
  id: Id;
  kind: ThreadKind;
  title: string;
  projectId: Id | null;
  createdAt: IsoTime;
}

export type ToolStatus = 'running' | 'done' | 'error' | 'denied';

/** What the UI renders inside one chat message, in order. */
export type MessagePart =
  | { type: 'text'; id: Id; text: string }
  | { type: 'tool'; id: Id; name: string; label: string; status: ToolStatus; summary?: string }
  | { type: 'approval'; id: Id; approvalId: Id }
  | { type: 'handoff'; id: Id; runId: Id }
  | { type: 'notice'; id: Id; tone: 'info' | 'error'; text: string };

export interface ChatMessage {
  id: Id;
  threadId: Id;
  role: 'user' | 'assistant';
  createdAt: IsoTime;
  parts: MessagePart[];
  /** Where a user-role message came from. */
  source?: 'user' | 'action' | 'task' | 'panel';
}

export interface Project {
  id: Id;
  name: string;
  description: string;
  threadId: Id;
  createdAt: IsoTime;
}

export type ActionStatus = 'open' | 'running' | 'done' | 'dismissed';

/** An Action Button: a suggested one-tap to-do the agent can carry out start to finish. */
export interface ActionItem {
  id: Id;
  /** Short verb shown on the button: "Pay", "Cancel", "Reply", "Book"… */
  verb: string;
  title: string;
  detail: string;
  /** The instruction the agent receives when the button is pressed. */
  prompt: string;
  priority: 1 | 2 | 3; // 1 = highest
  status: ActionStatus;
  createdAt: IsoTime;
}

/** A Panel: a small self-contained HTML app generated from a description, shown on Home. */
export interface Panel {
  id: Id;
  title: string;
  description: string;
  /** Rendered only inside a sandboxed iframe via GET /api/panels/:id/frame. */
  updatedAt: IsoTime;
  createdAt: IsoTime;
}

export interface ScheduledTask {
  id: Id;
  title: string;
  prompt: string;
  /** Standard 5-field cron expression, evaluated in `timezone`. */
  cron: string;
  timezone: string;
  enabled: boolean;
  lastRunAt: IsoTime | null;
  lastStatus: 'ok' | 'error' | null;
  nextRunAt: IsoTime | null;
  createdAt: IsoTime;
}

/** A Specialty: a named multi-step workflow the agent has memorised and can repeat. */
export interface Specialty {
  id: Id;
  name: string;
  description: string;
  steps: string;
  createdAt: IsoTime;
}

export interface Memory {
  id: Id;
  content: string;
  category: string;
  createdAt: IsoTime;
}

export type VaultKind = 'login' | 'card' | 'note';

/** Vault metadata only. Secret material never leaves the server and is never shown to the model. */
export interface VaultItem {
  id: Id;
  kind: VaultKind;
  label: string;
  /** Origin the secret may be used on, e.g. "https://example.com". Empty for notes. */
  origin: string;
  /** Masked hint, e.g. "v•••@gmail.com" or "•••• 4242". */
  hint: string;
  createdAt: IsoTime;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface Approval {
  id: Id;
  threadId: Id | null;
  kind: ApprovalKind;
  /** One line: what will happen if approved. */
  summary: string;
  /** Key/value facts shown on the card (site, amount, recipient…). Never contains secrets. */
  detail: Record<string, string>;
  status: ApprovalStatus;
  createdAt: IsoTime;
  resolvedAt: IsoTime | null;
}

export type HandoffStatus = 'running' | 'waiting_approval' | 'done' | 'failed' | 'cancelled';

export interface HandoffStep {
  index: number;
  action: string; // navigate | click | type | fill_secret | read | scroll | wait | finish …
  detail: string; // human readable, secrets redacted
  at: IsoTime;
}

/** One browser-agent run ("the open kitchen": every step is visible and cancellable). */
export interface HandoffRun {
  id: Id;
  threadId: Id | null;
  goal: string;
  status: HandoffStatus;
  url: string;
  steps: HandoffStep[];
  result: string | null;
  /** Increments whenever a new screenshot is available at /api/handoff/:id/screenshot?v=N */
  screenshotVersion: number;
  startedAt: IsoTime;
  endedAt: IsoTime | null;
}

export interface AuditEntry {
  id: Id;
  event: string;
  detail: Record<string, unknown>;
  at: IsoTime;
}

export interface LlmStatus {
  model: string;
  /** True when the server runs the scripted offline model instead of the Claude API. */
  mock: boolean;
  /** False when no API credentials were found and mock mode is off. */
  configured: boolean;
}

// ───────────────────────── Server → client events (SSE) ─────────────────────────

export type ServerEvent =
  | { type: 'hello' }
  | { type: 'message.created'; threadId: Id; message: ChatMessage }
  | { type: 'run.started'; threadId: Id; runId: Id; messageId: Id }
  /** Append text to the text part `partId` of assistant message `messageId` (create it if absent). */
  | { type: 'message.delta'; threadId: Id; messageId: Id; partId: Id; text: string }
  /** Upsert a non-text part (matched by part.id) on assistant message `messageId`. */
  | { type: 'message.part'; threadId: Id; messageId: Id; part: MessagePart }
  /** Final persisted form of the assistant message; replaces the streamed one. */
  | { type: 'message.done'; threadId: Id; message: ChatMessage }
  | { type: 'run.finished'; threadId: Id; runId: Id; status: 'ok' | 'error' | 'cancelled'; error?: string }
  | { type: 'approval.requested'; approval: Approval }
  | { type: 'approval.resolved'; approval: Approval }
  | { type: 'handoff.update'; run: HandoffRun }
  /** The named collection changed; refetch it. */
  | { type: 'invalidate'; resource: 'actions' | 'panels' | 'projects' | 'tasks' | 'memories' | 'vault' | 'specialties' | 'settings' };

// ───────────────────────── REST contract ─────────────────────────
// Base path /api. JSON in, JSON out. Auth = httpOnly session cookie. Errors: { error: string } with 4xx/5xx.
//
// POST   /auth/signup            SignupBody            → { user }
// POST   /auth/login             LoginBody             → { user }
// POST   /auth/logout                                  → { ok: true }
// GET    /auth/me                                      → { user }            (401 when signed out)
// GET    /bootstrap                                    → Bootstrap
// GET    /events                                       → text/event-stream of ServerEvent (data: <json>)
//
// GET    /threads/:id/messages?before=<msgId>&limit=50 → { messages: ChatMessage[], hasMore: boolean }  (oldest→newest)
// POST   /threads/:id/messages   { text }              → 202 { runId }       (reply streams over /events)
// POST   /threads/:id/cancel                           → { ok: true }
// GET    /threads/:id/status                           → { running: boolean }
//
// GET    /projects                                     → { projects }
// POST   /projects               { name, description? }→ { project }
// PATCH  /projects/:id           { name?, description?}→ { project }
// DELETE /projects/:id                                 → { ok: true }
//
// GET    /actions                                      → { actions }         (status open|running)
// POST   /actions/:id/run                              → 202 { runId, threadId }
// POST   /actions/:id/dismiss                          → { ok: true }
//
// GET    /panels                                       → { panels }
// GET    /panels/:id/frame                             → text/html (sandboxed document, strict CSP)
// POST   /panels/:id/reply       { text }              → 202 { runId, threadId }
// DELETE /panels/:id                                   → { ok: true }
//
// GET    /tasks                                        → { tasks }
// POST   /tasks                  TaskBody              → { task }
// PATCH  /tasks/:id              Partial<TaskBody>     → { task }
// DELETE /tasks/:id                                    → { ok: true }
// POST   /tasks/:id/run                                → 202 { runId, threadId }
//
// GET    /specialties                                  → { specialties }
// DELETE /specialties/:id                              → { ok: true }
//
// GET    /memories                                     → { memories }
// POST   /memories               { content, category? }→ { memory }
// PATCH  /memories/:id           { content }           → { memory }
// DELETE /memories/:id                                 → { ok: true }
// DELETE /memories                                     → { ok: true }        (forget everything)
//
// GET    /vault                                        → { items: VaultItem[] }
// POST   /vault                  VaultCreateBody       → { item: VaultItem }
// DELETE /vault/:id                                    → { ok: true }
//
// GET    /approvals?status=pending                     → { approvals }
// POST   /approvals/:id          { decision: 'approve' | 'deny' } → { approval }
//
// GET    /handoff/:id                                  → { run: HandoffRun }
// GET    /handoff/:id/screenshot                       → image/jpeg (latest frame; 404 if none)
// POST   /handoff/:id/cancel                           → { ok: true }
//
// GET    /settings                                     → { settings }
// PATCH  /settings               Partial<UserSettings> & { name? } → { user }
// GET    /audit?limit=100                              → { entries: AuditEntry[] }
// GET    /export                                       → application/json download of all the user's data (no secrets)
// DELETE /account                { password }          → { ok: true }        (erases everything)

export interface SignupBody { email: string; password: string; name: string }
export interface LoginBody { email: string; password: string }
export interface TaskBody { title: string; prompt: string; cron: string; timezone?: string; enabled?: boolean }
export type VaultCreateBody =
  | { kind: 'login'; label: string; origin: string; username: string; password: string }
  | { kind: 'card'; label: string; number: string; expMonth: string; expYear: string; cvc: string; nameOnCard: string }
  | { kind: 'note'; label: string; text: string };

export interface Bootstrap {
  user: User;
  mainThreadId: Id;
  actions: ActionItem[];
  panels: Panel[];
  projects: Project[];
  tasks: ScheduledTask[];
  pendingApprovals: Approval[];
  llm: LlmStatus;
}

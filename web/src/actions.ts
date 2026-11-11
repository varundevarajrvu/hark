/**
 * Everything that changes the store: REST calls, and the reducer for the SSE stream.
 * Components call these functions and read the result back through `useStore`.
 */
import type {
  Approval,
  Bootstrap,
  ChatMessage,
  HandoffRun,
  Id,
  MessagePart,
  ServerEvent,
} from '../../shared/types.ts';
import { api, ApiError, errorText, setUnauthorizedHandler } from './api.ts';
import {
  emptyThread,
  getState,
  initialState,
  omit,
  patchThread,
  setState,
  toast,
  type State,
  type ThreadState,
} from './store.ts';

const isUnauthorized = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

// ───────────────────────── Session ─────────────────────────

let lastBootstrapAt = 0;

function signedOut(): void {
  stopEvents();
  wantedApprovals.clear();
  setState(() => initialState('out'));
}
setUnauthorizedHandler(signedOut);

function applyBootstrap(b: Bootstrap): void {
  lastBootstrapAt = Date.now();
  const listed = new Set(b.pendingApprovals.map((a) => a.id));
  // Approvals we believe are pending but the server no longer lists: find out what became of them.
  const stale = Object.values(getState().approvals)
    .filter((a) => a.status === 'pending' && !listed.has(a.id))
    .map((a) => a.id);
  setState((s) => {
    const approvals = { ...s.approvals };
    for (const a of b.pendingApprovals) approvals[a.id] = a;
    return {
      ...s,
      auth: 'in',
      bootError: null,
      user: b.user,
      mainThreadId: b.mainThreadId,
      llm: b.llm,
      actions: b.actions,
      panels: b.panels,
      projects: b.projects,
      tasks: b.tasks,
      approvals,
    };
  });
  if (stale.length) ensureApprovals(stale, true);
}

/** First load, and after sign-in: fetch everything Home needs, then open the event stream. */
export async function boot(): Promise<void> {
  setState((s) => (s.bootError ? { ...s, bootError: null } : s));
  try {
    applyBootstrap(await api.bootstrap());
    startEvents();
  } catch (err) {
    if (isUnauthorized(err)) return; // the 401 handler already showed the auth screen
    setState((s) => ({ ...s, bootError: errorText(err) }));
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  await api.login({ email, password });
  setState(() => initialState('loading'));
  await boot();
}

export async function signUp(name: string, email: string, password: string): Promise<void> {
  await api.signup({ name, email, password });
  setState(() => initialState('loading'));
  await boot();
}

export async function signOut(): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* signing out locally regardless */
  }
  signedOut();
}

export async function deleteAccount(password: string): Promise<void> {
  await api.deleteAccount(password);
  signedOut();
}

// ───────────────────────── Collections ─────────────────────────

export type Resource = Extract<ServerEvent, { type: 'invalidate' }>['resource'];

export async function refresh(resource: Resource): Promise<void> {
  try {
    switch (resource) {
      case 'actions': {
        const { actions } = await api.actions();
        setState((s) => ({ ...s, actions }));
        break;
      }
      case 'panels': {
        const { panels } = await api.panels();
        setState((s) => ({ ...s, panels }));
        break;
      }
      case 'projects': {
        const { projects } = await api.projects();
        setState((s) => ({ ...s, projects }));
        break;
      }
      case 'tasks': {
        const { tasks } = await api.tasks();
        setState((s) => ({ ...s, tasks }));
        break;
      }
      case 'memories': {
        const { memories } = await api.memories();
        setState((s) => ({ ...s, memories }));
        break;
      }
      case 'vault': {
        const { items } = await api.vault();
        setState((s) => ({ ...s, vault: items }));
        break;
      }
      case 'specialties': {
        const { specialties } = await api.specialties();
        setState((s) => ({ ...s, specialties }));
        break;
      }
      case 'settings': {
        const { settings } = await api.settings();
        setState((s) => (s.user ? { ...s, user: { ...s.user, settings } } : s));
        break;
      }
    }
  } catch (err) {
    if (!isUnauthorized(err)) throw err;
  }
}

/** Refetch in the background; a failure is not worth interrupting the user for. */
function refreshQuietly(resource: Resource): void {
  refresh(resource).catch(() => {});
}

// ───────────────────────── Approvals & handoff runs ─────────────────────────

const wantedApprovals = new Set<Id>();
const freshApprovals = new Map<Id, number>();
let approvalsFetch: Promise<void> | null = null;

/** Approval parts carry only an id: fetch the ones the store does not have. */
export function ensureApprovals(ids: Id[], force = false): void {
  const s = getState();
  for (const id of ids) if (force || (!s.approvals[id] && !s.approvalsGone[id])) wantedApprovals.add(id);
  if (!wantedApprovals.size || approvalsFetch) return;
  const asking = [...wantedApprovals];
  const startedAt = Date.now();
  approvalsFetch = (async () => {
    let found: Approval[] | null = null;
    try {
      found = (await api.approvals(false)).approvals;
    } catch {
      found = null;
    }
    for (const id of asking) wantedApprovals.delete(id);
    setState((st) => {
      const approvals = { ...st.approvals };
      const gone = { ...st.approvalsGone };
      const seen = new Set<Id>();
      for (const a of found ?? []) {
        seen.add(a.id);
        const local = approvals[a.id];
        // An event may have resolved it while this request was in flight: the event wins.
        if (!local || local.status === 'pending') approvals[a.id] = a;
      }
      for (const id of asking) {
        if (seen.has(id) || (freshApprovals.get(id) ?? 0) >= startedAt) continue;
        delete approvals[id];
        gone[id] = true;
      }
      return { ...st, approvals, approvalsGone: gone };
    });
  })().finally(() => {
    approvalsFetch = null;
    if (wantedApprovals.size) ensureApprovals([]);
  });
}

export async function decideApproval(id: Id, decision: 'approve' | 'deny'): Promise<void> {
  const { approval } = await api.decideApproval(id, decision);
  setState((s) => ({ ...s, approvals: { ...s.approvals, [approval.id]: approval } }));
}

const handoffFetches = new Set<Id>();
const isLive = (run: HandoffRun): boolean => run.status === 'running' || run.status === 'waiting_approval';

export function ensureHandoff(id: Id, force = false): void {
  const s = getState();
  if (handoffFetches.has(id) || (!force && (s.handoffs[id] || s.handoffsGone[id]))) return;
  handoffFetches.add(id);
  api
    .handoff(id)
    .then(({ run }) =>
      setState((st) => {
        const local = st.handoffs[id];
        // Events that arrived while fetching are newer than the fetched snapshot.
        if (local && (!isLive(local) || local.steps.length > run.steps.length) && isLive(run)) return st;
        return { ...st, handoffs: { ...st.handoffs, [id]: run } };
      }),
    )
    .catch((err: unknown) => {
      if (isUnauthorized(err) || getState().handoffs[id]) return;
      setState((st) => ({ ...st, handoffsGone: { ...st.handoffsGone, [id]: true } }));
    })
    .finally(() => handoffFetches.delete(id));
}

export async function cancelHandoff(id: Id): Promise<void> {
  await api.cancelHandoff(id);
}

function fetchReferenced(parts: MessagePart[]): void {
  const approvalIds: Id[] = [];
  for (const part of parts) {
    if (part.type === 'approval') approvalIds.push(part.approvalId);
    else if (part.type === 'handoff') ensureHandoff(part.runId);
  }
  if (approvalIds.length) ensureApprovals(approvalIds);
}

// ───────────────────────── Threads ─────────────────────────

let openThreadId: Id | null = null;
/** The thread currently on screen: refetched whenever the event stream (re)connects. */
export function setOpenThread(threadId: Id | null): void {
  openThreadId = threadId;
}

const textOf = (m: ChatMessage): string =>
  m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');

function mergeLatest(
  s: State,
  threadId: Id,
  page: { messages: ChatMessage[]; hasMore: boolean },
  running: boolean | null,
): State {
  const t = s.threads[threadId] ?? emptyThread;
  const isRunning = running ?? Boolean(s.running[threadId]);
  const localById = new Map(t.messages.map((m) => [m.id, m]));
  const fetchedIds = new Set(page.messages.map((m) => m.id));

  // Keep older pages already loaded by scrolling up, as long as the new page joins up with them.
  const first = page.messages[0];
  const joinAt = first ? t.messages.findIndex((m) => m.id === first.id) : -1;
  const older = joinAt > 0 ? t.messages.slice(0, joinAt) : [];
  const hasMore = joinAt > 0 ? t.hasMore : page.hasMore;

  let streaming = s.streaming;
  const merged = page.messages.map((m) => {
    const local = localById.get(m.id);
    if (local && isRunning && streaming[m.id]) return local; // the stream is ahead of the database
    if (streaming[m.id]) streaming = omit(streaming, m.id);
    return m;
  });

  // Messages that only exist locally: still streaming, or created after the server took its snapshot.
  const lastAt = page.messages[page.messages.length - 1]?.createdAt ?? '';
  const olderIds = new Set(older.map((m) => m.id));
  const tail: ChatMessage[] = [];
  for (const m of t.messages) {
    if (fetchedIds.has(m.id) || olderIds.has(m.id)) continue;
    if (streaming[m.id]) {
      if (isRunning) tail.push(m);
      else streaming = omit(streaming, m.id);
    } else if (m.createdAt > lastAt) tail.push(m);
  }

  const recentUserTexts = new Set(
    page.messages
      .filter((m) => m.role === 'user')
      .slice(-6)
      .map(textOf),
  );
  const pending = t.pending.filter((p) => !recentUserTexts.has(p.text));

  let runningMap = s.running;
  if (running === true && !runningMap[threadId]) runningMap = { ...runningMap, [threadId]: true };
  if (running === false) runningMap = omit(runningMap, threadId);

  const next: ThreadState = {
    ...t,
    messages: [...older, ...merged, ...tail],
    pending,
    hasMore,
    loaded: true,
    loading: false,
    error: null,
  };
  return { ...s, running: runningMap, streaming, threads: { ...s.threads, [threadId]: next } };
}

const threadFetches = new Map<Id, Promise<void>>();

/** Fetch the newest page of a thread and merge it with whatever the stream has delivered. */
export function loadThread(threadId: Id, force = false): Promise<void> {
  const inFlight = threadFetches.get(threadId);
  if (inFlight) return inFlight;
  if (getState().threads[threadId]?.loaded && !force) return Promise.resolve();
  setState((s) => patchThread(s, threadId, (t) => ({ ...t, loading: true, error: null })));
  const job = (async () => {
    try {
      const [page, status] = await Promise.all([
        api.messages(threadId),
        api.threadStatus(threadId).catch(() => null),
      ]);
      setState((s) => mergeLatest(s, threadId, page, status ? status.running : null));
      fetchReferenced(page.messages.flatMap((m) => m.parts));
    } catch (err) {
      if (isUnauthorized(err)) return;
      setState((s) => patchThread(s, threadId, (t) => ({ ...t, loading: false, error: errorText(err) })));
    } finally {
      threadFetches.delete(threadId);
    }
  })();
  threadFetches.set(threadId, job);
  return job;
}

export async function loadOlder(threadId: Id): Promise<void> {
  const t = getState().threads[threadId];
  const first = t?.messages[0];
  if (!t || !first || !t.hasMore || t.loadingOlder || t.loading) return;
  setState((s) => patchThread(s, threadId, (x) => ({ ...x, loadingOlder: true })));
  try {
    const page = await api.messages(threadId, first.id);
    setState((s) =>
      patchThread(s, threadId, (x) => {
        const known = new Set(x.messages.map((m) => m.id));
        return {
          ...x,
          messages: [...page.messages.filter((m) => !known.has(m.id)), ...x.messages],
          hasMore: page.hasMore,
          loadingOlder: false,
        };
      }),
    );
    fetchReferenced(page.messages.flatMap((m) => m.parts));
  } catch (err) {
    setState((s) => patchThread(s, threadId, (x) => ({ ...x, loadingOlder: false })));
    if (!isUnauthorized(err)) toast(`Could not load earlier messages. ${errorText(err)}`, 'error');
  }
}

export const STILL_WORKING = 'Vector is still working on the previous request. Wait for it to finish, or stop it.';
let localSeq = 0;

/** Send a user message. Resolves to null on success, or to the text of the error. */
export async function sendMessage(threadId: Id, text: string): Promise<string | null> {
  const localId = `local-${++localSeq}`;
  const wasRunning = Boolean(getState().running[threadId]);
  // Mark the thread busy before the request: the run can start (and even finish) before the 202 returns.
  setState((s) => ({
    ...patchThread(s, threadId, (t) => ({ ...t, pending: [...t.pending, { localId, text }], lastRun: null })),
    running: { ...s.running, [threadId]: true },
  }));
  try {
    await api.sendMessage(threadId, text);
    return null;
  } catch (err) {
    const conflict = err instanceof ApiError && err.status === 409;
    setState((s) => ({
      ...patchThread(s, threadId, (t) => ({ ...t, pending: t.pending.filter((p) => p.localId !== localId) })),
      running: wasRunning || conflict ? s.running : omit(s.running, threadId),
    }));
    return conflict ? STILL_WORKING : errorText(err);
  }
}

export async function cancelRun(threadId: Id): Promise<void> {
  try {
    await api.cancelThread(threadId);
  } catch (err) {
    if (!isUnauthorized(err)) toast(`Could not stop the run. ${errorText(err)}`, 'error');
  }
}

export function labelThread(threadId: Id, label: string): void {
  setState((s) => ({ ...s, threadLabels: { ...s.threadLabels, [threadId]: label } }));
}

// ───────────────────────── Server events ─────────────────────────

function upsertMessage(t: ThreadState, message: ChatMessage): ThreadState {
  const at = t.messages.findIndex((m) => m.id === message.id);
  if (at === -1) return { ...t, messages: [...t.messages, message] };
  const messages = t.messages.slice();
  messages[at] = message;
  return { ...t, messages };
}

/** Change one assistant message, creating it at the end of the thread if the stream got here first. */
function editAssistant(t: ThreadState, threadId: Id, messageId: Id, fn: (parts: MessagePart[]) => MessagePart[]): ThreadState {
  const existing = t.messages.find((m) => m.id === messageId);
  const base: ChatMessage =
    existing ?? { id: messageId, threadId, role: 'assistant', createdAt: new Date().toISOString(), parts: [] };
  return upsertMessage(t, { ...base, parts: fn(base.parts) });
}

function markStreaming(s: State, threadId: Id, messageId: Id): State {
  const streaming = s.streaming[messageId] ? s.streaming : { ...s.streaming, [messageId]: true as const };
  const running = s.running[threadId] ? s.running : { ...s.running, [threadId]: true as const };
  return streaming === s.streaming && running === s.running ? s : { ...s, streaming, running };
}

export function applyEvent(ev: ServerEvent): void {
  switch (ev.type) {
    case 'hello':
      return;

    case 'message.created':
      setState((s) =>
        patchThread(s, ev.threadId, (t) => {
          let pending = t.pending;
          if (ev.message.role === 'user' && pending.length) {
            const text = textOf(ev.message);
            const at = pending.findIndex((p) => p.text === text);
            if (at !== -1) pending = pending.filter((_, i) => i !== at);
          }
          return { ...upsertMessage(t, ev.message), pending };
        }),
      );
      fetchReferenced(ev.message.parts);
      return;

    case 'run.started':
      setState((s) =>
        markStreaming(
          patchThread(s, ev.threadId, (t) => ({
            ...editAssistant(t, ev.threadId, ev.messageId, (parts) => parts),
            lastRun: null,
          })),
          ev.threadId,
          ev.messageId,
        ),
      );
      return;

    case 'message.delta':
      setState((s) =>
        markStreaming(
          patchThread(s, ev.threadId, (t) =>
            editAssistant(t, ev.threadId, ev.messageId, (parts) => {
              const at = parts.findIndex((p) => p.id === ev.partId && p.type === 'text');
              if (at === -1) return [...parts, { type: 'text', id: ev.partId, text: ev.text }];
              const next = parts.slice();
              const part = next[at];
              if (part?.type === 'text') next[at] = { ...part, text: part.text + ev.text };
              return next;
            }),
          ),
          ev.threadId,
          ev.messageId,
        ),
      );
      return;

    case 'message.part':
      setState((s) =>
        markStreaming(
          patchThread(s, ev.threadId, (t) =>
            editAssistant(t, ev.threadId, ev.messageId, (parts) => {
              const at = parts.findIndex((p) => p.id === ev.part.id);
              if (at === -1) return [...parts, ev.part];
              const next = parts.slice();
              next[at] = ev.part;
              return next;
            }),
          ),
          ev.threadId,
          ev.messageId,
        ),
      );
      fetchReferenced([ev.part]);
      return;

    case 'message.done':
      setState((s) => ({
        ...patchThread(s, ev.threadId, (t) => upsertMessage(t, ev.message)),
        streaming: omit(s.streaming, ev.message.id),
      }));
      fetchReferenced(ev.message.parts);
      return;

    case 'run.finished':
      setState((s) => {
        const t = s.threads[ev.threadId] ?? emptyThread;
        let streaming = s.streaming;
        for (const m of t.messages) streaming = omit(streaming, m.id);
        // A run that ended before saying anything leaves an empty placeholder behind: drop it.
        const messages = t.messages.filter((m) => m.role === 'user' || m.parts.length > 0);
        const next: ThreadState = {
          ...t,
          messages: messages.length === t.messages.length ? t.messages : messages,
          lastRun: ev.status === 'ok' ? null : { status: ev.status, error: ev.error },
        };
        return {
          ...s,
          streaming,
          running: omit(s.running, ev.threadId),
          threads: { ...s.threads, [ev.threadId]: next },
        };
      });
      return;

    case 'approval.requested':
    case 'approval.resolved':
      freshApprovals.set(ev.approval.id, Date.now());
      setState((s) => ({
        ...s,
        approvals: { ...s.approvals, [ev.approval.id]: ev.approval },
        approvalsGone: omit(s.approvalsGone, ev.approval.id),
      }));
      return;

    case 'handoff.update':
      setState((s) => ({
        ...s,
        handoffs: { ...s.handoffs, [ev.run.id]: ev.run },
        handoffsGone: omit(s.handoffsGone, ev.run.id),
      }));
      return;

    case 'invalidate': {
      const s = getState();
      // Collections that are only loaded by their own page are refetched only once that page has asked for them.
      if (ev.resource === 'memories' && s.memories === null) return;
      if (ev.resource === 'vault' && s.vault === null) return;
      if (ev.resource === 'specialties' && s.specialties === null) return;
      refreshQuietly(ev.resource);
      return;
    }
  }
}

// ───────────────────────── Event stream ─────────────────────────

let source: EventSource | null = null;
let retryCount = 0;
let retryTimer = 0;

/** After every (re)connect: refetch what the stream may have skipped while it was down. */
async function resync(): Promise<void> {
  if (Date.now() - lastBootstrapAt > 1500) {
    try {
      applyBootstrap(await api.bootstrap());
    } catch {
      return; // 401 → auth screen; anything else → the next reconnect tries again
    }
  }
  const s = getState();
  if (s.auth !== 'in') return;
  // Threads that are not on screen are refetched when they are next opened.
  setState((st) => {
    const threads: Record<Id, ThreadState> = {};
    for (const [id, t] of Object.entries(st.threads)) threads[id] = id === openThreadId ? t : { ...t, loaded: false };
    return { ...st, threads, approvalsGone: {}, handoffsGone: {} };
  });
  if (openThreadId) void loadThread(openThreadId, true);
  for (const run of Object.values(s.handoffs)) if (isLive(run)) ensureHandoff(run.id, true);
  if (s.memories !== null) refreshQuietly('memories');
  if (s.vault !== null) refreshQuietly('vault');
  if (s.specialties !== null) refreshQuietly('specialties');
}

function connect(): void {
  window.clearTimeout(retryTimer);
  setState((s) => (s.conn === 'open' || s.conn === 'idle' ? { ...s, conn: 'connecting' } : s));
  const es = new EventSource('/api/events'); // same origin: the session cookie goes along
  source = es;
  es.onopen = () => {
    retryCount = 0;
    setState((s) => ({ ...s, conn: 'open' }));
    void resync();
  };
  es.onmessage = (e: MessageEvent<string>) => {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(e.data) as ServerEvent;
    } catch {
      return;
    }
    if (ev && typeof ev === 'object' && typeof ev.type === 'string') applyEvent(ev);
  };
  es.onerror = () => {
    if (source !== es) return;
    // Take over from the browser's own retry so a signed-out session is noticed and the backoff is ours.
    es.close();
    source = null;
    setState((s) => ({ ...s, conn: 'down' }));
    const delay = Math.min(15_000, 1000 * 2 ** retryCount++);
    retryTimer = window.setTimeout(() => void reconnect(), delay);
  };
}

async function reconnect(): Promise<void> {
  window.clearTimeout(retryTimer);
  if (source || getState().auth !== 'in') return;
  try {
    await api.me(); // a 401 here signs the app out instead of retrying forever
  } catch (err) {
    if (isUnauthorized(err)) return;
  }
  if (!source && getState().auth === 'in') connect();
}

export function startEvents(): void {
  if (!source) connect();
}

export function stopEvents(): void {
  window.clearTimeout(retryTimer);
  source?.close();
  source = null;
  retryCount = 0;
}

function wake(): void {
  if (document.visibilityState === 'visible' && !source && getState().auth === 'in') void reconnect();
}
document.addEventListener('visibilitychange', wake);
window.addEventListener('online', wake);

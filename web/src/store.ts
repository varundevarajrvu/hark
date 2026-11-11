import { useSyncExternalStore } from 'react';
import type {
  ActionItem,
  Approval,
  ChatMessage,
  HandoffRun,
  Id,
  LlmStatus,
  Memory,
  Panel,
  Project,
  ScheduledTask,
  Specialty,
  User,
  VaultItem,
} from '../../shared/types.ts';

/** A message the user just sent that the server has not echoed back yet. */
export interface PendingMessage {
  localId: string;
  text: string;
}

export interface ThreadState {
  messages: ChatMessage[];
  pending: PendingMessage[];
  hasMore: boolean;
  /** True once the newest page has been fetched at least once. */
  loaded: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  /** How the last run in this thread ended, when it did not end well. */
  lastRun: { status: 'error' | 'cancelled'; error?: string } | null;
}

export interface Toast {
  id: number;
  tone: 'info' | 'error';
  text: string;
  href?: string;
  hrefLabel?: string;
}

export interface State {
  auth: 'loading' | 'out' | 'in';
  /** Set when the first bootstrap fails for a reason other than being signed out. */
  bootError: string | null;
  user: User | null;
  mainThreadId: Id | null;
  llm: LlmStatus | null;
  actions: ActionItem[];
  panels: Panel[];
  projects: Project[];
  tasks: ScheduledTask[];
  /** Loaded on demand by their pages; null = not fetched yet. */
  memories: Memory[] | null;
  vault: VaultItem[] | null;
  specialties: Specialty[] | null;
  approvals: Record<Id, Approval>;
  /** Approval ids the server no longer lists (resolved long ago, or expired). */
  approvalsGone: Record<Id, true>;
  handoffs: Record<Id, HandoffRun>;
  handoffsGone: Record<Id, true>;
  threads: Record<Id, ThreadState>;
  /** Threads with a run in flight. */
  running: Record<Id, true>;
  /** Assistant messages still being streamed. */
  streaming: Record<Id, true>;
  /** Labels for threads that are neither main nor a project (task and action runs). */
  threadLabels: Record<Id, string>;
  conn: 'idle' | 'connecting' | 'open' | 'down';
  trayOpen: boolean;
  toasts: Toast[];
}

export const emptyThread: ThreadState = {
  messages: [],
  pending: [],
  hasMore: false,
  loaded: false,
  loading: false,
  loadingOlder: false,
  error: null,
  lastRun: null,
};

export function initialState(auth: State['auth']): State {
  return {
    auth,
    bootError: null,
    user: null,
    mainThreadId: null,
    llm: null,
    actions: [],
    panels: [],
    projects: [],
    tasks: [],
    memories: null,
    vault: null,
    specialties: null,
    approvals: {},
    approvalsGone: {},
    handoffs: {},
    handoffsGone: {},
    threads: {},
    running: {},
    streaming: {},
    threadLabels: {},
    conn: 'idle',
    trayOpen: false,
    toasts: [],
  };
}

let state: State = initialState('loading');
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(update: (s: State) => State): void {
  const next = update(state);
  if (next === state) return;
  state = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Select a slice of the store. The selector must return a stable reference (a slice, not a new object). */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function patchThread(s: State, threadId: Id, fn: (t: ThreadState) => ThreadState): State {
  const current = s.threads[threadId] ?? emptyThread;
  const next = fn(current);
  return next === current ? s : { ...s, threads: { ...s.threads, [threadId]: next } };
}

export function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

export function pendingApprovals(approvals: Record<Id, Approval>): Approval[] {
  return Object.values(approvals)
    .filter((a) => a.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

let toastSeq = 0;
export function toast(text: string, tone: Toast['tone'] = 'info', link?: { href: string; label: string }): void {
  const id = ++toastSeq;
  setState((s) => ({
    ...s,
    toasts: [...s.toasts.slice(-2), { id, tone, text, href: link?.href, hrefLabel: link?.label }],
  }));
  window.setTimeout(() => dismissToast(id), tone === 'error' ? 9000 : 6000);
}

export function dismissToast(id: number): void {
  setState((s) => (s.toasts.some((t) => t.id === id) ? { ...s, toasts: s.toasts.filter((t) => t.id !== id) } : s));
}

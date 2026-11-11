import type {
  ActionItem,
  Approval,
  AuditEntry,
  Bootstrap,
  ChatMessage,
  HandoffRun,
  Id,
  LoginBody,
  Memory,
  Panel,
  Project,
  ScheduledTask,
  SignupBody,
  Specialty,
  TaskBody,
  User,
  UserSettings,
  VaultCreateBody,
  VaultItem,
} from '../../shared/types.ts';

/** An error carrying the server's `{ error }` text and the HTTP status (0 = network failure). */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
/** Called once by the store: any 401 (outside the auth forms) returns the app to the sign-in screen. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

interface RequestOptions {
  /** A 401 here is an answer ("wrong password"), not a lost session. */
  keepSession?: boolean;
}

const FALLBACK: Record<number, string> = {
  400: 'That request was not valid.',
  401: 'You are signed out.',
  403: 'That is not allowed.',
  404: 'Not found.',
  409: 'That conflicts with something already in progress.',
  413: 'That is too large.',
  429: 'Too many requests. Wait a moment and try again.',
};

async function send(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
  }
  if (res.status === 401 && !opts?.keepSession) onUnauthorized();
  if (!res.ok) {
    let message = FALLBACK[res.status] ?? `The server answered with an error (${res.status}).`;
    try {
      const data: unknown = await res.json();
      if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
        message = (data as { error: string }).error;
      }
    } catch {
      /* not JSON: keep the fallback */
    }
    throw new ApiError(message, res.status);
  }
  return res;
}

async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const res = await send(method, path, body, opts);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError('The server sent a reply that could not be read.', res.status);
  }
}

const enc = encodeURIComponent;
type Ok = { ok: true };
type Started = { runId: Id; threadId: Id };

export const api = {
  signup: (body: SignupBody) => request<{ user: User }>('POST', '/auth/signup', body, { keepSession: true }),
  login: (body: LoginBody) => request<{ user: User }>('POST', '/auth/login', body, { keepSession: true }),
  logout: () => request<Ok>('POST', '/auth/logout', undefined, { keepSession: true }),
  me: () => request<{ user: User }>('GET', '/auth/me'),
  bootstrap: () => request<Bootstrap>('GET', '/bootstrap'),

  messages: (threadId: Id, before?: Id) =>
    request<{ messages: ChatMessage[]; hasMore: boolean }>(
      'GET',
      `/threads/${enc(threadId)}/messages?limit=50${before ? `&before=${enc(before)}` : ''}`,
    ),
  sendMessage: (threadId: Id, text: string) =>
    request<{ runId: Id }>('POST', `/threads/${enc(threadId)}/messages`, { text }),
  cancelThread: (threadId: Id) => request<Ok>('POST', `/threads/${enc(threadId)}/cancel`),
  threadStatus: (threadId: Id) => request<{ running: boolean }>('GET', `/threads/${enc(threadId)}/status`),

  projects: () => request<{ projects: Project[] }>('GET', '/projects'),
  createProject: (body: { name: string; description?: string }) =>
    request<{ project: Project }>('POST', '/projects', body),
  updateProject: (id: Id, body: { name?: string; description?: string }) =>
    request<{ project: Project }>('PATCH', `/projects/${enc(id)}`, body),
  deleteProject: (id: Id) => request<Ok>('DELETE', `/projects/${enc(id)}`),

  actions: () => request<{ actions: ActionItem[] }>('GET', '/actions'),
  runAction: (id: Id) => request<Started>('POST', `/actions/${enc(id)}/run`),
  dismissAction: (id: Id) => request<Ok>('POST', `/actions/${enc(id)}/dismiss`),

  panels: () => request<{ panels: Panel[] }>('GET', '/panels'),
  replyPanel: (id: Id, text: string) => request<Started>('POST', `/panels/${enc(id)}/reply`, { text }),
  deletePanel: (id: Id) => request<Ok>('DELETE', `/panels/${enc(id)}`),

  tasks: () => request<{ tasks: ScheduledTask[] }>('GET', '/tasks'),
  createTask: (body: TaskBody) => request<{ task: ScheduledTask }>('POST', '/tasks', body),
  updateTask: (id: Id, body: Partial<TaskBody>) => request<{ task: ScheduledTask }>('PATCH', `/tasks/${enc(id)}`, body),
  deleteTask: (id: Id) => request<Ok>('DELETE', `/tasks/${enc(id)}`),
  runTask: (id: Id) => request<Started>('POST', `/tasks/${enc(id)}/run`),

  specialties: () => request<{ specialties: Specialty[] }>('GET', '/specialties'),
  deleteSpecialty: (id: Id) => request<Ok>('DELETE', `/specialties/${enc(id)}`),

  memories: () => request<{ memories: Memory[] }>('GET', '/memories'),
  createMemory: (body: { content: string; category?: string }) =>
    request<{ memory: Memory }>('POST', '/memories', body),
  updateMemory: (id: Id, content: string) => request<{ memory: Memory }>('PATCH', `/memories/${enc(id)}`, { content }),
  deleteMemory: (id: Id) => request<Ok>('DELETE', `/memories/${enc(id)}`),
  forgetEverything: () => request<Ok>('DELETE', '/memories'),

  vault: () => request<{ items: VaultItem[] }>('GET', '/vault'),
  createVaultItem: (body: VaultCreateBody) => request<{ item: VaultItem }>('POST', '/vault', body),
  deleteVaultItem: (id: Id) => request<Ok>('DELETE', `/vault/${enc(id)}`),

  /** `pendingOnly: false` asks for every status (used to resolve approval cards in old messages). */
  approvals: (pendingOnly: boolean) =>
    request<{ approvals: Approval[] }>('GET', pendingOnly ? '/approvals?status=pending' : '/approvals'),
  decideApproval: (id: Id, decision: 'approve' | 'deny') =>
    request<{ approval: Approval }>('POST', `/approvals/${enc(id)}`, { decision }),

  handoff: (id: Id) => request<{ run: HandoffRun }>('GET', `/handoff/${enc(id)}`),
  cancelHandoff: (id: Id) => request<Ok>('POST', `/handoff/${enc(id)}/cancel`),

  settings: () => request<{ settings: UserSettings }>('GET', '/settings'),
  updateSettings: (body: Partial<UserSettings> & { name?: string }) =>
    request<{ user: User }>('PATCH', '/settings', body),
  audit: (limit = 100) => request<{ entries: AuditEntry[] }>('GET', `/audit?limit=${limit}`),
  exportData: async (): Promise<Blob> => (await send('GET', '/export')).blob(),
  deleteAccount: (password: string) => request<Ok>('DELETE', '/account', { password }, { keepSession: true }),
};

export const screenshotUrl = (runId: Id, version: number): string =>
  `/api/handoff/${enc(runId)}/screenshot?v=${version}`;
export const panelFrameUrl = (panel: Panel): string =>
  `/api/panels/${enc(panel.id)}/frame?v=${enc(panel.updatedAt)}`;

export function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

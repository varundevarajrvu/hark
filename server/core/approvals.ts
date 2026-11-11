import { approvalRows, audit, users } from './db.ts';
import { publish } from './bus.ts';
import type { Approval, ApprovalKind, Id } from '../../shared/types.ts';

/**
 * The consent gate. Anything that spends money, sends something in the user's name, shares personal
 * data, changes an external account or uses a vault item must pass through `requestApproval` first.
 * The decision comes from the user through POST /api/approvals/:id — never from the model.
 */

export type Decision = 'approved' | 'denied' | 'expired';
const waiters = new Map<Id, (d: Decision) => void>();

/** Attended requests give the user this long; unattended (scheduled) ones wait a day in the inbox. */
const ATTENDED_TIMEOUT_MS = 15 * 60_000;
const UNATTENDED_TIMEOUT_MS = 24 * 60 * 60_000;

export async function requestApproval(input: {
  userId: Id;
  threadId: Id | null;
  kind: ApprovalKind;
  summary: string;
  detail?: Record<string, string>;
  signal?: AbortSignal;
  unattended?: boolean;
  /** Called with the approval row as soon as it exists (to render the card in the chat). */
  onCreated?: (approval: Approval) => void;
}): Promise<{ decision: Decision; approval: Approval }> {
  const { userId, threadId, kind, summary } = input;
  const detail = input.detail ?? {};
  const user = users.get(userId);
  if (!user) throw new Error('user not found');

  if (user.settings.autoApprove[kind]) {
    const approval = approvalRows.insert(userId, { threadId, kind, summary, detail, status: 'approved' });
    audit(userId, 'approval.auto_approved', { approvalId: approval.id, kind, summary });
    input.onCreated?.(approval);
    return { decision: 'approved', approval };
  }

  const approval = approvalRows.insert(userId, { threadId, kind, summary, detail });
  audit(userId, 'approval.requested', { approvalId: approval.id, kind, summary });
  input.onCreated?.(approval);
  publish(userId, { type: 'approval.requested', approval });

  const decision = await new Promise<Decision>((resolve) => {
    const finish = (d: Decision) => {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      waiters.delete(approval.id);
      resolve(d);
    };
    const expire = () => {
      const row = approvalRows.resolve(userId, approval.id, 'expired');
      if (row) publish(userId, { type: 'approval.resolved', approval: row });
      finish('expired');
    };
    const onAbort = () => expire();
    const timer = setTimeout(expire, input.unattended ? UNATTENDED_TIMEOUT_MS : ATTENDED_TIMEOUT_MS);
    timer.unref?.();
    if (input.signal?.aborted) return expire();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    waiters.set(approval.id, finish);
  });

  return { decision, approval: approvalRows.get(userId, approval.id)! };
}

/** Apply the user's decision. Returns null when the approval is unknown, not theirs, or already decided. */
export function resolveApproval(userId: Id, approvalId: Id, decision: 'approve' | 'deny'): Approval | null {
  const status = decision === 'approve' ? 'approved' : 'denied';
  const row = approvalRows.resolve(userId, approvalId, status);
  if (!row) return null;
  audit(userId, `approval.${status}`, { approvalId, kind: row.kind, summary: row.summary });
  publish(userId, { type: 'approval.resolved', approval: row });
  waiters.get(approvalId)?.(status);
  return row;
}

/** Expire every pending approval of a user (account deletion / cancel-all). */
export function expireAllFor(userId: Id): void {
  for (const a of approvalRows.list(userId, 'pending')) {
    const row = approvalRows.resolve(userId, a.id, 'expired');
    if (row) publish(userId, { type: 'approval.resolved', approval: row });
    waiters.get(a.id)?.('expired');
  }
}

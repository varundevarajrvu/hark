import { memo, useEffect, useRef, useState } from 'react';
import type { Approval, ApprovalKind, HandoffStatus, Id, ToolStatus } from '../../../shared/types.ts';
import { cancelHandoff, decideApproval } from '../actions.ts';
import { errorText, screenshotUrl } from '../api.ts';
import { formatDateTime, formatTime } from '../lib/format.ts';
import { threadHref } from '../router.ts';
import { useStore } from '../store.ts';
import { Dialog, ErrorNote, Icon, Spinner, type IconName } from './ui.tsx';

// ───────────────────────── Tool chip ─────────────────────────

const TOOL_STATE: Record<ToolStatus, { word: string; icon: IconName | null }> = {
  running: { word: 'Running', icon: null },
  done: { word: 'Done', icon: 'check' },
  error: { word: 'Failed', icon: 'alert' },
  denied: { word: 'Not allowed', icon: 'block' },
};

export const ToolChip = memo(function ToolChip(props: { label: string; name: string; status: ToolStatus; summary?: string }) {
  const state = TOOL_STATE[props.status];
  return (
    <div className={`tool tool-${props.status}`}>
      <span className="tool-state">
        {state.icon ? <Icon name={state.icon} size={14} /> : <Spinner />}
        <span className="sr-only">{state.word}:</span>
      </span>
      <span className="tool-label">{props.label || props.name}</span>
      {props.summary ? (
        <span className="tool-summary" title={props.summary}>
          {props.summary}
        </span>
      ) : props.status === 'running' ? (
        <span className="tool-summary">working…</span>
      ) : null}
    </div>
  );
});

// ───────────────────────── Approval card ─────────────────────────

export const APPROVAL_COPY: Record<ApprovalKind, { label: string; icon: IconName }> = {
  purchase: { label: 'Spend money', icon: 'card' },
  send_message: { label: 'Send a message', icon: 'send' },
  share_personal_info: { label: 'Share personal details', icon: 'info' },
  account_change: { label: 'Change an account', icon: 'settings' },
  vault_use: { label: 'Use a saved login or card', icon: 'vault' },
  other: { label: 'Needs your OK', icon: 'shield' },
};

const RESOLVED: Record<Exclude<Approval['status'], 'pending'>, string> = {
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired — nothing was done',
};

export function ApprovalCard({ approval, showThreadLink }: { approval: Approval; showThreadLink?: boolean }) {
  const timezone = useStore((s) => s.user?.settings.timezone);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState('');
  const copy = APPROVAL_COPY[approval.kind] ?? APPROVAL_COPY.other;
  const pending = approval.status === 'pending';
  const details = Object.entries(approval.detail ?? {});

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(decision);
    setError('');
    try {
      await decideApproval(approval.id, decision);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`approval approval-${approval.status}`} aria-label={`Approval request: ${approval.summary}`}>
      <header className="approval-head">
        <span className="approval-kind">
          <Icon name={copy.icon} size={15} />
          {copy.label}
        </span>
        <span className="approval-when">{pending ? 'Waiting for you' : formatTime(approval.resolvedAt ?? approval.createdAt, timezone)}</span>
      </header>
      <p className="approval-summary">{approval.summary}</p>
      {details.length ? (
        <dl className="kv">
          {details.map(([key, value]) => (
            <div key={key} className="kv-row">
              <dt>{key}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <ErrorNote>{error}</ErrorNote>
      {pending ? (
        <div className="approval-actions">
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void decide('approve')}>
            {busy === 'approve' ? <Spinner /> : <Icon name="check" size={16} />}
            Approve
          </button>
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void decide('deny')}>
            {busy === 'deny' ? <Spinner /> : null}
            Deny
          </button>
          {showThreadLink && approval.threadId ? (
            <a className="approval-link" href={threadHref(approval.threadId)}>
              See the conversation
            </a>
          ) : null}
          <span className="approval-hint">Nothing happens until you choose.</span>
        </div>
      ) : (
        <p className={`approval-result approval-result-${approval.status}`}>
          <Icon name={approval.status === 'approved' ? 'check' : 'block'} size={15} />
          {RESOLVED[approval.status]}
        </p>
      )}
    </section>
  );
}

export function ApprovalPart({ approvalId }: { approvalId: Id }) {
  const approval = useStore((s) => s.approvals[approvalId]);
  const gone = useStore((s) => s.approvalsGone[approvalId]);
  if (approval) return <ApprovalCard approval={approval} />;
  return (
    <div className="card-placeholder">
      {gone ? (
        <>
          <Icon name="shield" size={15} /> This approval request is no longer open.
        </>
      ) : (
        <>
          <Spinner /> Loading approval request…
        </>
      )}
    </div>
  );
}

// ───────────────────────── Handoff card ─────────────────────────

const HANDOFF_STATE: Record<HandoffStatus, string> = {
  running: 'Working in the browser',
  waiting_approval: 'Paused — waiting for your approval',
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

export function HandoffPart({ runId }: { runId: Id }) {
  const run = useStore((s) => s.handoffs[runId]);
  const gone = useStore((s) => s.handoffsGone[runId]);
  const timezone = useStore((s) => s.user?.settings.timezone);
  const [zoomed, setZoomed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [brokenVersion, setBrokenVersion] = useState(-1);
  const stepsRef = useRef<HTMLOListElement>(null);
  const stepCount = run?.steps.length ?? 0;

  useEffect(() => {
    const list = stepsRef.current;
    if (list) list.scrollTop = list.scrollHeight; // keep the newest step in view
  }, [stepCount]);

  if (!run) {
    return (
      <div className="card-placeholder">
        {gone ? (
          <>
            <Icon name="globe" size={15} /> This browser session is no longer available.
          </>
        ) : (
          <>
            <Spinner /> Loading browser session…
          </>
        )}
      </div>
    );
  }

  const live = run.status === 'running' || run.status === 'waiting_approval';
  const hasShot = run.screenshotVersion > 0 && brokenVersion !== run.screenshotVersion;
  const shot = screenshotUrl(run.id, run.screenshotVersion);

  const cancel = async () => {
    setCancelling(true);
    setError('');
    try {
      await cancelHandoff(run.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section className={`handoff handoff-${run.status}`} aria-label={`Browser session: ${run.goal}`}>
      <header className="handoff-head">
        <span className="handoff-title">
          <Icon name="globe" size={15} />
          Handoff · browser
        </span>
        <span className={`pill pill-${run.status}`}>
          {run.status === 'running' ? <span className="pulse" aria-hidden="true" /> : null}
          {HANDOFF_STATE[run.status]}
        </span>
      </header>
      <p className="handoff-goal">{run.goal}</p>

      <div className="handoff-body">
        <div className="handoff-view">
          <div className="handoff-url" title={run.url}>
            <span className="sr-only">Current page: </span>
            {run.url ? displayUrl(run.url) : 'No page open yet'}
          </div>
          {hasShot ? (
            <button type="button" className="handoff-shot" onClick={() => setZoomed(true)} aria-label="Enlarge the latest screenshot">
              <img src={shot} alt="What the browser agent sees right now" onError={() => setBrokenVersion(run.screenshotVersion)} />
            </button>
          ) : (
            <div className="handoff-shot handoff-shot-empty">{live ? 'Waiting for the first screenshot…' : 'No screenshot'}</div>
          )}
        </div>

        <div className="handoff-log">
          <h4>Steps{stepCount ? ` · ${stepCount}` : ''}</h4>
          {stepCount ? (
            <ol className="steps" ref={stepsRef} tabIndex={0} aria-label="Steps taken so far">
              {run.steps.map((step) => (
                <li key={step.index} className="step">
                  <span className="step-action">{step.action.replace(/_/g, ' ')}</span>
                  <span className="step-detail">{step.detail}</span>
                  <time className="step-time" dateTime={step.at}>
                    {formatTime(step.at, timezone)}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">Nothing yet. Every step shows up here as it happens.</p>
          )}
        </div>
      </div>

      {run.result ? (
        <div className="handoff-result">
          <h4>{run.status === 'failed' ? 'What went wrong' : 'Result'}</h4>
          <p>{run.result}</p>
        </div>
      ) : null}
      <ErrorNote>{error}</ErrorNote>
      <footer className="handoff-foot">
        {live ? (
          <button type="button" className="btn btn-sm" onClick={() => void cancel()} disabled={cancelling}>
            {cancelling ? <Spinner /> : <Icon name="x" size={14} />}
            Cancel browser session
          </button>
        ) : (
          <span className="muted small">
            {run.endedAt ? `Ended ${formatDateTime(run.endedAt, timezone)}` : HANDOFF_STATE[run.status]}
          </span>
        )}
      </footer>

      {zoomed ? (
        <Dialog title={displayUrl(run.url) || 'Screenshot'} variant="lightbox" onClose={() => setZoomed(false)}>
          <img className="lightbox-img" src={shot} alt="Latest screenshot from the browser agent, enlarged" />
        </Dialog>
      ) : null}
    </section>
  );
}

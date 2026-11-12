import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Approval, ApprovalKind, HandoffStatus, Id, MessagePart } from '../../../shared/types.ts';
import { cancelHandoff, decideApproval } from '../actions.ts';
import { errorText, screenshotUrl } from '../api.ts';
import { formatTime } from '../lib/format.ts';
import { threadHref } from '../router.ts';
import { pendingApprovals, setState, useStore } from '../store.ts';
import { Dialog, ErrorNote, Icon, Spinner } from './ui.tsx';

// ───────────────────────── Tool traces ─────────────────────────

type ToolPart = Extract<MessagePart, { type: 'tool' }>;

const TRACE: Record<ToolPart['status'], { glyph: string; word: string }> = {
  running: { glyph: '', word: 'Running' },
  done: { glyph: '✓', word: 'Done' },
  error: { glyph: '✕', word: 'Failed' },
  denied: { glyph: '⊘', word: 'Not allowed' },
};

/** Consecutive tool calls read as one tidy trace: glyph, name, what came of it. */
export const TraceStack = memo(function TraceStack({ tools }: { tools: ToolPart[] }) {
  return (
    <ul className="trace" aria-label="What Vector did">
      {tools.map((tool) => {
        const state = TRACE[tool.status];
        const name = (tool.name || tool.label).replace(/_+/g, '.');
        return (
          <li key={tool.id} className={`trace-line trace-${tool.status}`}>
            <span className="trace-glyph" aria-hidden="true">
              {tool.status === 'running' ? <span className="pulse" /> : state.glyph}
            </span>
            <span className="sr-only">{state.word}: </span>
            <span className="trace-name" title={tool.label}>
              {name}
            </span>
            <span className="trace-sum">{tool.summary ?? (tool.status === 'running' ? tool.label : '')}</span>
          </li>
        );
      })}
    </ul>
  );
});

// ───────────────────────── Consent slip ─────────────────────────

export const APPROVAL_LABEL: Record<ApprovalKind, string> = {
  purchase: 'Spend money',
  send_message: 'Send in your name',
  share_personal_info: 'Share your details',
  account_change: 'Change an account',
  vault_use: 'Use a saved secret',
  other: 'Needs your OK',
};

const RESOLVED: Record<Approval['status'], string> = {
  pending: 'Waiting',
  approved: 'Approved',
  denied: 'Denied',
  expired: 'Expired — nothing done',
};

export function ApprovalCard({ approval, showThreadLink }: { approval: Approval; showThreadLink?: boolean }) {
  const timezone = useStore((s) => s.user?.settings.timezone);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState('');
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
    <section className={`slip slip-${approval.status}`} aria-label={`Approval request: ${approval.summary}`}>
      <header className="slip-head">
        <span className="label slip-kind">
          <Icon name="shield" size={13} />
          {APPROVAL_LABEL[approval.kind] ?? APPROVAL_LABEL.other}
        </span>
        <span className="label slip-state">
          {pending ? 'Needs you' : `${RESOLVED[approval.status]} ${formatTime(approval.resolvedAt ?? approval.createdAt, timezone)}`}
        </span>
      </header>
      <p className="slip-summary">{approval.summary}</p>
      {details.length ? (
        <dl className="kv slip-facts">
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
        <div className="slip-foot">
          <div className="slip-actions">
            <button type="button" className="btn btn-primary btn-verb" disabled={busy !== null} onClick={() => void decide('approve')}>
              {busy === 'approve' ? <Spinner /> : null}
              Approve
            </button>
            <button type="button" className="btn btn-verb" disabled={busy !== null} onClick={() => void decide('deny')}>
              {busy === 'deny' ? <Spinner /> : null}
              Deny
            </button>
          </div>
          <p className="label slip-note">
            Nothing happens until you choose.
            {showThreadLink && approval.threadId ? (
              <>
                {' '}
                <a className="slip-link" href={threadHref(approval.threadId)}>
                  See the thread
                </a>
              </>
            ) : null}
          </p>
        </div>
      ) : null}
    </section>
  );
}

export function ApprovalPart({ approvalId }: { approvalId: Id }) {
  const approval = useStore((s) => s.approvals[approvalId]);
  const gone = useStore((s) => s.approvalsGone[approvalId]);
  if (approval) return <ApprovalCard approval={approval} />;
  return <p className="label card-placeholder">{gone ? 'Approval request closed' : 'Loading approval request…'}</p>;
}

// ───────────────────────── Flight recorder (browser agent) ─────────────────────────

const HANDOFF_TAG: Record<HandoffStatus, string> = {
  running: 'Live',
  waiting_approval: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function hostOf(url: string): { host: string; path: string; secure: boolean } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname === '/' ? '' : u.pathname + u.search, secure: u.protocol === 'https:' };
  } catch {
    return { host: url, path: '', secure: false };
  }
}

export function HandoffPart({ runId }: { runId: Id }) {
  const run = useStore((s) => s.handoffs[runId]);
  const gone = useStore((s) => s.handoffsGone[runId]);
  const timezone = useStore((s) => s.user?.settings.timezone);
  const [zoomed, setZoomed] = useState(false);
  const [zoomIn, setZoomIn] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [brokenVersion, setBrokenVersion] = useState(-1);
  const logRef = useRef<HTMLOListElement>(null);
  const stepCount = run?.steps.length ?? 0;
  const live = run ? run.status === 'running' || run.status === 'waiting_approval' : false;

  useEffect(() => {
    const list = logRef.current;
    if (list && live) list.scrollTop = list.scrollHeight; // follow the newest step
  }, [stepCount, live]);

  if (!run) {
    return <p className="label card-placeholder">{gone ? 'Browser session no longer available' : 'Loading browser session…'}</p>;
  }

  const hasShot = run.screenshotVersion > 0 && brokenVersion !== run.screenshotVersion;
  const shot = screenshotUrl(run.id, run.screenshotVersion);
  const at = hostOf(run.url);
  const showLog = live || logOpen;

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
    <section className={`fr fr-${run.status}`} aria-label={`Browser session: ${run.goal}`}>
      <div className="fr-window on-ink">
        <div className="fr-chrome">
          <span className="fr-dot" aria-hidden="true" />
          <span className="fr-url" title={run.url}>
            <span className="sr-only">Current page: </span>
            {run.url ? (
              <>
                {at.secure ? <Icon name="vault" size={12} /> : null}
                <span className="fr-host">{at.host}</span>
                <span className="fr-path">{at.path}</span>
              </>
            ) : (
              <span className="fr-path">about:blank</span>
            )}
          </span>
          <span className="fr-tag">{HANDOFF_TAG[run.status]}</span>
        </div>
        <div className="fr-sweep" aria-hidden="true" />
        {hasShot ? (
          <button type="button" className="fr-shot" onClick={() => setZoomed(true)} aria-label="Enlarge the latest screenshot">
            <img src={shot} alt="What the browser agent sees right now" onError={() => setBrokenVersion(run.screenshotVersion)} />
          </button>
        ) : (
          <div className="fr-shot fr-shot-empty label">{live ? 'Waiting for first frame' : 'No frame recorded'}</div>
        )}
      </div>

      <p className="fr-goal">
        <span className="label">Goal</span>
        {run.goal}
      </p>

      {run.result ? (
        <div className="fr-result">
          <span className="label">{run.status === 'failed' ? 'What went wrong' : run.status === 'cancelled' ? 'Stopped' : 'Result'}</span>
          <p>{run.result}</p>
        </div>
      ) : null}

      {!live && stepCount ? (
        <button type="button" className="fr-toggle label" aria-expanded={logOpen} onClick={() => setLogOpen((open) => !open)}>
          <span>
            {stepCount} step{stepCount === 1 ? '' : 's'} recorded
          </span>
          <span aria-hidden="true">{logOpen ? '−' : '+'}</span>
        </button>
      ) : null}

      {showLog ? (
        stepCount ? (
          <ol className={`fr-log${live ? ' is-live' : ''}`} ref={logRef} tabIndex={0} aria-label="Steps taken so far">
            {run.steps.map((step, i) => (
              <li key={step.index} className={`fr-step${live && i === stepCount - 1 ? ' is-newest' : ''}`}>
                <time dateTime={step.at}>{formatTime(step.at, timezone)}</time>
                <span className="fr-act">{step.action.replace(/_/g, ' ')}</span>
                <span className="fr-detail">{step.detail}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="label fr-wait">Every step appears here as it happens</p>
        )
      ) : null}

      <ErrorNote>{error}</ErrorNote>
      {live ? (
        <button type="button" className="btn fr-cancel" onClick={() => void cancel()} disabled={cancelling}>
          {cancelling ? <Spinner /> : <span className="stop-glyph" aria-hidden="true" />}
          Cancel browser session
        </button>
      ) : null}

      {zoomed ? (
        <Dialog title={at.host + at.path || 'Screenshot'} variant="lightbox" onClose={() => (setZoomed(false), setZoomIn(false))}>
          <div className="lightbox-scroll">
            <button
              type="button"
              className={`lightbox-zoom${zoomIn ? ' is-zoomed' : ''}`}
              aria-pressed={zoomIn}
              aria-label={zoomIn ? 'Fit the screenshot to the screen' : 'Zoom in on the screenshot'}
              onClick={() => setZoomIn((z) => !z)}
            >
              <img className="lightbox-img" src={shot} alt="Latest screenshot from the browser agent" />
            </button>
          </div>
          <p className="label lightbox-hint">{zoomIn ? 'Drag to look around · tap to fit' : live ? 'Tap to zoom · updates live' : 'Tap to zoom'}</p>
        </Dialog>
      ) : null}
    </section>
  );
}

// ───────────────────────── Pending-consent bar ─────────────────────────

/** Sits above the composer (or the dock) on every screen while anything is waiting for an OK. */
export function ConsentBar() {
  const approvals = useStore((s) => s.approvals);
  const pending = useMemo(() => pendingApprovals(approvals), [approvals]);
  const first = pending[0];
  if (!first) return null;
  return (
    <button type="button" className="consent-bar" onClick={() => setState((s) => ({ ...s, trayOpen: true }))}>
      <span className="consent-bar-count">{pending.length}</span>
      <span className="consent-bar-text">{pending.length === 1 ? first.summary : 'approvals waiting for you'}</span>
      <span className="consent-bar-go">Review</span>
    </button>
  );
}

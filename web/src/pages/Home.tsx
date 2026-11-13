import { useMemo, useState, type FormEvent } from 'react';
import type { ActionItem, Panel } from '../../../shared/types.ts';
import { labelThread, refresh, sendMessage } from '../actions.ts';
import { api, errorText, panelFrameUrl } from '../api.ts';
import { ConsentBar } from '../components/cards.tsx';
import { Composer, STARTER_PROMPTS } from '../components/thread.tsx';
import { Arrow, ConfirmDialog, ErrorNote, Icon, PromptChip, Spinner, WithArrows } from '../components/ui.tsx';
import { formatTime, greeting, relativeTime } from '../lib/format.ts';
import { navigate, threadHref } from '../router.ts';
import { pendingApprovals, toast, useStore } from '../store.ts';
import { ProjectDialog } from './Project.tsx';

function useSendToMain(): (text: string) => Promise<string | null> {
  const mainThreadId = useStore((s) => s.mainThreadId);
  return async (text: string) => {
    if (!mainThreadId) return 'Vector is not ready yet.';
    const failure = await sendMessage(mainThreadId, text);
    if (!failure) navigate('#/chat');
    return failure;
  };
}

// ───────────────────────── Tickets (Action Buttons) ─────────────────────────

const PRIORITY_WORD = { 1: 'High priority', 2: 'Medium priority', 3: 'Low priority' } as const;

function Ticket({ action, lead }: { action: ActionItem; lead: boolean }) {
  const [busy, setBusy] = useState<'run' | 'dismiss' | null>(null);
  const running = action.status === 'running';

  const run = async () => {
    setBusy('run');
    try {
      const { threadId } = await api.runAction(action.id);
      labelThread(threadId, action.title);
      navigate(threadHref(threadId)); // straight to where you can watch it, and stop it
      void refresh('actions').catch(() => {});
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    setBusy('dismiss');
    try {
      await api.dismissAction(action.id);
      await refresh('actions');
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(null);
    }
  };

  return (
    <li className={`ticket${lead ? ' ticket-lead' : ''}${running ? ' is-running' : ''}`}>
      <div className="ticket-top">
        <span className={`tag ticket-p${action.priority}`} aria-label={PRIORITY_WORD[action.priority]}>
          P{action.priority}
        </span>
        <span className="label ticket-age">{relativeTime(action.createdAt)}</span>
        <button type="button" className="ticket-dismiss label" disabled={busy !== null || running} onClick={() => void dismiss()} aria-label={`Dismiss: ${action.title}`}>
          Dismiss
        </button>
      </div>
      <p className="ticket-title">
        <WithArrows text={action.title} />
      </p>
      <p className="ticket-detail">{action.detail}</p>
      {running ? (
        <p className="ticket-running label">
          <span className="pulse" aria-hidden="true" />
          In flight
        </p>
      ) : (
        <button type="button" className={`ticket-verb${lead ? ' is-go' : ''}`} disabled={busy !== null} onClick={() => void run()}>
          <span>{action.verb}</span>
          {busy === 'run' ? <Spinner /> : <Arrow />}
        </button>
      )}
    </li>
  );
}

// ───────────────────────── Panels ─────────────────────────

function PanelCard({ panel }: { panel: Panel }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const reply = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { threadId } = await api.replyPanel(panel.id, text.trim());
      setText('');
      setReplying(false);
      navigate(threadHref(threadId));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="panel">
      <header className="panel-bar">
        <span className="panel-dot" aria-hidden="true" />
        <div className="panel-bar-text">
          <h3>{panel.title}</h3>
          <p className="label" title={panel.description}>
            Updated {relativeTime(panel.updatedAt)}
          </p>
        </div>
        <button type="button" className="icon-btn" aria-label={`Reply to panel: ${panel.title}`} aria-expanded={replying} onClick={() => setReplying((open) => !open)}>
          <Icon name="reply" />
        </button>
        <button type="button" className="icon-btn" aria-label={`Delete panel: ${panel.title}`} onClick={() => setDeleting(true)}>
          <Icon name="trash" />
        </button>
      </header>
      {/* Generated HTML: scripts only, no same-origin access, so it cannot touch the session or the API. */}
      <iframe
        key={panel.updatedAt}
        className="panel-frame"
        src={panelFrameUrl(panel)}
        title={`Panel: ${panel.title}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
      />
      {replying ? (
        <form className="panel-reply" onSubmit={(e) => void reply(e)}>
          <label className="field">
            <span>Ask about it, or ask for a redesign</span>
            <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Make it a weekly view" autoFocus maxLength={4000} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}>
            {busy ? <Spinner /> : null}
            Send
          </button>
          <ErrorNote>{error}</ErrorNote>
        </form>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete this panel?"
          body={<p>“{panel.title}” will be removed from Home. You can always ask Vector to build it again.</p>}
          confirmLabel="Delete panel"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deletePanel(panel.id);
            await refresh('panels');
          }}
        />
      ) : null}
    </li>
  );
}

// ───────────────────────── Home ─────────────────────────

export function HomePage() {
  const user = useStore((s) => s.user);
  const actions = useStore((s) => s.actions);
  const panels = useStore((s) => s.panels);
  const projects = useStore((s) => s.projects);
  const approvals = useStore((s) => s.approvals);
  const runningThreads = useStore((s) => s.running);
  const [creating, setCreating] = useState(false);
  const sendToMain = useSendToMain();

  const visible = useMemo(
    () =>
      actions
        .filter((a) => a.status === 'open' || a.status === 'running')
        .sort((a, b) => a.priority - b.priority || b.createdAt.localeCompare(a.createdAt)),
    [actions],
  );
  const waiting = useMemo(() => pendingApprovals(approvals).length, [approvals]);
  const timezone = user?.settings.timezone;
  const firstName = (user?.name ?? '').trim().split(/\s+/)[0];
  const pick = (text: string) => void sendToMain(text).then((failure) => failure && toast(failure, 'error'));

  const open = visible.filter((a) => a.status === 'open').length;
  const needs = open + waiting;
  const flights = Math.max(Object.keys(runningThreads).length, visible.length - open);
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: safeZone(timezone) }).format(now);
  const brandNew = !visible.length && !panels.length && !projects.length;
  const leadId = visible.find((a) => a.status === 'open')?.id;

  return (
    <>
      <div className="home-scroll">
        <div className="page home">
          <header className="hero">
            <div className="vfield" aria-hidden="true" />
            <p className="label hero-date">
              {date} · {formatTime(now.toISOString(), timezone)}
            </p>
            <h2 className="hero-hello">
              {greeting(timezone).replace(/^Good (.)/, (_, c: string) => c.toUpperCase())},
              <br />
              {firstName || 'you'}.
            </h2>
            <p className="hero-state">
              {needs ? (
                <>
                  <span className="hl">
                    {needs} thing{needs === 1 ? '' : 's'}
                  </span>{' '}
                  need{needs === 1 ? 's' : ''} you
                </>
              ) : (
                'Nothing needs you'
              )}
              {flights ? (
                <>
                  {' · '}
                  <span className="hero-flight">
                    <span className="pulse" aria-hidden="true" />
                    {flights} run{flights === 1 ? '' : 's'} in flight
                  </span>
                </>
              ) : null}
            </p>
          </header>

          {brandNew ? (
            <section className="home-section rise" aria-labelledby="start-h">
              <div className="section-head">
                <h2 id="start-h">Start here</h2>
              </div>
              <p className="muted">Tap one. Vector takes it from there.</p>
              <div className="prompt-grid">
                {STARTER_PROMPTS.map((prompt) => (
                  <PromptChip key={prompt} text={prompt} onPick={pick} />
                ))}
              </div>
            </section>
          ) : null}

          <section className="home-section rise" aria-labelledby="now-h">
            <div className="section-head">
              <h2 id="now-h">Needs you</h2>
              {visible.length ? <span className="count">{String(visible.length).padStart(2, '0')}</span> : null}
            </div>
            {visible.length ? (
              <ul className="tickets">
                {visible.map((a) => (
                  <Ticket key={a.id} action={a} lead={a.id === leadId} />
                ))}
              </ul>
            ) : (
              <p className="quiet-note">
                Clear. When Vector spots something it can finish for you — a bill, a renewal, a reply — it leaves a one-tap
                ticket here.
              </p>
            )}
          </section>

          <section className="home-section rise" aria-labelledby="panels-h">
            <div className="section-head">
              <h2 id="panels-h">Panels</h2>
              {panels.length ? <span className="count">{String(panels.length).padStart(2, '0')}</span> : null}
            </div>
            {panels.length ? (
              <ul className="panels">
                {panels.map((p) => (
                  <PanelCard key={p.id} panel={p} />
                ))}
              </ul>
            ) : (
              <>
                <p className="quiet-note">Small live apps, built on request. Describe what you want to keep an eye on.</p>
                <div className="prompt-grid">
                  <PromptChip text="Build me a panel that tracks my reading streak" onPick={pick} />
                </div>
              </>
            )}
          </section>

          <section className="home-section rise" aria-labelledby="projects-h">
            <div className="section-head">
              <h2 id="projects-h">Projects</h2>
              {projects.length ? <span className="count">{String(projects.length).padStart(2, '0')}</span> : null}
              <button type="button" className="btn btn-sm section-head-action" onClick={() => setCreating(true)}>
                <Icon name="plus" size={15} />
                New
              </button>
            </div>
            {projects.length ? (
              <ul className="rows projects">
                {projects.map((p) => (
                  <li key={p.id}>
                    <a className="project" href={`#/project/${encodeURIComponent(p.id)}`}>
                      <span className="project-text">
                        <span className="project-name">{p.name}</span>
                        <span className="project-desc">{p.description || 'No description'}</span>
                      </span>
                      <Icon name="chevron" size={16} />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="quiet-note">Longer work gets its own thread: a trip, a move, a job search.</p>
            )}
          </section>
        </div>
      </div>

      <div className="floor">
        <ConsentBar />
        <Composer onSend={sendToMain} label="Message Vector" />
      </div>

      {creating ? <ProjectDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function safeZone(zone: string | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

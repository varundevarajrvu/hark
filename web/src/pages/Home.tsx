import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { ActionItem, Panel } from '../../../shared/types.ts';
import { labelThread, refresh, sendMessage } from '../actions.ts';
import { api, errorText, panelFrameUrl } from '../api.ts';
import { ConsentBar } from '../components/cards.tsx';
import { Composer, STARTER_PROMPTS } from '../components/thread.tsx';
import { Arrow, ConfirmDialog, ErrorNote, Icon, PromptChip, Spinner, WithArrows } from '../components/ui.tsx';
import { dayKey, formatTime, greeting, relativeTime } from '../lib/format.ts';
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

function useTicket(action: ActionItem) {
  const [busy, setBusy] = useState<'run' | 'dismiss' | null>(null);

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

  return { busy, run, dismiss, running: action.status === 'running' };
}

/** The one ticket that gets the big lime verb. */
function LeadTicket({ action }: { action: ActionItem }) {
  const { busy, run, dismiss, running } = useTicket(action);
  return (
    <li className="ticket ticket-lead">
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
      <button type="button" className="ticket-verb is-go" disabled={busy !== null} onClick={() => void run()}>
        <span>{action.verb}</span>
        {busy === 'run' ? <Spinner /> : <Arrow />}
      </button>
    </li>
  );
}

/** Every other ticket: one compact row, the verb as a small outlined button. */
function TicketRow({ action }: { action: ActionItem }) {
  const { busy, run, dismiss, running } = useTicket(action);
  return (
    <li className={`trow${running ? ' is-running' : ''}`}>
      <p className="trow-title">
        <span className="sr-only">{PRIORITY_WORD[action.priority]}: </span>
        <WithArrows text={action.title} />
      </p>
      <p className="trow-meta">
        <span className="trow-detail">{action.detail}</span>
        {running ? null : (
          <button type="button" className="ticket-dismiss label" disabled={busy !== null} onClick={() => void dismiss()} aria-label={`Dismiss: ${action.title}`}>
            Dismiss
          </button>
        )}
      </p>
      {running ? (
        <span className="trow-flight label">
          <span className="pulse" aria-hidden="true" />
          In flight
        </span>
      ) : (
        <button type="button" className="trow-verb" disabled={busy !== null} onClick={() => void run()}>
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

function SectionHead({ id, title, count, action }: { id: string; title: string; count?: number; action?: ReactNode }) {
  return (
    <div className="home-head">
      <h2 id={id} className="label">
        {title}
      </h2>
      {count ? <span className="label home-head-count">{String(count).padStart(2, '0')}</span> : null}
      {action}
    </div>
  );
}

/** "08:00", "tomorrow 08:00", "Fri 20 Nov". */
function nextRunWords(iso: string, timezone?: string): string {
  const today = dayKey(new Date().toISOString(), timezone);
  const tomorrow = dayKey(new Date(Date.now() + 86_400_000).toISOString(), timezone);
  const day = dayKey(iso, timezone);
  if (day === today) return formatTime(iso, timezone);
  if (day === tomorrow) return `tmrw ${formatTime(iso, timezone)}`;
  try {
    return `${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: safeZone(timezone) }).format(new Date(iso))}`;
  } catch {
    return 'soon';
  }
}

export function HomePage() {
  const user = useStore((s) => s.user);
  const actions = useStore((s) => s.actions);
  const panels = useStore((s) => s.panels);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const memories = useStore((s) => s.memories);
  const approvals = useStore((s) => s.approvals);
  const runningThreads = useStore((s) => s.running);
  const [creating, setCreating] = useState(false);
  const sendToMain = useSendToMain();

  useEffect(() => {
    refresh('memories').catch(() => {}); // only for the count in the strip
  }, []);

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
  const scheduled = tasks.filter((t) => t.enabled);
  const next = scheduled
    .filter((t) => t.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))[0];
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: safeZone(timezone) }).format(now);
  const hello = greeting(timezone).replace(/^Good (.)/, (_, c: string) => c.toUpperCase());
  const brandNew = !visible.length && !panels.length && !projects.length;
  const lead = visible.find((a) => a.status === 'open');
  const rest = visible.filter((a) => a !== lead);

  return (
    <>
      <div className="home-scroll">
        <div className="page home">
          <header className={`hero ${needs ? 'hero-needs' : 'hero-clear'}`}>
            {needs ? <div className="hero-glow" aria-hidden="true" /> : null}
            <div className="vfield vfield-drift" aria-hidden="true" />
            <p className="label hero-date">
              {hello}, {firstName || 'you'} · {date} {formatTime(now.toISOString(), timezone)}
            </p>
            {needs ? (
              <h2 className="hero-head">
                <span className="hero-num">{needs}</span>
                <span className="hero-words">
                  thing{needs === 1 ? '' : 's'}
                  <br />
                  need{needs === 1 ? 's' : ''} you
                </span>
              </h2>
            ) : (
              <div className="hero-calm">
                <h2 className="hero-clear-head">All clear.</h2>
                <p className="hero-clear-note">Nothing needs you. When Vector spots something it can finish — a bill, a renewal, a reply — it leaves a ticket here.</p>
              </div>
            )}
            <nav className="stat-strip" aria-label="At a glance">
              {flights ? (
                <a className="stat is-live" href="#/chat">
                  <span className="pulse" aria-hidden="true" />
                  <b>{flights}</b> in flight
                </a>
              ) : null}
              <a className="stat" href="#/tasks">
                <b>{scheduled.length}</b> scheduled
              </a>
              {next?.nextRunAt ? (
                <a className="stat" href="#/tasks" aria-label={`Next run: ${next.title}, ${nextRunWords(next.nextRunAt, timezone)}`}>
                  next <b>{nextRunWords(next.nextRunAt, timezone)}</b>
                </a>
              ) : null}
              {memories ? (
                <a className="stat" href="#/memory">
                  <b>{memories.length}</b> memor{memories.length === 1 ? 'y' : 'ies'}
                </a>
              ) : null}
            </nav>
          </header>

          {brandNew ? (
            <section className="home-section rise" aria-labelledby="start-h">
              <SectionHead id="start-h" title="Start here" />
              <p className="muted">Tap one. Vector takes it from there.</p>
              <div className="prompt-chips">
                {STARTER_PROMPTS.map((prompt) => (
                  <PromptChip key={prompt} text={prompt} onPick={pick} />
                ))}
              </div>
            </section>
          ) : null}

          {visible.length ? (
            <section className="home-section rise" aria-labelledby="now-h">
              <SectionHead id="now-h" title="Needs you" count={visible.length} />
              <ul className="tickets">
                {lead ? <LeadTicket key={lead.id} action={lead} /> : null}
                {rest.map((a) => (
                  <TicketRow key={a.id} action={a} />
                ))}
              </ul>
            </section>
          ) : null}

          <section className="home-section rise" aria-labelledby="panels-h">
            <SectionHead id="panels-h" title="Panels" count={panels.length} />
            {panels.length ? (
              <ul className="panels">
                {panels.map((p) => (
                  <PanelCard key={p.id} panel={p} />
                ))}
              </ul>
            ) : (
              <>
                <p className="quiet-note">Small live apps, built on request. Describe what you want to keep an eye on.</p>
                <div className="prompt-chips">
                  <PromptChip text="Build me a panel that tracks my reading streak" onPick={pick} />
                </div>
              </>
            )}
          </section>

          <section className="home-section rise" aria-labelledby="projects-h">
            <SectionHead
              id="projects-h"
              title="Projects"
              count={projects.length}
              action={
                <button type="button" className="home-head-action label" onClick={() => setCreating(true)}>
                  <Icon name="plus" size={14} />
                  New
                </button>
              }
            />
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

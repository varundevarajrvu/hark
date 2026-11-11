import { useMemo, useState, type FormEvent } from 'react';
import type { ActionItem, Panel } from '../../../shared/types.ts';
import { labelThread, refresh, sendMessage } from '../actions.ts';
import { api, errorText, panelFrameUrl } from '../api.ts';
import { Composer, STARTER_PROMPTS } from '../components/thread.tsx';
import { ConfirmDialog, Empty, ErrorNote, Icon, PromptChip, Spinner } from '../components/ui.tsx';
import { greeting, relativeTime } from '../lib/format.ts';
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

// ───────────────────────── Action Buttons ─────────────────────────

const PRIORITY_WORD = { 1: 'High priority', 2: 'Medium priority', 3: 'Low priority' } as const;

function ActionRow({ action }: { action: ActionItem }) {
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
    <li className={`action action-p${action.priority}`}>
      <span className="magnitude" role="img" aria-label={PRIORITY_WORD[action.priority]}>
        <i />
        <i />
        <i />
      </span>
      <div className="action-text">
        <p className="action-title">{action.title}</p>
        <p className="action-detail">{action.detail}</p>
      </div>
      <div className="action-controls">
        {running ? (
          <span className="pill pill-running">
            <span className="pulse" aria-hidden="true" />
            Working on it
          </span>
        ) : (
          <button type="button" className={`btn ${action.priority === 1 ? 'btn-primary' : 'btn-accent-quiet'}`} disabled={busy !== null} onClick={() => void run()}>
            {busy === 'run' ? <Spinner /> : null}
            {action.verb}
            <Icon name="arrow" size={15} />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label={`Dismiss: ${action.title}`} disabled={busy !== null || running} onClick={() => void dismiss()}>
          <Icon name="x" size={16} />
        </button>
      </div>
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
      <header className="panel-head">
        <div className="panel-head-text">
          <h3>{panel.title}</h3>
          <p title={panel.description}>Updated {relativeTime(panel.updatedAt)}</p>
        </div>
        <button type="button" className="btn btn-sm btn-quiet" aria-expanded={replying} onClick={() => setReplying((open) => !open)}>
          <Icon name="reply" size={15} />
          Reply
        </button>
        <button type="button" className="icon-btn" aria-label={`Delete panel: ${panel.title}`} onClick={() => setDeleting(true)}>
          <Icon name="trash" size={16} />
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
            <span>Ask about this panel, or ask for a redesign</span>
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
  const firstName = (user?.name ?? '').trim().split(/\s+/)[0];
  const pick = (text: string) => void sendToMain(text).then((failure) => failure && toast(failure, 'error'));

  const summary: string[] = [];
  if (waiting) summary.push(`${waiting} approval${waiting === 1 ? '' : 's'} waiting`);
  if (visible.length) summary.push(`${visible.length} thing${visible.length === 1 ? '' : 's'} you can clear in one tap`);
  const brandNew = !visible.length && !panels.length && !projects.length;

  return (
    <div className="page home">
      <header className="home-hero">
        <p className="eyebrow">{new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</p>
        <h1>
          {greeting(user?.settings.timezone)}
          {firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="lead">{summary.length ? `${summary.join(' · ')}.` : 'Nothing needs you right now. What should Vector take off your plate?'}</p>
        <Composer onSend={sendToMain} label="Message Vector" placeholder="Ask Vector to do something…" />
        {brandNew ? (
          <div className="prompt-grid">
            {STARTER_PROMPTS.map((prompt) => (
              <PromptChip key={prompt} text={prompt} onPick={pick} />
            ))}
          </div>
        ) : null}
      </header>

      <section className="home-section home-now" aria-labelledby="now-h">
        <div className="section-head">
          <h2 id="now-h">Needs you now</h2>
          {visible.length ? <span className="count">{visible.length}</span> : null}
        </div>
        {visible.length ? (
          <ul className="actions">
            {visible.map((a) => (
              <ActionRow key={a.id} action={a} />
            ))}
          </ul>
        ) : (
          <Empty icon="check" title="You are all clear.">
            <p>
              When Vector spots something it can finish for you — a bill to pay, a renewal to cancel, a message to answer — it
              puts a one-tap button here. Press it and Vector does the whole job, asking first if money or your accounts are
              involved.
            </p>
          </Empty>
        )}
      </section>

      <section className="home-section" aria-labelledby="panels-h">
        <div className="section-head">
          <h2 id="panels-h">Panels</h2>
          {panels.length ? <span className="count">{panels.length}</span> : null}
        </div>
        {panels.length ? (
          <ul className="panels">
            {panels.map((p) => (
              <PanelCard key={`${p.id}`} panel={p} />
            ))}
          </ul>
        ) : (
          <Empty icon="panel" title="Small apps, built on request.">
            <p>Describe something you want to keep an eye on and Vector builds a live panel for it here.</p>
            <div className="prompt-row">
              <PromptChip text="Build me a panel that tracks my reading streak" onPick={pick} />
              <PromptChip text="Build me a panel with this week's weather for Bengaluru" onPick={pick} />
            </div>
          </Empty>
        )}
      </section>

      <section className="home-section" aria-labelledby="projects-h">
        <div className="section-head">
          <h2 id="projects-h">Projects</h2>
          {projects.length ? <span className="count">{projects.length}</span> : null}
          <button type="button" className="btn btn-sm section-head-action" onClick={() => setCreating(true)}>
            <Icon name="plus" size={15} />
            New project
          </button>
        </div>
        {projects.length ? (
          <ul className="projects">
            {projects.map((p) => (
              <li key={p.id}>
                <a className="project" href={`#/project/${encodeURIComponent(p.id)}`}>
                  <span className="project-icon">
                    <Icon name="folder" />
                  </span>
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
          <Empty icon="folder" title="Longer work gets its own thread.">
            <p>
              Planning a trip, a move, a job search? Give it a project so it does not get lost in everyday chat. Or start in the
              main thread:
            </p>
            <div className="prompt-row">
              <PromptChip text="Find the cheapest direct flight BLR → DEL next Friday" onPick={pick} />
            </div>
          </Empty>
        )}
      </section>

      {creating ? <ProjectDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

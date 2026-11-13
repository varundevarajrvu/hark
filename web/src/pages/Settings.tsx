import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type { ApprovalKind, AuditEntry, User } from '../../../shared/types.ts';
import { deleteAccount, refresh, signOut } from '../actions.ts';
import { api, errorText } from '../api.ts';
import { Dialog, ErrorNote, Icon, Loading, Spinner, Switch, type IconName } from '../components/ui.tsx';
import { browserTimezone, formatDateTime, timezoneList } from '../lib/format.ts';
import { setState, toast, useStore } from '../store.ts';

const applyUser = (user: User) => setState((s) => ({ ...s, user }));

// ───────────────────────── Timezone offer (also shown on Tasks) ─────────────────────────

/** Accounts start on UTC. Offer the browser's zone; never switch silently. */
export function TimezoneOffer() {
  const zone = useStore((s) => s.user?.settings.timezone);
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem('vector.tz-offer') === 'dismissed';
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const local = browserTimezone();
  if (hidden || zone !== 'UTC' || local === 'UTC') return null;

  const dismiss = () => {
    setHidden(true);
    try {
      sessionStorage.setItem('vector.tz-offer', 'dismissed');
    } catch {
      /* private mode: the offer simply shows again next time */
    }
  };
  const accept = async () => {
    setBusy(true);
    try {
      const { user } = await api.updateSettings({ timezone: local });
      applyUser(user);
      void refresh('tasks').catch(() => {});
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="offer" role="region" aria-label="Timezone suggestion">
      <p>
        Your timezone is set to <strong>UTC</strong>, but this device is in <strong>{local}</strong>. Scheduled tasks follow the
        setting.
      </p>
      <div className="offer-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void accept()}>
          {busy ? <Spinner /> : null}
          Use {local}
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={dismiss}>
          Keep UTC
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── Rows ─────────────────────────

function Row(props: { label: string; value?: ReactNode; note?: string; icon?: IconName; onClick?: () => void; href?: string; chevron?: boolean; busy?: boolean }) {
  const body = (
    <>
      {props.icon ? <Icon name={props.icon} size={18} /> : null}
      <span className="set-row-text">
        <span className="set-row-label">{props.label}</span>
        {props.note ? <span className="label">{props.note}</span> : null}
      </span>
      {props.value !== undefined ? <span className="set-row-value">{props.value}</span> : null}
      {props.busy ? <Spinner /> : props.chevron === false ? null : <Icon name="chevron" size={15} />}
    </>
  );
  if (props.href) {
    return (
      <a className="set-row" href={props.href}>
        {body}
      </a>
    );
  }
  if (props.onClick) {
    return (
      <button type="button" className="set-row" onClick={props.onClick} disabled={props.busy} aria-haspopup={props.chevron === false ? undefined : 'dialog'}>
        {body}
      </button>
    );
  }
  return <div className="set-row is-static">{body}</div>;
}

// ───────────────────────── Sheets: name, timezone ─────────────────────────

function NameSheet({ user, onClose }: { user: User; onClose: () => void }) {
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user: next } = await api.updateSettings({ name: name.trim() });
      applyUser(next);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Your name" variant="sheet" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void save(e)}>
        <label className="field">
          <span>What Vector calls you</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
        </label>
        <p className="label">Sign-in email · {user.email} · cannot be changed here</p>
        <ErrorNote>{error}</ErrorNote>
        <button type="submit" className="btn btn-primary btn-block btn-verb" disabled={busy || !name.trim() || name.trim() === user.name}>
          {busy ? <Spinner /> : null}
          Save
        </button>
      </form>
    </Dialog>
  );
}

function TimezoneSheet({ user, onClose }: { user: User; onClose: () => void }) {
  const [zone, setZone] = useState(user.settings.timezone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const local = browserTimezone();
  const zones = useMemo(() => {
    const list = timezoneList();
    return list.includes(zone) ? list : [zone, ...list];
  }, [zone]);

  const save = async (next: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.updateSettings({ timezone: next });
      applyUser(res.user);
      void refresh('tasks').catch(() => {});
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Timezone" variant="sheet" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save(zone);
        }}
      >
        <p className="muted">Scheduled tasks run on this clock, and it is the time Vector thinks it is for you.</p>
        {local !== user.settings.timezone ? (
          <button type="button" className="tz-device" disabled={busy} onClick={() => void save(local)}>
            <span className="label">This device is in</span>
            <span className="tz-device-zone">{local}</span>
            <span className="label tz-device-go">Use it</span>
          </button>
        ) : null}
        <label className="field">
          <span>Or choose</span>
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <ErrorNote>{error}</ErrorNote>
        <button type="submit" className="btn btn-primary btn-block btn-verb" disabled={busy || zone === user.settings.timezone}>
          {busy ? <Spinner /> : null}
          Save
        </button>
      </form>
    </Dialog>
  );
}

// ───────────────────────── Autonomy ─────────────────────────

interface KindCopy {
  kind: ApprovalKind;
  name: string;
  icon: IconName;
  asks: string;
  auto: string;
  risk?: string;
}

const KINDS: KindCopy[] = [
  {
    kind: 'purchase',
    name: 'Spending money',
    icon: 'card',
    asks: 'Vector shows you the amount and the merchant, then waits.',
    auto: 'It pays without showing you first.',
    risk: 'Real money leaves your account with no confirmation. A mistaken or manipulated run can buy the wrong thing, and you find out afterwards.',
  },
  {
    kind: 'vault_use',
    name: 'Using saved logins and cards',
    icon: 'vault',
    asks: 'Vector names the site and the saved secret, then waits.',
    auto: 'The browser agent types your logins and cards into their matching sites unasked.',
    risk: 'Vector can sign in to your accounts and enter card details while you are not watching. Leave this off unless you trust every task you have scheduled.',
  },
  {
    kind: 'send_message',
    name: 'Sending in your name',
    icon: 'send',
    asks: 'Vector shows you the message and the recipient, then waits.',
    auto: 'Emails, forms and messages go out without you reading them.',
  },
  {
    kind: 'share_personal_info',
    name: 'Sharing your details',
    icon: 'info',
    asks: 'Vector tells you what it would share and with whom, then waits.',
    auto: 'Your name, address, phone number and the like are submitted to other sites unasked.',
  },
  {
    kind: 'account_change',
    name: 'Changing accounts',
    icon: 'settings',
    asks: 'Vector says what it would cancel, sign up for or change, then waits.',
    auto: 'Cancelling, signing up and changing settings on outside accounts happens unasked.',
  },
  {
    kind: 'other',
    name: 'Everything else sensitive',
    icon: 'shield',
    asks: 'Vector describes the step, then waits.',
    auto: 'Other sensitive steps go ahead unasked.',
  },
];

function AutonomySheet({ copy, user, onClose }: { copy: KindCopy; user: User; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const on = Boolean(user.settings.autoApprove?.[copy.kind]);

  const set = async (value: boolean) => {
    setBusy(true);
    setError('');
    try {
      const { user: next } = await api.updateSettings({ autoApprove: { ...user.settings.autoApprove, [copy.kind]: value } });
      applyUser(next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={copy.name} variant="sheet" onClose={onClose}>
      <div className="stack">
        <dl className="auto-facts">
          <div className={on ? '' : 'is-current'}>
            <dt className="label">When it asks</dt>
            <dd>{copy.asks}</dd>
          </div>
          <div className={on ? 'is-current is-auto' : ''}>
            <dt className="label">When it acts alone</dt>
            <dd>{copy.auto} That includes scheduled tasks that run while you are away.</dd>
          </div>
        </dl>
        {copy.risk ? (
          <p className={`auto-risk${on ? ' is-live' : ''}`}>
            <span className="label">Risk</span>
            {copy.risk}
          </p>
        ) : null}
        <ErrorNote>{error}</ErrorNote>
        <div className={`auto-switch${on ? ' is-on' : ''}`}>
          <div>
            <p className="auto-switch-title">{on ? 'Acting alone' : 'Asking every time'}</p>
            <p id="auto-switch-desc" className="label">
              {on ? 'Switch off to be asked again' : 'Switch on to stop being asked'}
            </p>
          </div>
          <Switch checked={on} disabled={busy} onChange={(next) => void set(next)} label={`Act without asking: ${copy.name}`} describedBy="auto-switch-desc" />
        </div>
      </div>
    </Dialog>
  );
}

function Autonomy({ user }: { user: User }) {
  const [open, setOpen] = useState<ApprovalKind | null>(null);
  const alone = KINDS.filter((k) => user.settings.autoApprove?.[k.kind]).length;
  const copy = KINDS.find((k) => k.kind === open);
  return (
    <section className="set-section" aria-labelledby="autonomy-h">
      <p className="label">Autonomy</p>
      <h2 id="autonomy-h" className="auto-headline">
        {alone === 0 ? (
          <>Vector asks before all {KINDS.length} kinds of action.</>
        ) : (
          <>
            Vector acts alone on <span className="auto-n">{alone}</span> of {KINDS.length}.
          </>
        )}
      </h2>
      <div className="auto-meter" role="img" aria-label={`${alone} of ${KINDS.length} kinds of action go ahead without asking`}>
        {KINDS.map((k) => (
          <span key={k.kind} className={user.settings.autoApprove?.[k.kind] ? 'is-auto' : ''} />
        ))}
      </div>
      <div className="set-rows">
        {KINDS.map((k) => {
          const on = Boolean(user.settings.autoApprove?.[k.kind]);
          return (
            <Row
              key={k.kind}
              icon={k.icon}
              label={k.name}
              value={<span className={`tag${on ? ' tag-consent' : ''}`}>{on ? 'Auto' : 'Asks'}</span>}
              onClick={() => setOpen(k.kind)}
            />
          );
        })}
      </div>
      {copy ? <AutonomySheet copy={copy} user={user} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

// ───────────────────────── Activity ─────────────────────────

const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

function humanise(event: string): string {
  const words = event.replace(/[._-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Something happened';
}

const VAULT_KIND: Record<string, string> = { login: 'Login', card: 'Card', note: 'Note' };

/** An audit entry as a sentence. Never key/value dumps, never JSON. */
export function describeAudit(entry: AuditEntry): { what: string; about: string } {
  const d = entry.detail ?? {};
  const summary = str(d.summary);
  const label = str(d.label);
  switch (entry.event) {
    case 'auth.signup':
      return { what: 'Account created', about: '' };
    case 'auth.login':
      return { what: 'Signed in', about: '' };
    case 'auth.logout':
      return { what: 'Signed out', about: '' };
    case 'auth.login_failed':
      return { what: 'Sign-in failed', about: 'wrong password' };
    case 'approval.requested':
      return { what: 'Asked for your OK', about: summary };
    case 'approval.approved':
      return { what: 'Approved', about: summary };
    case 'approval.denied':
      return { what: 'Denied', about: summary };
    case 'approval.expired':
      return { what: 'Approval expired', about: summary };
    case 'approval.auto_approved':
      return { what: 'Went ahead without asking', about: summary };
    case 'vault.item_added':
    case 'vault.created':
      return { what: `${VAULT_KIND[str(d.kind)] ?? 'Secret'} saved to vault`, about: label };
    case 'vault.item_removed':
      return { what: 'Removed from vault', about: label };
    case 'vault.item_used':
      return { what: 'Vault secret used', about: label };
    case 'handoff.started':
      return { what: 'Browser session started', about: str(d.goal) };
    case 'handoff.finished':
      return { what: `Browser session ${str(d.status).replace(/_/g, ' ') || 'ended'}`, about: '' };
    case 'handoff.step':
      return { what: `Browser · ${str(d.action).replace(/_/g, ' ') || 'step'}`, about: str(d.detail) };
    case 'memories.cleared':
      return { what: 'Forgot everything', about: '' };
    case 'settings.changed': {
      const changed = Array.isArray(d.changed) ? d.changed.map(str).filter(Boolean) : [];
      return { what: 'Settings changed', about: changed.map((key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()).join(', ') };
    }
    case 'data.exported':
      return { what: 'Data exported', about: '' };
    case 'account.delete_failed':
      return { what: 'Account deletion refused', about: 'wrong password' };
    case 'task.disabled':
      return { what: 'Scheduled task switched off', about: str(d.reason) };
    case 'task.run':
      return { what: 'Scheduled task ran', about: str(d.task) || str(d.title) };
    default:
      return { what: humanise(entry.event), about: summary || label || str(d.title) || str(d.name) };
  }
}

/** "now", "6m", "2h", "3d": a timeline column, not a sentence. */
function shortAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (Number.isNaN(minutes)) return '';
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

function ActivityList({ entries, timezone, exact }: { entries: AuditEntry[]; timezone?: string; exact?: boolean }) {
  return (
    <ol className="activity">
      {entries.map((entry) => {
        const { what, about } = describeAudit(entry);
        return (
          <li key={entry.id} className={entry.event === 'handoff.step' ? 'is-minor' : undefined}>
            <time dateTime={entry.at} className="label" title={formatDateTime(entry.at, timezone)}>
              {exact ? formatDateTime(entry.at, timezone) : shortAgo(entry.at)}
            </time>
            <p>
              <span className="activity-what">{what}</span>
              {about ? <span className="activity-about"> · {about}</span> : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function Activity({ timezone }: { timezone?: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);

  useEffect(() => {
    api
      .audit(100)
      .then(({ entries: list }) => setEntries([...list].sort((a, b) => b.at.localeCompare(a.at))))
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  const latest = useMemo(() => (entries ?? []).filter((e) => e.event !== 'handoff.step').slice(0, 5), [entries]);

  return (
    <section className="set-section" aria-labelledby="activity-h">
      <div className="set-section-head">
        <p className="label" id="activity-h">
          Activity
        </p>
        {entries && entries.length > latest.length ? (
          <button type="button" className="link-btn label" onClick={() => setAll(true)} aria-haspopup="dialog">
            View all {entries.length}
          </button>
        ) : null}
      </div>
      {error ? (
        <ErrorNote>{error}</ErrorNote>
      ) : entries === null ? (
        <Loading label="Loading activity" />
      ) : latest.length ? (
        <ActivityList entries={latest} timezone={timezone} />
      ) : (
        <p className="muted">Nothing recorded yet.</p>
      )}
      {all && entries ? (
        <Dialog title="Activity" variant="full" onClose={() => setAll(false)}>
          <p className="label activity-note">Last {entries.length} events · newest first</p>
          <ActivityList entries={entries} timezone={timezone} exact />
        </Dialog>
      ) : null}
    </section>
  );
}

// ───────────────────────── Delete account ─────────────────────────

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await deleteAccount(password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      setPassword('');
    }
  };
  return (
    <Dialog title="Delete your account?" variant="sheet" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p className="confirm-body">
          This erases everything: conversations, memories, panels, projects, scheduled tasks and every secret in the vault.{' '}
          <strong>It is permanent. There is no undo and no backup.</strong>
        </p>
        <p className="label">Want a copy first? Close this and export your data.</p>
        <label className="field">
          <span>Your password, to confirm</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <ErrorNote>{error}</ErrorNote>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Keep it
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy || !password}>
            {busy ? <Spinner /> : null}
            Delete everything
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ───────────────────────── Page ─────────────────────────

export function SettingsPage() {
  const user = useStore((s) => s.user);
  const llm = useStore((s) => s.llm);
  const [sheet, setSheet] = useState<'name' | 'timezone' | 'delete' | null>(null);
  const [exporting, setExporting] = useState(false);
  if (!user) return null;

  const exportData = async () => {
    setExporting(true);
    try {
      const blob = await api.exportData();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vector-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setExporting(false);
    }
  };

  const since = (() => {
    const date = new Date(user.createdAt);
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(date);
  })();
  const zoneMismatch = user.settings.timezone === 'UTC' && browserTimezone() !== 'UTC';
  const modelState = llm?.mock ? 'Demo' : llm && !llm.configured ? 'No key' : null;

  return (
    <div className="page settings">
      <button type="button" className="ident" onClick={() => setSheet('name')} aria-haspopup="dialog" aria-label={`${user.name || user.email}. Edit your name`}>
        <span className="ident-tile" aria-hidden="true">
          {(user.name || user.email).trim().charAt(0).toUpperCase()}
        </span>
        <span className="ident-text">
          <span className="ident-name">{user.name || 'No name yet'}</span>
          <span className="label ident-mail">{user.email}</span>
          {since ? <span className="label">Member since {since}</span> : null}
        </span>
        <span className="label ident-edit">Edit</span>
      </button>

      <section className="set-section" aria-label="Basics">
        <div className="set-rows">
          <Row
            label="Timezone"
            note={zoneMismatch ? `This device is in ${browserTimezone()}` : undefined}
            value={<span className="mono-value">{user.settings.timezone}</span>}
            onClick={() => setSheet('timezone')}
          />
          <Row
            label="Memory"
            value={<span className={`tag${user.settings.memoryEnabled ? ' tag-live' : ''}`}>{user.settings.memoryEnabled ? 'On' : 'Off'}</span>}
            href="#/memory"
          />
          <Row
            label="Model"
            chevron={false}
            value={
              <>
                {modelState ? <span className={`tag${modelState === 'No key' ? ' tag-danger' : ''}`}>{modelState}</span> : null}
                <span className="mono-value">{llm?.model ?? '—'}</span>
              </>
            }
          />
        </div>
      </section>

      <Autonomy user={user} />
      <Activity timezone={user.settings.timezone} />

      <section className="set-section" aria-label="Data and account">
        <div className="set-rows">
          <Row label="Export your data" note="One JSON file · vault secrets never included" icon="download" onClick={() => void exportData()} busy={exporting} chevron={false} />
          <Row label="Sign out" icon="logout" onClick={() => void signOut()} chevron={false} />
        </div>
      </section>

      <section className="danger-block" aria-label="Delete account">
        <p className="label">Danger</p>
        <button type="button" className="danger-row" onClick={() => setSheet('delete')} aria-haspopup="dialog">
          <span>Delete account</span>
          <span className="label">Erases everything · permanent</span>
        </button>
      </section>

      {sheet === 'name' ? <NameSheet user={user} onClose={() => setSheet(null)} /> : null}
      {sheet === 'timezone' ? <TimezoneSheet user={user} onClose={() => setSheet(null)} /> : null}
      {sheet === 'delete' ? <DeleteAccountDialog onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

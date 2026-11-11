import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ApprovalKind, AuditEntry, User } from '../../../shared/types.ts';
import { deleteAccount, refresh, signOut } from '../actions.ts';
import { api, errorText } from '../api.ts';
import { Dialog, ErrorNote, Icon, Loading, PageHeader, Spinner, Switch } from '../components/ui.tsx';
import { browserTimezone, formatDateTime, timezoneList } from '../lib/format.ts';
import { setState, toast, useStore } from '../store.ts';

const applyUser = (user: User) => setState((s) => ({ ...s, user }));

// ───────────────────────── Timezone offer ─────────────────────────

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
      <Icon name="clock" />
      <p>
        Your timezone is set to <strong>UTC</strong>, but this browser is in <strong>{local}</strong>. Scheduled tasks and “today”
        follow the setting.
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

// ───────────────────────── Auto-approve ─────────────────────────

const AUTO: { kind: ApprovalKind; title: string; on: string; warning?: string }[] = [
  {
    kind: 'purchase',
    title: 'Spending money',
    on: 'Vector pays without showing you the amount or the merchant first.',
    warning: 'Real money leaves your account with no confirmation. A mistaken or manipulated run can buy the wrong thing, and you find out afterwards.',
  },
  {
    kind: 'vault_use',
    title: 'Using saved logins and cards',
    on: 'The browser agent types your saved logins and cards into their matching sites without asking.',
    warning: 'Vector can sign in to your accounts and enter card details while you are not watching. Leave this off unless you fully trust every task you have scheduled.',
  },
  { kind: 'send_message', title: 'Sending messages', on: 'Emails, forms and messages go out in your name without you reading them first.' },
  { kind: 'share_personal_info', title: 'Sharing personal details', on: 'Your name, address, phone number and similar details are submitted to other sites without a prompt.' },
  { kind: 'account_change', title: 'Changing accounts', on: 'Cancelling, signing up and changing settings on outside accounts happens without a prompt.' },
  { kind: 'other', title: 'Everything else that needs an OK', on: 'Other sensitive steps go ahead without a prompt.' },
];

function AutoApprove() {
  const settings = useStore((s) => s.user?.settings);
  const [busy, setBusy] = useState<ApprovalKind | null>(null);
  if (!settings) return null;

  const set = async (kind: ApprovalKind, value: boolean) => {
    setBusy(kind);
    try {
      const { user } = await api.updateSettings({ autoApprove: { ...settings.autoApprove, [kind]: value } });
      applyUser(user);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="setting-card" aria-labelledby="auto-h">
      <h2 id="auto-h">Approvals</h2>
      <p className="muted">
        By default Vector stops and asks before each of these. Switching one on means it stops asking for that kind of step —
        everywhere, including scheduled tasks that run while you are away. Off is the safe choice.
      </p>
      <ul className="toggles">
        {AUTO.map((item) => {
          const on = Boolean(settings.autoApprove?.[item.kind]);
          return (
            <li key={item.kind} className={`toggle-row${on && item.warning ? ' is-risky' : ''}`}>
              <div>
                <h3>{item.title}</h3>
                <p id={`auto-${item.kind}`} className="muted">
                  {on ? <strong className="on-word">Not asking. </strong> : <span>Asks every time. If switched on: </span>}
                  {item.on}
                </p>
                {item.warning ? (
                  <p className={`warning${on ? ' is-active' : ''}`}>
                    <Icon name="alert" size={15} />
                    <span>{item.warning}</span>
                  </p>
                ) : null}
              </div>
              <Switch checked={on} disabled={busy === item.kind} onChange={(next) => void set(item.kind, next)} label={`Skip approval for: ${item.title}`} describedBy={`auto-${item.kind}`} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ───────────────────────── Activity log ─────────────────────────

function humanise(event: string): string {
  const words = event.replace(/[._-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Event';
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function ActivityLog() {
  const timezone = useStore((s) => s.user?.settings.timezone);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  const load = () => {
    setError('');
    api
      .audit(100)
      .then(({ entries: list }) => setEntries(list))
      .catch((err: unknown) => setError(errorText(err)));
  };
  useEffect(() => {
    if (open && entries === null) load();
  }, [open]);

  return (
    <section className="setting-card" aria-labelledby="audit-h">
      <div className="setting-row">
        <div>
          <h2 id="audit-h">Activity log</h2>
          <p className="muted">The last 100 things done on this account: sign-ins, approvals, vault use, runs.</p>
        </div>
        <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => (open ? setOpen(false) : (setOpen(true), entries !== null && load()))}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {open ? (
        error ? (
          <ErrorNote>{error}</ErrorNote>
        ) : entries === null ? (
          <Loading label="Loading activity" />
        ) : entries.length ? (
          <ol className="audit">
            {entries.map((entry) => {
              const detail = Object.entries(entry.detail ?? {});
              return (
                <li key={entry.id}>
                  <time dateTime={entry.at}>{formatDateTime(entry.at, timezone)}</time>
                  <div>
                    <p className="audit-event">{humanise(entry.event)}</p>
                    {detail.length ? (
                      <p className="audit-detail">
                        {detail.map(([key, value]) => (
                          <span key={key}>
                            <span className="audit-key">{key.replace(/_/g, ' ')}</span> {show(value)}
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted">Nothing recorded yet.</p>
        )
      ) : null}
    </section>
  );
}

// ───────────────────────── Page ─────────────────────────

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
    <Dialog title="Delete your account?" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <p>
          This erases everything: your conversations, memories, panels, projects, scheduled tasks and every secret in the vault.
          <strong> It is permanent. There is no undo and no backup to restore from.</strong>
        </p>
        <p className="muted">Want a copy first? Close this and use “Export my data”.</p>
        <label className="field">
          <span>Type your password to confirm</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
        </label>
        <ErrorNote>{error}</ErrorNote>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Keep my account
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

export function SettingsPage() {
  const user = useStore((s) => s.user);
  const [name, setName] = useState(user?.name ?? '');
  const [timezone, setTimezone] = useState(user?.settings.timezone ?? 'UTC');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [memBusy, setMemBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const serverZone = user?.settings.timezone;
  useEffect(() => {
    if (serverZone) setTimezone(serverZone); // e.g. after accepting the timezone offer
  }, [serverZone]);
  const zones = useMemo(() => {
    const list = timezoneList();
    return list.includes(timezone) ? list : [timezone, ...list];
  }, [timezone]);
  if (!user) return null;
  const dirty = name.trim() !== user.name || timezone !== user.settings.timezone;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const { user: next } = await api.updateSettings({ name: name.trim(), timezone });
      applyUser(next);
      setSaved(true);
      void refresh('tasks').catch(() => {});
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const setMemory = async (next: boolean) => {
    setMemBusy(true);
    try {
      const res = await api.updateSettings({ memoryEnabled: next });
      applyUser(res.user);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setMemBusy(false);
    }
  };

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

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <TimezoneOffer />

      <section className="setting-card" aria-labelledby="profile-h">
        <h2 id="profile-h">You</h2>
        <form className="stack" onSubmit={(e) => void save(e)}>
          <div className="field-row">
            <label className="field">
              <span>Name</span>
              <input type="text" value={name} onChange={(e) => (setName(e.target.value), setSaved(false))} required maxLength={80} autoComplete="name" />
            </label>
            <label className="field">
              <span>Email</span>
              <input type="email" value={user.email} readOnly aria-describedby="email-hint" />
              <small id="email-hint" className="hint">
                Your sign-in. It cannot be changed here.
              </small>
            </label>
          </div>
          <label className="field">
            <span>Timezone</span>
            <select value={timezone} onChange={(e) => (setTimezone(e.target.value), setSaved(false))} aria-describedby="tz-hint">
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <small id="tz-hint" className="hint">
              Used for scheduled tasks and for telling Vector what time it is for you.
            </small>
          </label>
          <ErrorNote>{error}</ErrorNote>
          <div className="form-foot">
            <button type="submit" className="btn btn-primary" disabled={saving || !dirty || !name.trim()}>
              {saving ? <Spinner /> : null}
              Save
            </button>
            {saved && !dirty ? (
              <span className="saved-note" role="status">
                <Icon name="check" size={15} /> Saved
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="setting-card" aria-labelledby="memset-h">
        <div className="setting-row">
          <div>
            <h2 id="memset-h">Memory</h2>
            <p id="memset-desc" className="muted">
              {user.settings.memoryEnabled
                ? 'On. Vector reads what it has learned about you and saves new things as you talk.'
                : 'Off. Vector neither reads nor saves memories. Existing ones are kept until you delete them.'}{' '}
              <a href="#/memory">See what it remembers</a>
            </p>
          </div>
          <Switch checked={user.settings.memoryEnabled} disabled={memBusy} onChange={(next) => void setMemory(next)} label="Memory" describedBy="memset-desc" />
        </div>
      </section>

      <AutoApprove />
      <ActivityLog />

      <section className="setting-card" aria-labelledby="data-h">
        <div className="setting-row">
          <div>
            <h2 id="data-h">Your data</h2>
            <p className="muted">Download everything Vector holds about you as one JSON file. Vault secrets are never included.</p>
          </div>
          <button type="button" className="btn btn-sm" disabled={exporting} onClick={() => void exportData()}>
            {exporting ? <Spinner /> : <Icon name="download" size={15} />}
            Export my data
          </button>
        </div>
      </section>

      <section className="setting-card" aria-labelledby="account-h">
        <h2 id="account-h">Account</h2>
        <div className="setting-row">
          <p className="muted">Signed in as {user.email}.</p>
          <button type="button" className="btn btn-sm" onClick={() => void signOut()}>
            <Icon name="logout" size={15} />
            Sign out
          </button>
        </div>
        <div className="setting-row danger-zone">
          <div>
            <h3>Delete account</h3>
            <p className="muted">Erases your account and everything in it. This cannot be undone.</p>
          </div>
          <button type="button" className="btn btn-sm btn-danger-quiet" onClick={() => setDeleting(true)}>
            Delete account…
          </button>
        </div>
      </section>

      {deleting ? <DeleteAccountDialog onClose={() => setDeleting(false)} /> : null}
    </div>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import type { VaultCreateBody, VaultItem, VaultKind } from '../../../shared/types.ts';
import { refresh } from '../actions.ts';
import { api, errorText } from '../api.ts';
import { ConfirmDialog, Empty, ErrorNote, Icon, Loading, PageHeader, Spinner, type IconName } from '../components/ui.tsx';
import { useStore } from '../store.ts';

const KINDS: { kind: VaultKind; label: string; icon: IconName }[] = [
  { kind: 'login', label: 'Login', icon: 'vault' },
  { kind: 'card', label: 'Card', icon: 'card' },
  { kind: 'note', label: 'Secure note', icon: 'note' },
];
const KIND_LABEL: Record<VaultKind, string> = { login: 'Login', card: 'Card', note: 'Secure note' };
const KIND_ICON: Record<VaultKind, IconName> = { login: 'vault', card: 'card', note: 'note' };

const BLANK = { label: '', origin: '', username: '', password: '', number: '', expMonth: '', expYear: '', cvc: '', nameOnCard: '', text: '' };

function VaultForm({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState<VaultKind>('login');
  const [f, setF] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key: keyof typeof BLANK) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let body: VaultCreateBody;
    if (kind === 'login') body = { kind, label: f.label.trim(), origin: f.origin.trim(), username: f.username, password: f.password };
    else if (kind === 'card')
      body = { kind, label: f.label.trim(), number: f.number.replace(/[\s-]/g, ''), expMonth: f.expMonth.trim(), expYear: f.expYear.trim(), cvc: f.cvc.trim(), nameOnCard: f.nameOnCard.trim() };
    else body = { kind, label: f.label.trim(), text: f.text };
    setBusy(true);
    setError('');
    try {
      await api.createVaultItem(body);
      setF(BLANK); // secrets do not linger in page state after they are saved
      await refresh('vault');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const secret = { type: 'password', autoComplete: 'off', spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } as const;

  return (
    <form className="vault-form stack" onSubmit={(e) => void submit(e)} autoComplete="off" aria-label="Save something to the vault">
      <div className="segmented" role="group" aria-label="What are you saving?">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            aria-pressed={kind === k.kind}
            onClick={() => {
              setKind(k.kind);
              setF((prev) => ({ ...BLANK, label: prev.label })); // never carry a secret across kinds
              setError('');
            }}
          >
            <Icon name={k.icon} size={15} />
            {k.label}
          </button>
        ))}
      </div>

      <label className="field">
        <span>Label</span>
        <input type="text" value={f.label} onChange={set('label')} required maxLength={80} autoComplete="off" placeholder={kind === 'login' ? 'Electricity board' : kind === 'card' ? 'Everyday debit card' : 'Passport number'} />
      </label>

      {kind === 'login' ? (
        <>
          <label className="field">
            <span>Website</span>
            <input type="url" value={f.origin} onChange={set('origin')} required autoComplete="off" inputMode="url" placeholder="https://example.com" aria-describedby="origin-hint" />
            <small id="origin-hint" className="hint">
              The only site this login may ever be typed into.
            </small>
          </label>
          <div className="field-row">
            <label className="field">
              <span>Username</span>
              <input type="text" value={f.username} onChange={set('username')} required autoComplete="off" spellCheck={false} autoCapitalize="off" />
            </label>
            <label className="field">
              <span>Password</span>
              <input {...secret} value={f.password} onChange={set('password')} required />
            </label>
          </div>
        </>
      ) : null}

      {kind === 'card' ? (
        <>
          <label className="field">
            <span>Name on card</span>
            <input type="text" value={f.nameOnCard} onChange={set('nameOnCard')} required autoComplete="off" />
          </label>
          <label className="field">
            <span>Card number</span>
            <input {...secret} value={f.number} onChange={set('number')} required inputMode="numeric" />
          </label>
          <div className="field-row field-row-3">
            <label className="field">
              <span>Month</span>
              <input type="text" value={f.expMonth} onChange={set('expMonth')} required inputMode="numeric" pattern="(0?[1-9]|1[0-2])" maxLength={2} placeholder="MM" autoComplete="off" />
            </label>
            <label className="field">
              <span>Year</span>
              <input type="text" value={f.expYear} onChange={set('expYear')} required inputMode="numeric" pattern="(\d{2}|\d{4})" maxLength={4} placeholder="YYYY" autoComplete="off" />
            </label>
            <label className="field">
              <span>Security code</span>
              <input {...secret} value={f.cvc} onChange={set('cvc')} required inputMode="numeric" maxLength={4} />
            </label>
          </div>
        </>
      ) : null}

      {kind === 'note' ? (
        <label className="field">
          <span>Secret text</span>
          <textarea className="masked" rows={3} value={f.text} onChange={set('text')} required autoComplete="off" spellCheck={false} autoCapitalize="off" aria-describedby="note-hint" />
          <small id="note-hint" className="hint">
            Hidden as you type, like a password.
          </small>
        </label>
      ) : null}

      <ErrorNote>{error}</ErrorNote>
      <div className="vault-form-foot">
        <p className="muted small">
          <Icon name="vault" size={14} /> Write-only. After you save, nobody can read this back — not you, not this browser, not the AI model.
        </p>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          Save to vault
        </button>
      </div>
    </form>
  );
}

function VaultRow({ item }: { item: VaultItem }) {
  const [deleting, setDeleting] = useState(false);
  return (
    <li className="row">
      <span className="row-icon">
        <Icon name={KIND_ICON[item.kind] ?? 'vault'} />
      </span>
      <div className="row-text">
        <p className="row-title">{item.label}</p>
        <p className="row-sub">
          <span className="tag">{KIND_LABEL[item.kind] ?? item.kind}</span>
          {item.origin ? <span className="mono">{item.origin}</span> : null}
          {item.hint ? <span className="mono">{item.hint}</span> : null}
        </p>
      </div>
      <div className="row-actions">
        <button type="button" className="icon-btn" aria-label={`Delete from vault: ${item.label}`} onClick={() => setDeleting(true)}>
          <Icon name="trash" size={16} />
        </button>
      </div>
      {deleting ? (
        <ConfirmDialog
          title="Delete from the vault?"
          body={<p>“{item.label}” will be erased. Vector will not be able to use it again, and it cannot be recovered.</p>}
          confirmLabel="Delete"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteVaultItem(item.id);
            await refresh('vault');
          }}
        />
      ) : null}
    </li>
  );
}

export function VaultPage() {
  const items = useStore((s) => s.vault);
  const [loadError, setLoadError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    refresh('vault').catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  return (
    <div className="page">
      <PageHeader title="Vault" lead="Logins, cards and secure notes that Vector can use for you, without ever seeing them." />

      <section className="callout" aria-label="How the vault works">
        <span className="callout-icon">
          <Icon name="vault" />
        </span>
        <div>
          <h2>Secrets go in. They do not come out.</h2>
          <ul>
            <li>Once saved, a secret cannot be viewed again — not by you, not by this browser, and never by the AI model.</li>
            <li>The list below shows a label and a masked hint only. To change a secret, delete it and save it again.</li>
            <li>The browser agent types a secret into its matching site only, and only after you approve that use.</li>
          </ul>
        </div>
      </section>

      <section className="setting-card" aria-labelledby="vault-add-h">
        <h2 id="vault-add-h">Save something new</h2>
        <VaultForm onSaved={() => setSaved(true)} />
        {saved ? (
          <p className="saved-note" role="status">
            <Icon name="check" size={15} /> Saved and encrypted. The form has been cleared.
          </p>
        ) : null}
      </section>

      <div className="section-head">
        <h2>In the vault</h2>
        {items?.length ? <span className="count">{items.length}</span> : null}
      </div>
      {items === null ? (
        loadError ? <ErrorNote>{loadError}</ErrorNote> : <Loading label="Loading vault" />
      ) : items.length ? (
        <ul className="rows">
          {items.map((item) => (
            <VaultRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <Empty icon="vault" title="The vault is empty.">
          <p>Save a login and Vector can sign in for you — for example to pay a bill — after asking each time.</p>
        </Empty>
      )}
    </div>
  );
}

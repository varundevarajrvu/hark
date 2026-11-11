import { useState, type FormEvent } from 'react';
import { signIn, signUp } from '../actions.ts';
import { errorText } from '../api.ts';
import { ErrorNote, Icon, Mark, Spinner } from '../components/ui.tsx';

const MIN_PASSWORD = 10;

export function AuthPage() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = mode === 'up';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (creating && password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for your password.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (creating) await signUp(name.trim(), email.trim(), password);
      else await signIn(email.trim(), password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const switchTo = (next: 'in' | 'up') => {
    setMode(next);
    setError('');
  };

  return (
    <div className="auth">
      <section className="auth-brand" aria-label="About Vector">
        <div className="auth-brand-top">
          <span className="brand-mark brand-mark-lg">
            <Mark size={26} />
          </span>
          <span className="brand-name">Vector</span>
        </div>
        <div>
          <h1>One assistant. One thread. Things actually get done.</h1>
          <ul className="auth-points">
            <li>
              <Icon name="arrow" size={16} />
              It remembers what you tell it and acts on your behalf.
            </li>
            <li>
              <Icon name="arrow" size={16} />
              You watch every step, and you can stop it at any time.
            </li>
            <li>
              <Icon name="arrow" size={16} />
              It asks before it spends, sends or signs in.
            </li>
          </ul>
        </div>
        <p className="auth-foot">Self-hosted. Your data stays on this server.</p>
      </section>

      <main className="auth-main">
        <form className="auth-form" onSubmit={(e) => void submit(e)} noValidate={false}>
          <h2>{creating ? 'Create your account' : 'Sign in'}</h2>
          <div className="segmented" role="group" aria-label="Sign in or create an account">
            <button type="button" aria-pressed={!creating} onClick={() => switchTo('in')}>
              Sign in
            </button>
            <button type="button" aria-pressed={creating} onClick={() => switchTo('up')}>
              Create account
            </button>
          </div>

          {creating ? (
            <label className="field">
              <span>Name</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} />
            </label>
          ) : null}
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required inputMode="email" />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={creating ? 'new-password' : 'current-password'}
              required
              minLength={creating ? MIN_PASSWORD : undefined}
              aria-describedby={creating ? 'pw-hint' : undefined}
            />
            {creating ? (
              <small id="pw-hint" className="hint">
                At least {MIN_PASSWORD} characters.
              </small>
            ) : null}
          </label>

          <ErrorNote>{error}</ErrorNote>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? <Spinner /> : null}
            {creating ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </main>
    </div>
  );
}

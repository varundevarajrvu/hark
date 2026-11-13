import { useState, type FormEvent } from 'react';
import { signIn, signUp } from '../actions.ts';
import { errorText } from '../api.ts';
import { Arrow, ErrorNote, Mark, Spinner } from '../components/ui.tsx';

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
    <div className="auth on-ink">
      <div className="vfield" aria-hidden="true" />
      <section className="auth-door" aria-label="About Vector">
        <p className="auth-brand">
          <Mark size={30} />
          <span>Vector</span>
        </p>
        <h1 className="auth-line">
          Say it once.
          <br />
          Consider it <span className="auth-done">done.</span>
        </h1>
        <ul className="auth-points label">
          <li>One thread that remembers</li>
          <li>Every step visible, always stoppable</li>
          <li>Asks before it spends, sends or signs in</li>
        </ul>
      </section>

      <main className="auth-sheet">
        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          <h2 className="sr-only">{creating ? 'Create your account' : 'Sign in'}</h2>
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
            <span>Password{creating ? ` · ${MIN_PASSWORD}+ characters` : ''}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={creating ? 'new-password' : 'current-password'}
              required
              minLength={creating ? MIN_PASSWORD : undefined}
            />
          </label>

          <ErrorNote>{error}</ErrorNote>
          <button type="submit" className="btn btn-primary btn-block btn-verb" disabled={busy}>
            {busy ? <Spinner /> : null}
            {creating ? 'Create account' : 'Sign in'}
            <Arrow />
          </button>
          <p className="label auth-foot">Self-hosted · your data stays on this server</p>
        </form>
      </main>
    </div>
  );
}

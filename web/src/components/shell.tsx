import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { boot } from '../actions.ts';
import type { Route } from '../router.ts';
import { pendingApprovals, setState, useStore } from '../store.ts';
import { ApprovalCard } from './cards.tsx';
import { Dialog, Icon, Mark, Toasts, type IconName } from './ui.tsx';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  match: Route['name'][];
}

const NAV: NavItem[] = [
  { href: '#/', label: 'Home', icon: 'home', match: ['home'] },
  { href: '#/chat', label: 'Chat', icon: 'chat', match: ['chat', 'project', 'thread'] },
  { href: '#/tasks', label: 'Tasks', icon: 'clock', match: ['tasks'] },
  { href: '#/memory', label: 'Memory', icon: 'memory', match: ['memory'] },
  { href: '#/vault', label: 'Vault', icon: 'vault', match: ['vault'] },
  { href: '#/specialties', label: 'Specialties', icon: 'spark', match: ['specialties'] },
  { href: '#/settings', label: 'Settings', icon: 'settings', match: ['settings'] },
];
const TABS = NAV.slice(0, 4);
const MORE = NAV.slice(4);

const setTray = (open: boolean) => setState((s) => (s.trayOpen === open ? s : { ...s, trayOpen: open }));

function ApprovalsButton({ count, compact }: { count: number; compact?: boolean }) {
  return (
    <button
      type="button"
      className={`approvals-btn${count ? ' has-pending' : ''}${compact ? ' is-compact' : ''}`}
      onClick={() => setTray(true)}
      aria-label={count ? `Approvals: ${count} waiting for you` : 'Approvals: none waiting'}
    >
      <Icon name="shield" />
      {compact ? null : <span>Approvals</span>}
      {count ? <span className="badge">{count}</span> : null}
    </button>
  );
}

function ApprovalsTray() {
  const approvals = useStore((s) => s.approvals);
  const pending = useMemo(() => pendingApprovals(approvals), [approvals]);
  return (
    <Dialog title={pending.length ? `Waiting for you · ${pending.length}` : 'Approvals'} variant="sheet" onClose={() => setTray(false)}>
      {pending.length ? (
        <div className="stack">
          <p className="muted">Vector has paused on each of these. Nothing is spent, sent or signed in to until you approve.</p>
          {pending.map((a) => (
            <div key={a.id} onClick={(e) => (e.target as HTMLElement).closest('a') && setTray(false)}>
              <ApprovalCard approval={a} showThreadLink />
            </div>
          ))}
        </div>
      ) : (
        <div className="stack">
          <p className="tray-clear">
            <Icon name="check" /> Nothing is waiting for you.
          </p>
          <p className="muted">
            Vector asks here before it spends money, sends something in your name, shares personal details, changes an
            account or uses a saved login — including when a scheduled task runs while you are away.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function StatusLines() {
  const llm = useStore((s) => s.llm);
  const conn = useStore((s) => s.conn);
  return (
    <>
      {llm?.mock ? (
        <p className="statusline" role="status">
          <Icon name="info" size={15} />
          Offline demo model — answers are scripted
        </p>
      ) : llm && !llm.configured ? (
        <p className="statusline statusline-warn" role="status">
          <Icon name="alert" size={15} />
          <span>
            No Claude API credentials on the server — set <code>ANTHROPIC_API_KEY</code>
          </span>
        </p>
      ) : null}
      {conn === 'down' ? (
        <p className="statusline statusline-warn" role="status">
          <Icon name="alert" size={15} />
          Connection lost. Reconnecting — live updates are paused.
        </p>
      ) : null}
    </>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const user = useStore((s) => s.user);
  const approvals = useStore((s) => s.approvals);
  const trayOpen = useStore((s) => s.trayOpen);
  const pending = useMemo(() => pendingApprovals(approvals), [approvals]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef<Set<string> | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const firstRoute = useRef(true);

  // Announce approvals that arrive while the app is open (not the ones already there at load).
  useEffect(() => {
    if (announced.current === null) {
      announced.current = new Set(pending.map((a) => a.id));
      return;
    }
    const fresh = pending.filter((a) => !announced.current?.has(a.id));
    for (const a of fresh) announced.current.add(a.id);
    const newest = fresh[fresh.length - 1];
    if (newest) setAnnouncement(`Approval needed: ${newest.summary}`);
  }, [pending]);

  useEffect(() => {
    setMoreOpen(false);
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [moreOpen]);

  const current = (item: NavItem) => (item.match.includes(route.name) ? 'page' : undefined);
  const first = pending[0];
  const fullHeight = route.name === 'chat' || route.name === 'project' || route.name === 'thread';

  return (
    <div className="app">
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>
        Skip to content
      </button>

      <nav className="rail" aria-label="Primary">
        <a className="brand" href="#/" aria-label="Vector, home">
          <span className="brand-mark">
            <Mark size={18} />
          </span>
          <span className="brand-name">Vector</span>
        </a>
        <ul className="rail-nav">
          {NAV.map((item) => (
            <li key={item.href}>
              <a href={item.href} aria-current={current(item)}>
                <Icon name={item.icon} />
                {item.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="rail-foot">
          <ApprovalsButton count={pending.length} />
          {user ? (
            <a className="rail-user" href="#/settings" title={user.email}>
              <span className="avatar" aria-hidden="true">
                {(user.name || user.email).trim().charAt(0).toUpperCase()}
              </span>
              <span className="rail-user-name">{user.name || user.email}</span>
            </a>
          ) : null}
        </div>
      </nav>

      <div className="stage">
        <header className="topbar">
          <a className="brand" href="#/" aria-label="Vector, home">
            <span className="brand-mark">
              <Mark size={18} />
            </span>
            <span className="brand-name">Vector</span>
          </a>
          <ApprovalsButton count={pending.length} compact />
        </header>

        <StatusLines />

        {first ? (
          <div className="approval-banner">
            <span className="approval-banner-icon">
              <Icon name="shield" />
            </span>
            <p>
              <strong>{pending.length === 1 ? 'Vector needs your approval' : `${pending.length} approvals are waiting`}</strong>
              <span className="approval-banner-summary">{first.summary}</span>
            </p>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setTray(true)}>
              Review
            </button>
          </div>
        ) : null}

        <main id="main" ref={mainRef} tabIndex={-1} className={fullHeight ? 'main main-fixed' : 'main'}>
          {children}
        </main>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {TABS.map((item) => (
          <a key={item.href} href={item.href} aria-current={current(item)}>
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </a>
        ))}
        <button
          type="button"
          aria-expanded={moreOpen}
          aria-controls="more-menu"
          className={MORE.some((m) => m.match.includes(route.name)) ? 'is-current' : undefined}
          onClick={() => setMoreOpen((open) => !open)}
        >
          <Icon name="more" size={20} />
          <span>More</span>
        </button>
        {moreOpen ? (
          <>
            <div className="more-scrim" onClick={() => setMoreOpen(false)} />
            <ul className="more-menu" id="more-menu">
              {MORE.map((item) => (
                <li key={item.href}>
                  <a href={item.href} aria-current={current(item)} onClick={() => setMoreOpen(false)}>
                    <Icon name={item.icon} />
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </nav>

      {trayOpen ? <ApprovalsTray /> : null}
      <Toasts />
      <div className="sr-only" role="alert" aria-live="assertive">
        {announcement}
      </div>
    </div>
  );
}

export function Splash() {
  const bootError = useStore((s) => s.bootError);
  return (
    <div className="splash">
      <span className="brand-mark brand-mark-lg">
        <Mark size={28} />
      </span>
      {bootError ? (
        <>
          <h1>Vector is not answering</h1>
          <p className="muted">{bootError}</p>
          <button type="button" className="btn btn-primary" onClick={() => void boot()}>
            Try again
          </button>
        </>
      ) : (
        <p className="muted" role="status">
          Starting Vector…
        </p>
      )}
    </div>
  );
}

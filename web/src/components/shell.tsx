import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { boot } from '../actions.ts';
import { navigateFromOverlay, type Route } from '../router.ts';
import { pendingApprovals, setState, toast, useStore } from '../store.ts';
import { ApprovalCard, ConsentBar } from './cards.tsx';
import { Dialog, Icon, Mark, Toasts, type IconName } from './ui.tsx';

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  match: Route['name'][];
}

const DOCK: NavItem[] = [
  { href: '#/', label: 'Home', icon: 'home', match: ['home'] },
  { href: '#/chat', label: 'Chat', icon: 'chat', match: ['chat', 'project', 'thread'] },
  { href: '#/tasks', label: 'Tasks', icon: 'clock', match: ['tasks'] },
  { href: '#/memory', label: 'Memory', icon: 'memory', match: ['memory'] },
];
const MORE: (NavItem & { note: string })[] = [
  { href: '#/vault', label: 'Vault', icon: 'vault', match: ['vault'], note: 'Logins, cards, secure notes' },
  { href: '#/specialties', label: 'Specialties', icon: 'spark', match: ['specialties'], note: 'Routines Vector has memorised' },
  { href: '#/settings', label: 'Settings', icon: 'settings', match: ['settings'], note: 'You, approvals, activity, data' },
];

const TITLES: Record<Route['name'], string> = {
  home: 'Vector',
  chat: 'Chat',
  project: 'Project',
  thread: 'Run',
  tasks: 'Tasks',
  memory: 'Memory',
  vault: 'Vault',
  specialties: 'Specialties',
  settings: 'Settings',
  notfound: 'Nowhere',
};

const setTray = (open: boolean) => setState((s) => (s.trayOpen === open ? s : { ...s, trayOpen: open }));

function ApprovalsTray() {
  const approvals = useStore((s) => s.approvals);
  const pending = useMemo(() => pendingApprovals(approvals), [approvals]);
  return (
    <Dialog title={pending.length ? `Waiting on you · ${pending.length}` : 'Approvals'} variant="sheet" onClose={() => setTray(false)}>
      {pending.length ? (
        <div className="stack">
          <p className="muted">Vector has stopped at each of these. Nothing is spent, sent or signed in to until you say so.</p>
          {pending.map((a) => (
            <div
              key={a.id}
              onClick={(e) => {
                const link = (e.target as HTMLElement).closest('a');
                const href = link?.getAttribute('href');
                if (!href) return;
                e.preventDefault();
                navigateFromOverlay(href, () => setTray(false));
              }}
            >
              <ApprovalCard approval={a} showThreadLink />
            </div>
          ))}
        </div>
      ) : (
        <div className="stack">
          <p className="tray-clear">
            <Icon name="check" size={22} /> Nothing is waiting on you.
          </p>
          <p className="muted">
            Vector stops here before it spends money, sends something in your name, shares your details, changes an account or
            uses a saved login. That includes scheduled tasks that run while you are away.
          </p>
        </div>
      )}
    </Dialog>
  );
}

function MoreSheet({ route, onClose }: { route: Route; onClose: () => void }) {
  const user = useStore((s) => s.user);
  return (
    <Dialog title="More" variant="sheet" onClose={onClose}>
      <ul className="more-list">
        {MORE.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              aria-current={item.match.includes(route.name) ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigateFromOverlay(item.href, onClose);
              }}
            >
              <Icon name={item.icon} size={22} />
              <span className="more-text">
                <span className="more-name">{item.label}</span>
                <span className="label">{item.note}</span>
              </span>
              <Icon name="chevron" size={16} />
            </a>
          </li>
        ))}
      </ul>
      {user ? <p className="label more-user">Signed in · {user.email}</p> : null}
    </Dialog>
  );
}

/** Model and connection state as one small mono chip. Tap for the full sentence. */
function StatusChip() {
  const llm = useStore((s) => s.llm);
  const conn = useStore((s) => s.conn);
  let chip: { text: string; full: string; tone: 'quiet' | 'bad' } | null = null;
  if (conn === 'down') chip = { text: 'Offline', full: 'Connection lost. Reconnecting — live updates are paused.', tone: 'bad' };
  else if (llm?.mock) chip = { text: 'Demo', full: 'Offline demo model — answers are scripted', tone: 'quiet' };
  else if (llm && !llm.configured) chip = { text: 'No key', full: 'No Claude API credentials on the server — set ANTHROPIC_API_KEY', tone: 'bad' };
  if (!chip) return null;
  const { full, tone, text } = chip;
  return (
    <button type="button" className={`status-chip status-${tone}`} aria-label={full} onClick={() => toast(full, tone === 'bad' ? 'error' : 'info')}>
      <span className="status-chip-face" role="status">
        {text}
      </span>
    </button>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const approvals = useStore((s) => s.approvals);
  const trayOpen = useStore((s) => s.trayOpen);
  const projectName = useStore((s) => (route.name === 'project' ? s.projects.find((p) => p.id === route.id)?.name : undefined));
  const threadLabel = useStore((s) => (route.name === 'thread' ? s.threadLabels[route.id] : undefined));
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
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);

  const title = projectName ?? threadLabel ?? TITLES[route.name];
  const hasFloor = route.name === 'home' || route.name === 'chat' || route.name === 'project' || route.name === 'thread' || route.name === 'memory';
  const hasBar = !hasFloor && pending.length > 0;
  const moreCurrent = MORE.some((m) => m.match.includes(route.name));

  return (
    <div className="app">
      <button type="button" className="skip-link" onClick={() => mainRef.current?.focus()}>
        Skip to content
      </button>

      <header className="bar">
        <a className="bar-mark" href="#/" aria-label="Vector, home">
          <Mark size={26} />
        </a>
        <h1 className="bar-title">{title}</h1>
        <StatusChip />
        <button
          type="button"
          className={`consent-pill${pending.length ? ' has-pending' : ''}`}
          onClick={() => setTray(true)}
          aria-label={pending.length ? `Approvals: ${pending.length} waiting on you` : 'Approvals: none waiting'}
        >
          <Icon name="shield" size={18} />
          {pending.length ? <span className="consent-pill-count">{pending.length}</span> : null}
        </button>
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className={hasFloor ? 'main main-fixed' : hasBar ? 'main has-bar' : 'main'}>
        {children}
      </main>

      {hasBar ? (
        <div className="floor">
          <ConsentBar />
        </div>
      ) : null}

      <nav className="dock" aria-label="Primary">
        {DOCK.map((item) => (
          <a key={item.href} href={item.href} aria-current={item.match.includes(route.name) ? 'page' : undefined}>
            <Icon name={item.icon} size={21} />
            <span>{item.label}</span>
          </a>
        ))}
        <button type="button" aria-haspopup="dialog" className={moreCurrent ? 'is-current' : undefined} onClick={() => setMoreOpen(true)}>
          <Icon name="more" size={21} />
          <span>More</span>
        </button>
      </nav>

      {moreOpen ? <MoreSheet route={route} onClose={() => setMoreOpen(false)} /> : null}
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
    <div className="splash on-ink">
      <div className="vfield" aria-hidden="true" />
      <span className="splash-mark">
        <Mark size={64} />
      </span>
      {bootError ? (
        <>
          <h1>Vector is not answering.</h1>
          <p className="muted">{bootError}</p>
          <button type="button" className="btn btn-primary" onClick={() => void boot()}>
            Try again
          </button>
        </>
      ) : (
        <p className="label" role="status">
          Starting
        </p>
      )}
    </div>
  );
}

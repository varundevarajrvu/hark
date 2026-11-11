import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { errorText } from '../api.ts';
import { dismissToast, useStore } from '../store.ts';

// ───────────────────────── Mark & icons ─────────────────────────

/** The Vector mark: an origin point and an arrow leaving it. Magnitude and direction. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="5.2" cy="18.8" r="2.3" fill="currentColor" />
      <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.6 15.4 19 5" />
        <path d="M11.5 5H19v7.5" />
      </g>
    </svg>
  );
}

const PATHS = {
  home: 'M4 11.5 12 4l8 7.5M6.5 9.8V20h11V9.8',
  chat: 'M5 5h14v11H10l-5 4z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  memory: 'M6 4h12v16l-6-4-6 4z',
  vault: 'M5 10h14v10H5zM8 10V7a4 4 0 0 1 8 0v3M12 14v2.5',
  spark: 'M5 6h10M5 12h14M5 18h7',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5',
  shield: 'M12 3 5 6v5.5c0 4.3 2.9 8 7 9.5 4.1-1.5 7-5.2 7-9.5V6z',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  arrow: 'M6 18 18 6M9 6h9v9',
  send: 'M12 19V5M5.5 11.5 12 5l6.5 6.5',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  play: 'M8 5.5v13l10-6.5z',
  reply: 'M10 7 4.5 12l5.5 5M5 12h8.5a6 6 0 0 1 6 6v1',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.6 2.5 4 5.6 4 9s-1.4 6.500-4 9c-2.6-2.5-4-5.600-4-9s1.400-6.500 4-9z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  block: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.700 5.700l12.600 12.600',
  alert: 'M12 4 2.500 20h19zM12 10v4.500M12 17.300v.2',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.500v.2',
  download: 'M12 4v11M7 10.500l5 5 5-5M5 20h14',
  logout: 'M14 4h5v16h-5M4 12h11M11 8l4 4-4 4',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  note: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3',
  folder: 'M3 6h6l2 2.500h10V19H3z',
  panel: 'M4 5h16v14H4zM4 9.500h16M9.500 9.500V19',
  chevron: 'm9 6 6 6-6 6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner" role={label ? 'status' : undefined} aria-hidden={label ? undefined : true}>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

// ───────────────────────── Small controls ─────────────────────────

export function Switch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="error-note" role="alert">
      <Icon name="alert" size={16} />
      <span>{children}</span>
    </p>
  );
}

export function PageHeader(props: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1>{props.title}</h1>
        {props.lead ? <p className="lead">{props.lead}</p> : null}
      </div>
      {props.actions ? <div className="page-header-actions">{props.actions}</div> : null}
    </header>
  );
}

export function Empty(props: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={props.icon} size={20} />
      </span>
      <div className="empty-body">
        <p className="empty-title">{props.title}</p>
        {props.children}
      </div>
    </div>
  );
}

/** An example prompt the user can press to send. */
export function PromptChip({ text, onPick, disabled }: { text: string; onPick: (text: string) => void; disabled?: boolean }) {
  return (
    <button type="button" className="prompt-chip" onClick={() => onPick(text)} disabled={disabled}>
      <span>{text}</span>
      <Icon name="arrow" size={14} />
    </button>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner label={label} />
      <span aria-hidden="true">{label}…</span>
    </div>
  );
}

// ───────────────────────── Dialogs ─────────────────────────

export function Dialog(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  variant?: 'modal' | 'sheet' | 'lightbox';
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${props.variant ?? 'modal'}${props.wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onClick={(e) => {
        if (e.target === ref.current) props.onClose(); // a click on the backdrop
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-header">
          <h2 id={titleId}>{props.title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="dialog-body">{props.children}</div>
      </div>
    </dialog>
  );
}

export function ConfirmDialog(props: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await props.onConfirm();
      props.onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title={props.title} onClose={props.onClose}>
      <div className="stack">
        <div className="confirm-body">{props.body}</div>
        <ErrorNote>{error}</ErrorNote>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={props.onClose} disabled={busy}>
            Keep it
          </button>
          <button type="button" className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => void confirm()} disabled={busy}>
            {busy ? <Spinner /> : null}
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ───────────────────────── Toasts ─────────────────────────

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          <Icon name={t.tone === 'error' ? 'alert' : 'info'} size={16} />
          <span className="toast-text">{t.text}</span>
          {t.href ? (
            <a href={t.href} onClick={() => dismissToast(t.id)}>
              {t.hrefLabel ?? 'Open'}
            </a>
          ) : null}
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

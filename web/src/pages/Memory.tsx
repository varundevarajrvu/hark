import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Memory } from '../../../shared/types.ts';
import { refresh } from '../actions.ts';
import { api, errorText } from '../api.ts';
import { ConsentBar } from '../components/cards.tsx';
import { ConfirmDialog, Dialog, ErrorNote, Icon, Loading, Spinner } from '../components/ui.tsx';
import { setState, toast, useStore } from '../store.ts';

const EXAMPLES = ["I'm vegetarian", 'I prefer aisle seats', 'My sister Divya lives in Pune'];
const GENERAL = 'general';

function learned(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const options: Intl.DateTimeFormatOptions = sameYear ? { day: 'numeric', month: 'short' } : { month: 'short', year: 'numeric' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-GB', options).format(date);
  }
}

/** Categories A→Z, with uncategorised memories last as "general". */
function groupByCategory(memories: Memory[]): { name: string; items: Memory[] }[] {
  const groups = new Map<string, Memory[]>();
  for (const memory of memories) {
    const name = memory.category.trim().toLowerCase() || GENERAL;
    const list = groups.get(name);
    if (list) list.push(memory);
    else groups.set(name, [memory]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === GENERAL ? 1 : b === GENERAL ? -1 : a.localeCompare(b)))
    .map(([name, items]) => ({ name, items }));
}

// ───────────────────────── Edit sheet ─────────────────────────

function MemorySheet({ memory, timezone, onClose }: { memory: Memory; timezone?: string; onClose: () => void }) {
  const [content, setContent] = useState(memory.content);
  const [busy, setBusy] = useState<'save' | 'forget' | null>(null);
  const [error, setError] = useState('');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError('');
    try {
      await api.updateMemory(memory.id, content.trim());
      await refresh('memories');
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy('forget');
    setError('');
    try {
      await api.deleteMemory(memory.id);
      await refresh('memories');
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <Dialog title="Memory" variant="sheet" onClose={onClose}>
      <form className="stack" onSubmit={(e) => void save(e)}>
        <p className="mem-sheet-meta">
          <span className="tag">{memory.category.trim() || GENERAL}</span>
          <span className="label">Learned {learned(memory.createdAt, timezone)}</span>
        </p>
        <label className="field">
          <span>What Vector knows</span>
          <textarea className="mem-edit" rows={3} value={content} onChange={(e) => setContent(e.target.value)} required maxLength={2000} />
        </label>
        <ErrorNote>{error}</ErrorNote>
        <button type="submit" className="btn btn-primary btn-block btn-verb" disabled={busy !== null || !content.trim() || content.trim() === memory.content}>
          {busy === 'save' ? <Spinner /> : null}
          Save
        </button>
        <button type="button" className="btn btn-danger-quiet" disabled={busy !== null} onClick={() => void forget()}>
          {busy === 'forget' ? <Spinner /> : null}
          Forget this
        </button>
      </form>
    </Dialog>
  );
}

// ───────────────────────── Teach pill ─────────────────────────

function TeachPill({ categories, seed }: { categories: string[]; seed: { text: string; n: number } }) {
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!seed.n) return;
    setText(seed.text);
    input.current?.focus();
  }, [seed]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    setError('');
    try {
      const tag = category.trim();
      await api.createMemory({ content, ...(tag ? { category: tag } : {}) });
      setText('');
      setPicking(false);
      await refresh('memories');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="composer teach" onSubmit={(e) => void submit(e)} aria-label="Teach Vector something">
      <ErrorNote>{error}</ErrorNote>
      {picking ? (
        <div className="teach-tags" role="group" aria-label="Category">
          <button type="button" className="chip" aria-pressed={!category.trim()} onClick={() => (setCategory(''), setPicking(false))}>
            {GENERAL}
          </button>
          {categories.map((name) => (
            <button key={name} type="button" className="chip" aria-pressed={category.trim().toLowerCase() === name} onClick={() => (setCategory(name), setPicking(false))}>
              {name}
            </button>
          ))}
          <input type="text" className="teach-new" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="new category" aria-label="New category" maxLength={40} autoCapitalize="off" />
        </div>
      ) : null}
      <div className="composer-pill">
        <input
          ref={input}
          type="text"
          className="teach-input"
          value={text}
          onChange={(e) => (setText(e.target.value), error && setError(''))}
          aria-label="Something Vector should know about you"
          placeholder="Teach Vector something"
          maxLength={2000}
          enterKeyHint="done"
        />
        <button type="button" className="teach-tag" aria-expanded={picking} aria-label={`Category: ${category.trim() || GENERAL}. Change`} onClick={() => setPicking((open) => !open)}>
          {category.trim() || GENERAL}
        </button>
        <button type="submit" className="composer-btn composer-send" disabled={!text.trim() || busy} aria-label="Save memory">
          {busy ? <Spinner /> : <Icon name="plus" size={20} />}
        </button>
      </div>
    </form>
  );
}

// ───────────────────────── Page ─────────────────────────

export function MemoryPage() {
  const memories = useStore((s) => s.memories);
  const user = useStore((s) => s.user);
  const enabled = user?.settings.memoryEnabled ?? true;
  const timezone = user?.settings.timezone;
  const [loadError, setLoadError] = useState('');
  const [toggling, setToggling] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [seed, setSeed] = useState({ text: '', n: 0 });

  useEffect(() => {
    refresh('memories').catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  const groups = useMemo(() => groupByCategory(memories ?? []), [memories]);
  const categories = useMemo(() => groups.map((g) => g.name).filter((name) => name !== GENERAL), [groups]);
  const count = memories?.length ?? 0;

  const toggle = async () => {
    setToggling(true);
    try {
      const { user: next } = await api.updateSettings({ memoryEnabled: !enabled });
      setState((s) => ({ ...s, user: next }));
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setToggling(false);
    }
  };

  return (
    <>
      <div className="home-scroll">
        <div className={`page memory${enabled ? '' : ' is-off'}`}>
          <header className="mem-hero">
            {memories !== null && count === 0 ? <div className="vfield" aria-hidden="true" /> : null}
            <h2 className="mem-headline">
              {memories === null ? (
                <span className="mem-words">Memory</span>
              ) : count === 0 ? (
                <span className="mem-words">Nothing yet.</span>
              ) : (
                <>
                  <span className="mem-num">{count}</span>
                  <span className="mem-words">
                    thing{count === 1 ? '' : 's'} Vector
                    <br />
                    knows about you
                  </span>
                </>
              )}
            </h2>
            <div className="mem-state">
              <button type="button" role="switch" aria-checked={enabled} className={`state-chip${enabled ? ' is-on' : ''}`} disabled={toggling} onClick={() => void toggle()}>
                <span className={enabled ? 'pulse' : 'state-dot'} aria-hidden="true" />
                Memory {enabled ? 'on' : 'off'}
              </button>
              <p className="mem-means">{enabled ? 'Vector reads these and adds to them as you talk.' : 'Vector is neither reading nor saving these.'}</p>
            </div>
          </header>

          {memories === null ? (
            loadError ? <ErrorNote>{loadError}</ErrorNote> : <Loading label="Loading memories" />
          ) : count === 0 ? (
            <section className="mem-empty" aria-label="Examples">
              <p className="muted">Tell it once and it stops asking. Try one of these.</p>
              <div className="prompt-grid">
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" className="prompt-chip" onClick={() => setSeed((prev) => ({ text: example, n: prev.n + 1 }))}>
                    <span>{example}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <>
              {groups.map((group) => (
                <section key={group.name} className="mem-group" aria-label={`${group.name}, ${group.items.length}`}>
                  <h3 className="label mem-group-head">
                    <span>{group.name}</span>
                    <span>{String(group.items.length).padStart(2, '0')}</span>
                  </h3>
                  <ul>
                    {group.items.map((memory) => (
                      <li key={memory.id}>
                        <button type="button" className="mem-row" onClick={() => setEditing(memory)} aria-haspopup="dialog">
                          <span className="mem-text">{memory.content}</span>
                          <span className="label mem-date">{learned(memory.createdAt, timezone)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <button type="button" className="danger-row" onClick={() => setForgetting(true)}>
                <span>Forget everything</span>
                <span className="label">
                  {count} memor{count === 1 ? 'y' : 'ies'}
                </span>
              </button>
            </>
          )}
        </div>
      </div>

      <div className="floor">
        <ConsentBar />
        <TeachPill categories={categories} seed={seed} />
      </div>

      {editing ? <MemorySheet memory={editing} timezone={timezone} onClose={() => setEditing(null)} /> : null}
      {forgetting ? (
        <ConfirmDialog
          title="Forget everything?"
          body={
            <p>
              All {count} memories are deleted for good. Vector starts from a blank slate. This cannot be undone.
            </p>
          }
          confirmLabel="Forget everything"
          danger
          onClose={() => setForgetting(false)}
          onConfirm={async () => {
            await api.forgetEverything();
            await refresh('memories');
          }}
        />
      ) : null}
    </>
  );
}

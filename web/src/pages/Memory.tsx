import { useEffect, useState, type FormEvent } from 'react';
import type { Memory } from '../../../shared/types.ts';
import { refresh, sendMessage } from '../actions.ts';
import { api, errorText } from '../api.ts';
import { ConfirmDialog, Empty, ErrorNote, Icon, Loading, PageHeader, PromptChip, Spinner, Switch } from '../components/ui.tsx';
import { navigate } from '../router.ts';
import { toast, useStore } from '../store.ts';

function MemoryRow({ memory }: { memory: Memory }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.updateMemory(memory.id, content.trim());
      await refresh('memories');
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteMemory(memory.id);
      await refresh('memories');
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <li className="row row-editing">
        <form className="stack stack-tight" onSubmit={(e) => void save(e)}>
          <label className="field">
            <span className="sr-only">Memory</span>
            <textarea rows={2} value={content} onChange={(e) => setContent(e.target.value)} required maxLength={2000} autoFocus />
          </label>
          <ErrorNote>{error}</ErrorNote>
          <div className="row-actions">
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !content.trim()}>
              {busy ? <Spinner /> : null}
              Save
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setEditing(false);
                setContent(memory.content);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }
  return (
    <li className="row">
      <div className="row-text">
        <p>{memory.content}</p>
        {memory.category ? <span className="tag">{memory.category}</span> : null}
      </div>
      <div className="row-actions">
        <button type="button" className="icon-btn" aria-label={`Edit memory: ${memory.content}`} onClick={() => setEditing(true)}>
          <Icon name="edit" size={16} />
        </button>
        <button type="button" className="icon-btn" aria-label={`Delete memory: ${memory.content}`} disabled={busy} onClick={() => void remove()}>
          <Icon name="trash" size={16} />
        </button>
      </div>
    </li>
  );
}

export function MemoryPage() {
  const memories = useStore((s) => s.memories);
  const enabled = useStore((s) => s.user?.settings.memoryEnabled ?? true);
  const mainThreadId = useStore((s) => s.mainThreadId);
  const [loadError, setLoadError] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toggling, setToggling] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  useEffect(() => {
    refresh('memories').catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createMemory({ content: content.trim(), ...(category.trim() ? { category: category.trim() } : {}) });
      setContent('');
      setCategory('');
      await refresh('memories');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (next: boolean) => {
    setToggling(true);
    try {
      await api.updateSettings({ memoryEnabled: next });
      await refresh('settings');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setToggling(false);
    }
  };

  const ask = (text: string) => {
    if (!mainThreadId) return;
    void sendMessage(mainThreadId, text).then((failure) => (failure ? toast(failure, 'error') : navigate('#/chat')));
  };

  return (
    <div className="page">
      <PageHeader title="Memory" lead="What Vector has learned about you. It uses these to answer without asking twice. You can read, correct and delete every one." />

      <section className="setting-card" aria-label="Memory switch">
        <div className="setting-row">
          <div>
            <h2 id="mem-switch">Memory is {enabled ? 'on' : 'off'}</h2>
            <p id="mem-switch-desc" className="muted">
              {enabled
                ? 'Vector reads these memories and saves new ones as you talk.'
                : 'Vector is not reading or saving anything. What is listed below stays until you delete it.'}
            </p>
          </div>
          <Switch checked={enabled} disabled={toggling} onChange={(next) => void toggle(next)} label="Memory" describedBy="mem-switch-desc" />
        </div>
      </section>

      <form className="inline-form" onSubmit={(e) => void add(e)} aria-label="Add a memory">
        <label className="field field-grow">
          <span>Add a memory</span>
          <input type="text" value={content} onChange={(e) => setContent(e.target.value)} placeholder="I'm vegetarian" maxLength={2000} required />
        </label>
        <label className="field field-narrow">
          <span>
            Category <em className="optional">optional</em>
          </span>
          <input type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="food" maxLength={40} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !content.trim()}>
          {busy ? <Spinner /> : <Icon name="plus" size={16} />}
          Add
        </button>
      </form>
      <ErrorNote>{error}</ErrorNote>

      {memories === null ? (
        loadError ? <ErrorNote>{loadError}</ErrorNote> : <Loading label="Loading memories" />
      ) : memories.length ? (
        <>
          <div className="section-head">
            <h2>Remembered</h2>
            <span className="count">{memories.length}</span>
            <button type="button" className="btn btn-sm btn-danger-quiet section-head-action" onClick={() => setForgetting(true)}>
              Forget everything
            </button>
          </div>
          <ul className="rows">
            {memories.map((m) => (
              <MemoryRow key={m.id} memory={m} />
            ))}
          </ul>
        </>
      ) : (
        <Empty icon="memory" title="Nothing remembered yet.">
          <p>Add something above, or just tell Vector in chat:</p>
          <div className="prompt-row">
            <PromptChip text="Remember that I'm vegetarian" onPick={ask} />
            <PromptChip text="Remember that I prefer aisle seats" onPick={ask} />
          </div>
        </Empty>
      )}

      {forgetting ? (
        <ConfirmDialog
          title="Forget everything?"
          body={<p>All {memories?.length ?? 0} memories will be deleted for good. Vector will start from a blank slate. This cannot be undone.</p>}
          confirmLabel="Forget everything"
          danger
          onClose={() => setForgetting(false)}
          onConfirm={async () => {
            await api.forgetEverything();
            await refresh('memories');
          }}
        />
      ) : null}
    </div>
  );
}

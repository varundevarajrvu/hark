import { useEffect, useState } from 'react';
import type { Specialty } from '../../../shared/types.ts';
import { refresh } from '../actions.ts';
import { api, errorText } from '../api.ts';
import { ConfirmDialog, Empty, ErrorNote, Icon, Loading, PageHeader } from '../components/ui.tsx';
import { useStore } from '../store.ts';

function SpecialtyCard({ specialty }: { specialty: Specialty }) {
  const [deleting, setDeleting] = useState(false);
  const steps = specialty.steps
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter(Boolean);
  return (
    <li className="specialty">
      <header className="specialty-head">
        <div>
          <h3>{specialty.name}</h3>
          <p className="muted">{specialty.description}</p>
        </div>
        <button type="button" className="icon-btn" aria-label={`Delete specialty: ${specialty.name}`} onClick={() => setDeleting(true)}>
          <Icon name="trash" size={16} />
        </button>
      </header>
      <details>
        <summary>
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </summary>
        <ol className="specialty-steps">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </details>
      {deleting ? (
        <ConfirmDialog
          title="Delete this specialty?"
          body={<p>Vector will forget how to do “{specialty.name}”. You can teach it again later.</p>}
          confirmLabel="Delete specialty"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteSpecialty(specialty.id);
            await refresh('specialties');
          }}
        />
      ) : null}
    </li>
  );
}

export function SpecialtiesPage() {
  const specialties = useStore((s) => s.specialties);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    refresh('specialties').catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  return (
    <div className="page">
      <PageHeader title="Specialties" lead="Multi-step routines Vector has memorised and can repeat on request, the same way each time." />
      {specialties === null ? (
        loadError ? <ErrorNote>{loadError}</ErrorNote> : <Loading label="Loading specialties" />
      ) : specialties.length ? (
        <ul className="specialties">
          {specialties.map((s) => (
            <SpecialtyCard key={s.id} specialty={s} />
          ))}
        </ul>
      ) : (
        <Empty icon="spark" title="No specialties yet.">
          <p>
            After Vector finishes something you will want again, say “remember how to do this” in chat. The routine appears here
            with every step written out.
          </p>
        </Empty>
      )}
    </div>
  );
}

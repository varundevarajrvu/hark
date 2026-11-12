import { useState, type FormEvent } from 'react';
import type { Id, Project } from '../../../shared/types.ts';
import { refresh } from '../actions.ts';
import { api, errorText } from '../api.ts';
import { ThreadView } from '../components/thread.tsx';
import { ConfirmDialog, Dialog, Empty, ErrorNote, Icon, Spinner } from '../components/ui.tsx';
import { navigate } from '../router.ts';
import { useStore } from '../store.ts';

export function ProjectDialog({ project, onClose }: { project?: Project; onClose: () => void }) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { name: name.trim(), description: description.trim() };
      const saved = project ? await api.updateProject(project.id, body) : await api.createProject(body);
      await refresh('projects');
      onClose();
      if (!project) navigate(`#/project/${encodeURIComponent(saved.project.id)}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={project ? 'Edit project' : 'New project'} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        {project ? null : <p className="muted">A project is its own thread for work that takes more than one sitting.</p>}
        <label className="field">
          <span>Name</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Move to Lisbon" autoFocus />
        </label>
        <label className="field">
          <span>
            What is it for? <em className="optional">optional</em>
          </span>
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="Visa, flat hunt, shipping — everything for the move in March." />
        </label>
        <ErrorNote>{error}</ErrorNote>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? <Spinner /> : null}
            {project ? 'Save' : 'Create project'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectPage({ projectId }: { projectId: Id }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  if (!project) {
    return (
      <div className="page">
        <Empty icon="folder" title="This project does not exist any more.">
          <p>
            <a href="#/">Back to Home</a>
          </p>
        </Empty>
      </div>
    );
  }

  return (
    <>
      <ThreadView
        key={project.threadId}
        threadId={project.threadId}
        emptyTitle="Where to?"
        emptyBody={`Everything said here stays in “${project.name}”. Say where you want to get to.`}
        strip={
          <>
            <span className="label">Project{project.description ? ` · ${project.description}` : ''}</span>
            <button type="button" className="icon-btn" aria-label="Edit project" onClick={() => setEditing(true)}>
              <Icon name="edit" />
            </button>
            <button type="button" className="icon-btn" aria-label="Delete project" onClick={() => setDeleting(true)}>
              <Icon name="trash" />
            </button>
          </>
        }
      />
      {editing ? <ProjectDialog project={project} onClose={() => setEditing(false)} /> : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete this project?"
          body={
            <p>
              “{project.name}” and its whole conversation will be deleted. This cannot be undone.
            </p>
          }
          confirmLabel="Delete project"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteProject(project.id);
            navigate('#/');
            await refresh('projects');
          }}
        />
      ) : null}
    </>
  );
}

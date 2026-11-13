import { useMemo, useState, type FormEvent } from 'react';
import type { ScheduledTask } from '../../../shared/types.ts';
import { labelThread, refresh, sendMessage } from '../actions.ts';
import { api, errorText } from '../api.ts';
import { ConfirmDialog, Dialog, Empty, ErrorNote, Icon, PageHeader, PromptChip, Spinner, Switch, WithArrows } from '../components/ui.tsx';
import { CRON_PRESETS, describeCron, formatDateTime, relativeTime, timezoneList } from '../lib/format.ts';
import { navigate, threadHref } from '../router.ts';
import { toast, useStore } from '../store.ts';
import { TimezoneOffer } from './Settings.tsx';

function TaskDialog({ task, onClose }: { task?: ScheduledTask; onClose: () => void }) {
  const userZone = useStore((s) => s.user?.settings.timezone) ?? 'UTC';
  const [title, setTitle] = useState(task?.title ?? '');
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [cron, setCron] = useState(task?.cron ?? '0 8 * * *');
  const [timezone, setTimezone] = useState(task?.timezone ?? userZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const zones = useMemo(() => {
    const list = timezoneList();
    return list.includes(timezone) ? list : [timezone, ...list];
  }, [timezone]);
  const words = describeCron(cron);
  const fieldCount = cron.trim().split(/\s+/).filter(Boolean).length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { title: title.trim(), prompt: prompt.trim(), cron: cron.trim().replace(/\s+/g, ' '), timezone };
      if (task) await api.updateTask(task.id, body);
      else await api.createTask({ ...body, enabled: true });
      await refresh('tasks');
      onClose();
    } catch (err) {
      setError(errorText(err)); // includes the server's cron / timezone validation message
      setBusy(false);
    }
  };

  return (
    <Dialog title={task ? 'Edit task' : 'New scheduled task'} onClose={onClose} wide>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} placeholder="Morning briefing" autoFocus />
        </label>
        <label className="field">
          <span>What should Vector do each time?</span>
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} required maxLength={8000} placeholder="Give me today's calendar, the weather, and anything urgent in my inbox." />
        </label>

        <fieldset className="fieldset">
          <legend>When</legend>
          <div className="chips" role="group" aria-label="Schedule presets">
            {CRON_PRESETS.map((preset) => (
              <button key={preset.cron} type="button" className="chip" aria-pressed={cron.trim() === preset.cron} onClick={() => setCron(preset.cron)}>
                {preset.label}
              </button>
            ))}
          </div>
          <div className="field-row">
            <label className="field field-cron">
              <span>Cron expression</span>
              <input
                type="text"
                className="mono"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                required
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                aria-describedby="cron-words"
              />
            </label>
            <label className="field">
              <span>Timezone</span>
              <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p id="cron-words" className={`cron-words${words ? ' is-known' : ''}`}>
            {words ? (
              <>
                <Icon name="clock" size={15} />
                {words}, {timezone} time
              </>
            ) : fieldCount !== 5 ? (
              'Five fields: minute, hour, day of month, month, day of week.'
            ) : (
              'Custom schedule. The server checks it when you save and shows the next run in the list.'
            )}
          </p>
        </fieldset>

        <ErrorNote>{error}</ErrorNote>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !prompt.trim()}>
            {busy ? <Spinner /> : null}
            {task ? 'Save changes' : 'Create task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function TaskCard({ task, onEdit }: { task: ScheduledTask; onEdit: () => void }) {
  const [busy, setBusy] = useState<'toggle' | 'run' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const words = describeCron(task.cron);

  const toggle = async (enabled: boolean) => {
    setBusy('toggle');
    try {
      await api.updateTask(task.id, { enabled });
      await refresh('tasks');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const runNow = async () => {
    setBusy('run');
    try {
      const { threadId } = await api.runTask(task.id);
      labelThread(threadId, task.title);
      navigate(threadHref(threadId));
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className={`task${task.enabled ? '' : ' is-off'}`}>
      <div className="task-main">
        <div className="task-title-row">
          <h3>
            <WithArrows text={task.title} />
          </h3>
          <Switch checked={task.enabled} disabled={busy === 'toggle'} onChange={(next) => void toggle(next)} label={`${task.title}: ${task.enabled ? 'on' : 'off'}`} />
        </div>
        <p className="task-when">
          <Icon name="clock" size={15} />
          <span>
            {words ?? 'Custom schedule'} <code>{task.cron}</code> <span className="muted">{task.timezone}</span>
          </span>
        </p>
        <p className="task-prompt">{task.prompt}</p>
      </div>
      <dl className="task-meta">
        <div>
          <dt>Next run</dt>
          <dd>
            {!task.enabled ? 'Paused' : task.nextRunAt ? (
              <>
                {formatDateTime(task.nextRunAt, task.timezone)} <span className="muted">({relativeTime(task.nextRunAt)})</span>
              </>
            ) : (
              'Not scheduled'
            )}
          </dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>
            {task.lastRunAt ? (
              <>
                {formatDateTime(task.lastRunAt, task.timezone)}{' '}
                {task.lastStatus ? (
                  <span className={`pill pill-${task.lastStatus === 'ok' ? 'done' : 'failed'}`}>{task.lastStatus === 'ok' ? 'Succeeded' : 'Failed'}</span>
                ) : null}
              </>
            ) : (
              'Never'
            )}
          </dd>
        </div>
      </dl>
      <div className="task-actions">
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void runNow()}>
          {busy === 'run' ? <Spinner /> : <Icon name="play" size={14} />}
          Run now
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onEdit}>
          <Icon name="edit" size={14} />
          Edit
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setDeleting(true)}>
          <Icon name="trash" size={14} />
          Delete
        </button>
      </div>
      {deleting ? (
        <ConfirmDialog
          title="Delete this task?"
          body={<p>“{task.title}” will stop running and be removed.</p>}
          confirmLabel="Delete task"
          danger
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deleteTask(task.id);
            await refresh('tasks');
          }}
        />
      ) : null}
    </li>
  );
}

export function TasksPage() {
  const tasks = useStore((s) => s.tasks);
  const mainThreadId = useStore((s) => s.mainThreadId);
  const [dialog, setDialog] = useState<{ task?: ScheduledTask } | null>(null);

  const ask = (text: string) => {
    if (!mainThreadId) return;
    void sendMessage(mainThreadId, text).then((failure) => (failure ? toast(failure, 'error') : navigate('#/chat')));
  };

  return (
    <div className="page">
      <PageHeader
        title="Scheduled tasks"
        lead="Work Vector does on a timetable, whether or not you are here. If a run needs to spend, send or sign in, it waits for your approval."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setDialog({})}>
            <Icon name="plus" size={16} />
            New task
          </button>
        }
      />
      <TimezoneOffer />
      {tasks.length ? (
        <ul className="tasks">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} onEdit={() => setDialog({ task })} />
          ))}
        </ul>
      ) : (
        <Empty icon="clock" title="Nothing is scheduled.">
          <p>Create a task here, or just say it in chat:</p>
          <div className="prompt-row">
            <PromptChip text="Every weekday at 8, give me a briefing" onPick={ask} />
            <PromptChip text="On the first of every month, list my subscriptions and what they cost" onPick={ask} />
          </div>
        </Empty>
      )}
      {dialog ? <TaskDialog task={dialog.task} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

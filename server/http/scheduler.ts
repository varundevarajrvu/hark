import { publish } from '../core/bus.ts';
import { audit, tasks, threads } from '../core/db.ts';
import { AgentBusyError } from '../core/runtime.ts';
import type { AgentRuntime } from '../core/runtime.ts';
import { nextRun } from '../core/schedule.ts';
import type { Id, ScheduledTask } from '../../shared/types.ts';

const TICK_MS = 30_000;

type OwnedTask = ScheduledTask & { userId: Id };

/**
 * Start one run of a task in its owner's main thread and record the outcome when it settles.
 * Shared by the scheduler and POST /api/tasks/:id/run. Throws AgentBusyError when the thread is busy.
 */
export function fireTask(agent: AgentRuntime, task: OwnedTask): { runId: Id; threadId: Id } {
  const thread = threads.main(task.userId);
  const startedAt = new Date().toISOString();
  const { runId, done } = agent.startTurn({
    userId: task.userId,
    threadId: thread.id,
    source: 'task',
    unattended: true,
    text: `[Scheduled task: ${task.title}] ${task.prompt}`,
  });
  void done.then((status) => status, () => 'error' as const).then((status) => {
    try {
      // Null when the task or the account was deleted while it ran.
      const row = tasks.update(task.userId, task.id, { lastRunAt: startedAt, lastStatus: status === 'ok' ? 'ok' : 'error' });
      if (row) publish(task.userId, { type: 'invalidate', resource: 'tasks' });
    } catch (err) {
      console.error('[scheduler] could not record the result of task', task.id, err);
    }
  });
  return { runId, threadId: thread.id };
}

function runDue(agent: AgentRuntime, task: OwnedTask, now: Date): void {
  if (task.nextRunAt && Date.parse(task.nextRunAt) > now.getTime()) return;

  let next: Date;
  try {
    next = nextRun(task.cron, task.timezone, now);
  } catch (err) {
    // The stored schedule no longer validates: switch the task off instead of failing every tick.
    tasks.update(task.userId, task.id, { enabled: false, nextRunAt: null });
    audit(task.userId, 'task.disabled', { taskId: task.id, reason: (err as Error).message });
    publish(task.userId, { type: 'invalidate', resource: 'tasks' });
    return;
  }

  if (task.nextRunAt) {
    try {
      fireTask(agent, task);
    } catch (err) {
      if (err instanceof AgentBusyError) return; // nextRunAt untouched: the next tick retries
      // Anything else would fail the same way every 30 s; record it and wait for the next slot.
      console.error('[scheduler] could not start task', task.id, err);
      tasks.update(task.userId, task.id, { nextRunAt: next.toISOString(), lastRunAt: now.toISOString(), lastStatus: 'error' });
      publish(task.userId, { type: 'invalidate', resource: 'tasks' });
      return;
    }
  }
  // Stored before the run finishes so a slow run is not fired again. A task that never had a
  // nextRunAt (created without one) only gets its first slot here.
  tasks.update(task.userId, task.id, { nextRunAt: next.toISOString() });
  publish(task.userId, { type: 'invalidate', resource: 'tasks' });
}

export function startScheduler(deps: { agent: AgentRuntime }): { stop(): void; refresh(): void; tick(now?: Date): Promise<void> } {
  let stopped = false;

  async function tick(now: Date = new Date()): Promise<void> {
    let enabled: OwnedTask[];
    try {
      enabled = tasks.allEnabled();
    } catch (err) {
      console.error('[scheduler] could not load tasks', err);
      return;
    }
    for (const task of enabled) {
      try {
        runDue(deps.agent, task, now);
      } catch (err) {
        console.error('[scheduler] task', task.id, 'failed', err);
      }
    }
  }

  const safeTick = () => {
    if (!stopped) void tick().catch(() => {});
  };
  const timer = setInterval(safeTick, TICK_MS);
  timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    /** Tasks changed: look at them now instead of waiting for the next tick. */
    refresh() {
      setImmediate(safeTick);
    },
    tick,
  };
}

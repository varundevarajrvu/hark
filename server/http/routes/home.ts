import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publish } from '../../core/bus.ts';
import { actions, panels, projects, specialties, tasks, threads } from '../../core/db.ts';
import { AgentBusyError } from '../../core/runtime.ts';
import { isValidTimezone, nextRun } from '../../core/schedule.ts';
import type { AppContext } from '../context.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { fireTask } from '../scheduler.ts';
import { idParam, messageText, startTurnOr409 } from './chat.ts';

const name = z.string().trim().min(1, 'A name is required.').max(200);
const projectBody = z.object({ name, description: z.string().trim().max(2000).optional() });
const panelReplyBody = z.object({ text: messageText(4000) });
const taskBody = z.object({
  title: name,
  prompt: messageText(20_000),
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
});

/** Validates the schedule (400 with a readable reason) and returns the next run as ISO. */
function scheduleOf(cron: string, timezone: string): string {
  if (!isValidTimezone(timezone)) throw new HttpError(400, `Unknown timezone "${timezone}". Use an IANA name such as Europe/London.`);
  try {
    return nextRun(cron, timezone).toISOString();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

export function homeRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ───────────── projects ─────────────
  app.get('/projects', async (req) => ({ projects: projects.list(req.user.id) }));

  app.post('/projects', async (req) => {
    const body = parse(projectBody, req.body);
    const project = projects.create(req.user.id, body.name, body.description ?? '');
    publish(req.user.id, { type: 'invalidate', resource: 'projects' });
    return { project };
  });

  app.patch('/projects/:id', async (req) => {
    const body = parse(projectBody.partial(), req.body);
    const project = projects.update(req.user.id, idParam(req), body);
    if (!project) throw notFound('Project not found.');
    publish(req.user.id, { type: 'invalidate', resource: 'projects' });
    return { project };
  });

  app.delete('/projects/:id', async (req) => {
    const project = projects.get(req.user.id, idParam(req));
    if (!project) throw notFound('Project not found.');
    // Its thread is about to be erased by cascade; stop anything still running in it.
    if (project.threadId) ctx.agent.cancel(req.user.id, project.threadId);
    projects.delete(req.user.id, project.id);
    publish(req.user.id, { type: 'invalidate', resource: 'projects' });
    return { ok: true };
  });

  // ───────────── action buttons ─────────────
  app.get('/actions', async (req) => ({ actions: actions.listActive(req.user.id) }));

  app.post('/actions/:id/run', async (req, reply) => {
    const userId = req.user.id;
    const action = actions.get(userId, idParam(req));
    if (!action || action.status !== 'open') throw notFound('Action not found.');
    const thread = threads.main(userId);
    const setStatus = (status: 'open' | 'running' | 'done') => {
      actions.setStatus(userId, action.id, status);
      publish(userId, { type: 'invalidate', resource: 'actions' });
    };

    setStatus('running');
    let turn: ReturnType<AppContext['agent']['startTurn']>;
    try {
      turn = ctx.agent.startTurn({
        userId, threadId: thread.id, source: 'action',
        text: `[Action button: ${action.verb} — ${action.title}] ${action.prompt}`,
      });
    } catch (err) {
      setStatus('open');
      if (err instanceof AgentBusyError) throw new HttpError(409, err.message);
      throw err;
    }
    void turn.done.then((status) => status, () => 'error' as const).then((status) => {
      try {
        // Leave it alone if it was dismissed (or the account deleted) while it ran.
        if (actions.get(userId, action.id)?.status === 'running') setStatus(status === 'ok' ? 'done' : 'open');
      } catch (err) {
        req.log.error({ err }, 'could not settle action status');
      }
    });
    reply.code(202);
    return { runId: turn.runId, threadId: thread.id };
  });

  app.post('/actions/:id/dismiss', async (req) => {
    const action = actions.get(req.user.id, idParam(req));
    if (!action || (action.status !== 'open' && action.status !== 'running')) throw notFound('Action not found.');
    actions.setStatus(req.user.id, action.id, 'dismissed');
    publish(req.user.id, { type: 'invalidate', resource: 'actions' });
    return { ok: true };
  });

  // ───────────── panels ─────────────
  app.get('/panels', async (req) => ({ panels: panels.list(req.user.id) }));

  app.get('/panels/:id/frame', async (req, reply) => {
    const panel = panels.get(req.user.id, idParam(req));
    if (!panel) throw notFound('Panel not found.');
    // The HTML is model-generated, so untrusted. `sandbox` without allow-same-origin gives the
    // document an opaque origin: no cookies, no API access, even when the URL is opened directly.
    reply
      .header('content-security-policy', PANEL_CSP)
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8');
    return panel.html;
  });

  app.post('/panels/:id/reply', async (req, reply) => {
    const userId = req.user.id;
    const panel = panels.get(userId, idParam(req));
    if (!panel) throw notFound('Panel not found.');
    const { text } = parse(panelReplyBody, req.body);
    const thread = threads.main(userId);
    const { runId } = startTurnOr409(ctx, {
      userId, threadId: thread.id, source: 'panel',
      text: `[About the panel "${panel.title}" (panel id ${panel.id})] ${text}`,
    });
    reply.code(202);
    return { runId, threadId: thread.id };
  });

  app.delete('/panels/:id', async (req) => {
    if (!panels.delete(req.user.id, idParam(req))) throw notFound('Panel not found.');
    publish(req.user.id, { type: 'invalidate', resource: 'panels' });
    return { ok: true };
  });

  // ───────────── scheduled tasks ─────────────
  const tasksChanged = (userId: string) => {
    publish(userId, { type: 'invalidate', resource: 'tasks' });
    ctx.scheduler?.refresh();
  };

  app.get('/tasks', async (req) => ({ tasks: tasks.list(req.user.id) }));

  app.post('/tasks', async (req) => {
    const body = parse(taskBody, req.body);
    const timezone = body.timezone ?? req.user.settings.timezone;
    const next = scheduleOf(body.cron, timezone);
    const enabled = body.enabled !== false;
    const task = tasks.create(req.user.id, {
      title: body.title, prompt: body.prompt, cron: body.cron, timezone, enabled, nextRunAt: enabled ? next : null,
    });
    tasksChanged(req.user.id);
    return { task };
  });

  app.patch('/tasks/:id', async (req) => {
    const cur = tasks.get(req.user.id, idParam(req));
    if (!cur) throw notFound('Task not found.');
    const body = parse(taskBody.partial(), req.body);
    const cron = body.cron ?? cur.cron;
    const timezone = body.timezone ?? cur.timezone;
    const enabled = body.enabled ?? cur.enabled;
    const rescheduled = cron !== cur.cron || timezone !== cur.timezone || enabled !== cur.enabled;
    let nextRunAt: string | null | undefined; // undefined = keep
    if (rescheduled) {
      const next = scheduleOf(cron, timezone);
      nextRunAt = enabled ? next : null;
    }
    const task = tasks.update(req.user.id, cur.id, { title: body.title, prompt: body.prompt, cron, timezone, enabled, nextRunAt });
    if (!task) throw notFound('Task not found.');
    tasksChanged(req.user.id);
    return { task };
  });

  app.delete('/tasks/:id', async (req) => {
    if (!tasks.delete(req.user.id, idParam(req))) throw notFound('Task not found.');
    tasksChanged(req.user.id);
    return { ok: true };
  });

  app.post('/tasks/:id/run', async (req, reply) => {
    const task = tasks.get(req.user.id, idParam(req));
    if (!task) throw notFound('Task not found.');
    let started: { runId: string; threadId: string };
    try {
      started = fireTask(ctx.agent, { ...task, userId: req.user.id });
    } catch (err) {
      if (err instanceof AgentBusyError) throw new HttpError(409, err.message);
      throw err;
    }
    reply.code(202);
    return started;
  });

  // ───────────── specialties ─────────────
  app.get('/specialties', async (req) => ({ specialties: specialties.list(req.user.id) }));

  app.delete('/specialties/:id', async (req) => {
    if (!specialties.delete(req.user.id, idParam(req))) throw notFound('Specialty not found.');
    publish(req.user.id, { type: 'invalidate', resource: 'specialties' });
    return { ok: true };
  });
}

export const PANEL_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

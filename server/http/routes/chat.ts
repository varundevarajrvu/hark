import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config, hasLlmCredentials } from '../../core/config.ts';
import { actions, approvalRows, messages, panels, projects, tasks, threads } from '../../core/db.ts';
import { AgentBusyError } from '../../core/runtime.ts';
import type { Bootstrap } from '../../../shared/types.ts';
import type { AppContext } from '../context.ts';
import { HttpError, notFound, parse } from '../errors.ts';

export const idParam = (req: FastifyRequest): string => (req.params as { id: string }).id;

export const messageText = (max: number) =>
  z.string().max(max, `Keep it under ${max.toLocaleString('en-US')} characters.`).refine((s) => s.trim().length > 0, 'Write something first.');

/** startTurn with the "thread is busy" case mapped to 409. */
export function startTurnOr409(ctx: AppContext, opts: Parameters<AppContext['agent']['startTurn']>[0]) {
  try {
    return ctx.agent.startTurn(opts);
  } catch (err) {
    if (err instanceof AgentBusyError) throw new HttpError(409, err.message);
    throw err;
  }
}

const listQuery = z.object({
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const postBody = z.object({ text: messageText(20_000) });

export function chatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/bootstrap', async (req): Promise<Bootstrap> => {
    const userId = req.user.id;
    return {
      user: req.user,
      mainThreadId: threads.main(userId).id,
      actions: actions.listActive(userId),
      panels: panels.list(userId),
      projects: projects.list(userId),
      tasks: tasks.list(userId),
      pendingApprovals: approvalRows.list(userId, 'pending'),
      llm: { model: config.model, mock: config.mockLlm, configured: config.mockLlm || hasLlmCredentials() },
    };
  });

  app.get('/events', (req, reply) => {
    ctx.streams.open(req.user.id, req, reply);
  });

  const ownThread = (req: FastifyRequest) => {
    const thread = threads.get(req.user.id, idParam(req));
    if (!thread) throw notFound('Thread not found.');
    return thread;
  };

  app.get('/threads/:id/messages', async (req) => {
    const thread = ownThread(req);
    const q = parse(listQuery, req.query);
    return messages.list(req.user.id, thread.id, { before: q.before, limit: q.limit });
  });

  app.post('/threads/:id/messages', async (req, reply) => {
    const thread = ownThread(req);
    const { text } = parse(postBody, req.body);
    const { runId } = startTurnOr409(ctx, { userId: req.user.id, threadId: thread.id, text, source: 'user' });
    reply.code(202);
    return { runId };
  });

  app.post('/threads/:id/cancel', async (req) => {
    ctx.agent.cancel(req.user.id, ownThread(req).id);
    return { ok: true };
  });

  app.get('/threads/:id/status', async (req) => ({ running: ctx.agent.isRunning(ownThread(req).id) }));
}

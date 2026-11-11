import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { expireAllFor, resolveApproval } from '../../core/approvals.ts';
import { publish } from '../../core/bus.ts';
import {
  approvalRows, audit, db, handoffRuns, listAudit, memories, projects, sessions, specialties, tasks, users,
} from '../../core/db.ts';
import { isValidTimezone } from '../../core/schedule.ts';
import { vault } from '../../core/vault.ts';
import { APPROVAL_KINDS } from '../../../shared/types.ts';
import type { ApprovalKind, Id, UserSettings } from '../../../shared/types.ts';
import { AUTH_RATE_LIMIT, clearSessionCookie, verifyPassword } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { HttpError, notFound, parse } from '../errors.ts';
import { idParam } from './chat.ts';

const memoryContent = z.string().trim().min(1, 'Write something to remember.').max(2000);
const memoryBody = z.object({ content: memoryContent, category: z.string().trim().max(50).optional() });

const label = z.string().trim().min(1, 'A label is required.').max(200);
const vaultBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('login'), label, origin: z.string().trim().min(1).max(500),
    username: z.string().min(1).max(200), password: z.string().min(1).max(1000),
  }),
  z.object({
    kind: z.literal('card'), label, number: z.string().trim().min(1).max(40),
    expMonth: z.string().trim().regex(/^(0?[1-9]|1[0-2])$/, 'Use a month from 1 to 12.'),
    expYear: z.string().trim().regex(/^(\d{2}|\d{4})$/, 'Use a 2 or 4 digit year.'),
    cvc: z.string().trim().regex(/^\d{3,4}$/, 'Use the 3 or 4 digit security code.'),
    nameOnCard: z.string().trim().min(1).max(200),
  }),
  z.object({ kind: z.literal('note'), label, text: z.string().min(1).max(10_000) }),
]);

const approvalStatus = z.object({ status: z.enum(['pending', 'approved', 'denied', 'expired']).optional() });
const decisionBody = z.object({ decision: z.enum(['approve', 'deny']) });

const autoApproveShape = Object.fromEntries(APPROVAL_KINDS.map((k) => [k, z.boolean().optional()])) as Record<ApprovalKind, z.ZodOptional<z.ZodBoolean>>;
const settingsBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  memoryEnabled: z.boolean().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  // Strict: a key that is not an approval kind is a 400, not silently stored.
  autoApprove: z.strictObject(autoApproveShape).optional(),
});

const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });
const deleteBody = z.object({ password: z.string().min(1, 'Enter your password to confirm.').max(200) });

type Row = Record<string, any>;
const rows = (sql: string, ...p: string[]) => db().prepare(sql).all(...p) as Row[];

export function accountRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ───────────── memories ─────────────
  const memoriesChanged = (userId: Id) => publish(userId, { type: 'invalidate', resource: 'memories' });

  app.get('/memories', async (req) => ({ memories: memories.list(req.user.id) }));

  app.post('/memories', async (req) => {
    const body = parse(memoryBody, req.body);
    const memory = memories.create(req.user.id, body.content, body.category || 'general');
    memoriesChanged(req.user.id);
    return { memory };
  });

  app.patch('/memories/:id', async (req) => {
    const body = parse(z.object({ content: memoryContent }), req.body);
    const memory = memories.update(req.user.id, idParam(req), body.content);
    if (!memory) throw notFound('Memory not found.');
    memoriesChanged(req.user.id);
    return { memory };
  });

  app.delete('/memories/:id', async (req) => {
    if (!memories.delete(req.user.id, idParam(req))) throw notFound('Memory not found.');
    memoriesChanged(req.user.id);
    return { ok: true };
  });

  app.delete('/memories', async (req) => {
    memories.deleteAll(req.user.id);
    audit(req.user.id, 'memories.cleared');
    memoriesChanged(req.user.id);
    return { ok: true };
  });

  // ───────────── vault: create / list metadata / delete. Nothing here can read a secret back. ─────────────
  app.get('/vault', async (req) => ({ items: vault.list(req.user.id) }));

  app.post('/vault', async (req) => {
    const body = parse(vaultBody, req.body);
    let created;
    try {
      created = vault.create(req.user.id, body);
    } catch (err) {
      throw new HttpError(400, (err as Error).message || 'That could not be saved.');
    }
    publish(req.user.id, { type: 'invalidate', resource: 'vault' });
    // Rebuilt field by field so nothing beyond the VaultItem metadata can ever ride along.
    const { id, kind, label: itemLabel, origin, hint, createdAt } = created;
    return { item: { id, kind, label: itemLabel, origin, hint, createdAt } };
  });

  app.delete('/vault/:id', async (req) => {
    if (!vault.remove(req.user.id, idParam(req))) throw notFound('Vault item not found.');
    publish(req.user.id, { type: 'invalidate', resource: 'vault' });
    return { ok: true };
  });

  // ───────────── approvals ─────────────
  app.get('/approvals', async (req) => {
    const { status } = parse(approvalStatus, req.query);
    return { approvals: approvalRows.list(req.user.id, status) };
  });

  app.post('/approvals/:id', async (req) => {
    const { decision } = parse(decisionBody, req.body);
    // Null for unknown, someone else's, or already decided: all indistinguishable 404s.
    const approval = resolveApproval(req.user.id, idParam(req), decision);
    if (!approval) throw notFound('Approval not found or already decided.');
    return { approval };
  });

  // ───────────── browser-agent runs ─────────────
  app.get('/handoff/:id', async (req) => {
    const run = handoffRuns.get(req.user.id, idParam(req));
    if (!run) throw notFound('Run not found.');
    return { run };
  });

  app.get('/handoff/:id/screenshot', async (req, reply) => {
    const run = handoffRuns.get(req.user.id, idParam(req));
    const shot = run ? ctx.handoff.screenshot(req.user.id, run.id) : null;
    if (!shot) throw notFound('No screenshot yet.');
    reply.header('cache-control', 'no-store').type('image/jpeg');
    return shot;
  });

  app.post('/handoff/:id/cancel', async (req) => {
    const run = handoffRuns.get(req.user.id, idParam(req));
    if (!run) throw notFound('Run not found.');
    ctx.handoff.cancel(req.user.id, run.id);
    return { ok: true };
  });

  // ───────────── settings, audit, export, deletion ─────────────
  app.get('/settings', async (req) => ({ settings: req.user.settings }));

  app.patch('/settings', async (req) => {
    const body = parse(settingsBody, req.body);
    if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
      throw new HttpError(400, `Unknown timezone "${body.timezone}". Use an IANA name such as Europe/London.`);
    }
    const settings: Partial<UserSettings> = {};
    const changed: string[] = [];
    if (body.name !== undefined) changed.push('name');
    if (body.memoryEnabled !== undefined) { settings.memoryEnabled = body.memoryEnabled; changed.push('memoryEnabled'); }
    if (body.timezone !== undefined) { settings.timezone = body.timezone; changed.push('timezone'); }
    if (body.autoApprove) {
      const picked: Partial<Record<ApprovalKind, boolean>> = {};
      for (const kind of APPROVAL_KINDS) {
        const value = body.autoApprove[kind];
        if (value !== undefined) { picked[kind] = value; changed.push(`autoApprove.${kind}`); }
      }
      // users.update merges this over the stored record, so a partial one is fine.
      settings.autoApprove = picked as Record<ApprovalKind, boolean>;
    }
    const user = users.update(req.user.id, { name: body.name, settings });
    audit(req.user.id, 'settings.changed', { changed });
    publish(req.user.id, { type: 'invalidate', resource: 'settings' });
    return { user };
  });

  app.get('/audit', async (req) => {
    const { limit } = parse(auditQuery, req.query);
    return { entries: listAudit(req.user.id, limit ?? 100) };
  });

  app.get('/export', async (req, reply) => {
    const userId = req.user.id;
    const json = (s: string) => JSON.parse(s) as unknown;
    const data = {
      exportedAt: new Date().toISOString(),
      user: req.user,
      memories: memories.list(userId),
      projects: projects.list(userId),
      threads: rows('SELECT id, kind, title, project_id, created_at FROM threads WHERE user_id=? ORDER BY created_at', userId).map((t) => ({
        id: t.id, kind: t.kind, title: t.title, projectId: t.project_id ?? null, createdAt: t.created_at,
        // Visible messages only, and only their UI parts: api_json (tool plumbing) stays on the server.
        messages: rows('SELECT id, role, source, created_at, parts_json FROM messages WHERE thread_id=? AND user_id=? AND parts_json IS NOT NULL ORDER BY seq', t.id, userId)
          .map((m) => ({ id: m.id, role: m.role, source: m.source ?? undefined, createdAt: m.created_at, parts: json(m.parts_json) })),
      })),
      actions: rows('SELECT id, verb, title, detail, prompt, priority, status, created_at FROM actions WHERE user_id=? ORDER BY created_at', userId)
        .map((a) => ({ id: a.id, verb: a.verb, title: a.title, detail: a.detail, prompt: a.prompt, priority: a.priority, status: a.status, createdAt: a.created_at })),
      panels: rows('SELECT id, title, description, html, created_at, updated_at FROM panels WHERE user_id=? ORDER BY created_at', userId)
        .map((p) => ({ id: p.id, title: p.title, description: p.description, html: p.html, createdAt: p.created_at, updatedAt: p.updated_at })),
      tasks: tasks.list(userId),
      specialties: specialties.list(userId),
      // Metadata only (label, site, masked hint). The encrypted payload column is never selected.
      vault: vault.list(userId),
      approvals: rows('SELECT id, thread_id, kind, summary, detail_json, status, created_at, resolved_at FROM approvals WHERE user_id=? ORDER BY created_at', userId)
        .map((a) => ({ id: a.id, threadId: a.thread_id ?? null, kind: a.kind, summary: a.summary, detail: json(a.detail_json), status: a.status, createdAt: a.created_at, resolvedAt: a.resolved_at ?? null })),
      handoffRuns: rows('SELECT id, thread_id, goal, status, url, steps_json, result, started_at, ended_at FROM handoff_runs WHERE user_id=? ORDER BY started_at', userId)
        .map((h) => ({ id: h.id, threadId: h.thread_id ?? null, goal: h.goal, status: h.status, url: h.url, steps: json(h.steps_json), result: h.result ?? null, startedAt: h.started_at, endedAt: h.ended_at ?? null })),
      audit: rows('SELECT id, event, detail_json, at FROM audit_log WHERE user_id=? ORDER BY seq', userId)
        .map((e) => ({ id: e.id, event: e.event, detail: json(e.detail_json), at: e.at })),
    };
    audit(userId, 'data.exported');
    reply
      .header('content-disposition', `attachment; filename="vector-export-${data.exportedAt.slice(0, 10)}.json"`)
      .header('cache-control', 'no-store')
      .type('application/json; charset=utf-8');
    return JSON.stringify(data, null, 2);
  });

  app.delete('/account', { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const userId = req.user.id;
    const { password } = parse(deleteBody, req.body);
    if (!(await verifyPassword(password, users.passwordHash(userId)))) {
      audit(userId, 'account.delete_failed');
      throw new HttpError(403, 'That password is not correct.');
    }
    // Stop everything that could still write rows for this user, then erase by cascade.
    ctx.agent.cancelAll(userId);
    ctx.handoff.cancelAll(userId);
    expireAllFor(userId);
    sessions.deleteAllFor(userId);
    users.delete(userId);
    ctx.streams.closeFor(userId);
    clearSessionCookie(reply);
    return { ok: true };
  });
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import { subscribe } from '../core/bus.ts';
import type { Id, ServerEvent } from '../../shared/types.ts';

const PING_MS = 25_000;

/** Tracks the open /api/events streams of one app so they can be ended on sign-out, deletion and shutdown. */
export interface StreamRegistry {
  open(userId: Id, req: FastifyRequest, reply: FastifyReply): void;
  closeFor(userId: Id): void;
  closeAll(): void;
}

export function createStreamRegistry(): StreamRegistry {
  const streams = new Map<Id, Set<() => void>>();

  return {
    open(userId, req, reply) {
      // From here on the raw socket is ours: Fastify must not try to send a reply of its own.
      reply.hijack();
      const raw = reply.raw;
      // Carry over what the hooks put on the reply (security headers), which hijack() would drop.
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) raw.setHeader(name, value);
      }
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });

      let closed = false;
      const send = (event: ServerEvent) => {
        if (!closed) raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = subscribe(userId, send);
      const timer = setInterval(() => {
        if (!closed) raw.write(': ping\n\n');
      }, PING_MS);
      timer.unref();

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe();
        const set = streams.get(userId);
        set?.delete(close);
        if (set?.size === 0) streams.delete(userId);
        if (!raw.writableEnded) raw.end();
      };
      let set = streams.get(userId);
      if (!set) streams.set(userId, (set = new Set()));
      set.add(close);

      req.raw.on('close', close);
      raw.on('close', close);
      raw.on('error', close);

      send({ type: 'hello' });
    },
    closeFor(userId) {
      for (const close of [...(streams.get(userId) ?? [])]) close();
    },
    closeAll() {
      for (const set of [...streams.values()]) for (const close of [...set]) close();
    },
  };
}

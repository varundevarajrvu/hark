import type { ServerEvent, Id } from '../../shared/types.ts';

type Listener = (event: ServerEvent) => void;
const listeners = new Map<Id, Set<Listener>>();

/** Push an event to every open /api/events stream of one user. Never crosses users. */
export function publish(userId: Id, event: ServerEvent): void {
  const set = listeners.get(userId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* a broken stream must not break the publisher */
    }
  }
}

export function subscribe(userId: Id, fn: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) listeners.set(userId, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(userId);
  };
}

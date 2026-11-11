import { useSyncExternalStore } from 'react';
import type { Id } from '../../shared/types.ts';
import { getState } from './store.ts';

export type Route =
  | { name: 'home' }
  | { name: 'chat' }
  | { name: 'project'; id: Id }
  | { name: 'thread'; id: Id }
  | { name: 'tasks' }
  | { name: 'memory' }
  | { name: 'vault' }
  | { name: 'specialties' }
  | { name: 'settings' }
  | { name: 'notfound' };

function parse(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+|\/+$/g, '');
  if (path === '') return { name: 'home' };
  const [head, rest] = path.split('/', 2);
  const id = rest ? decodeURIComponent(rest) : '';
  switch (head) {
    case 'chat':
      return { name: 'chat' };
    case 'project':
      return id ? { name: 'project', id } : { name: 'notfound' };
    case 'thread':
      return id ? { name: 'thread', id } : { name: 'notfound' };
    case 'tasks':
    case 'memory':
    case 'vault':
    case 'specialties':
    case 'settings':
      return rest ? { name: 'notfound' } : { name: head };
    default:
      return { name: 'notfound' };
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

let cachedHash: string | null = null;
let cachedRoute: Route = { name: 'home' };
function snapshot(): Route {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parse(hash);
  }
  return cachedRoute;
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot);
}

export function navigate(hash: string): void {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

/** The route that shows a given thread: the main chat, its project, or a stand-alone run thread. */
export function threadHref(threadId: Id | null): string {
  const s = getState();
  if (!threadId || threadId === s.mainThreadId) return '#/chat';
  const project = s.projects.find((p) => p.threadId === threadId);
  return project ? `#/project/${encodeURIComponent(project.id)}` : `#/thread/${encodeURIComponent(threadId)}`;
}

/**
 * Follow a link that sits inside an overlay (sheet, menu). The overlay owns a history entry; closing it
 * pops that entry asynchronously, so navigate only once it is gone — otherwise Back would need two presses.
 */
export function navigateFromOverlay(hash: string, close: () => void): void {
  close();
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', go);
    navigate(hash);
  };
  window.addEventListener('popstate', go);
  window.setTimeout(go, 300);
}

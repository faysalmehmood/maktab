/**
 * Who is signed in, as last answered by /api/me (lib/api.ts sets it). A dependency-free module so
 * the first-load bundle (which holds fetchMe) does not pull in the outbox and @maktab/shared; the
 * outbox wiring (sync.ts) subscribes when it loads.
 */
let current: string | null = null;
const listeners = new Set<(id: string | null) => void>();

export function setCurrentUser(id: string | null): void {
  if (id === current) return;
  current = id;
  for (const l of listeners) l(id);
}

export const currentUser = (): string | null => current;

/** Calls `fn` now with the current user and on every change; returns an unsubscribe. */
export function onCurrentUser(fn: (id: string | null) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

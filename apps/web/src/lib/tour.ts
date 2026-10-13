import { useSyncExternalStore } from 'react';

/*
 * Which "Show me" tour is running (finished tours: tour-done.ts). Tiny on purpose: the
 * shell (first load) reads it to decide whether to load the tour engine at all. A tour belongs to
 * the user who started it: the shell drops it when someone else is signed in, and sign-out stops it.
 */

export type ActiveTour = { task: string; key: number; user: string | undefined } | null;

let active: ActiveTour = null;
const subs = new Set<() => void>();
export const emit = () => {
  for (const s of subs) s();
};
export const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};

export function startTour(task: string, user: string | undefined): void {
  active = { task, key: Date.now(), user };
  emit();
}

export function stopTour(): void {
  if (!active) return;
  active = null;
  emit();
}

export const useActiveTour = (): ActiveTour =>
  useSyncExternalStore(
    subscribe,
    () => active,
    () => null,
  );

/** The running tour if it is this user's (another account's tour never shows). */
export const tourFor = (tour: ActiveTour, user: string | undefined): ActiveTour =>
  tour && tour.user === user ? tour : null;

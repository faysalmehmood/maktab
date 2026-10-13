import { useSyncExternalStore } from 'react';

/*
 * Which "Show me" tour is running (finished tours: tour-done.ts). Tiny on purpose: the
 * shell (first load) reads it to decide whether to load the tour engine at all.
 */

export type ActiveTour = { task: string; key: number } | null;

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

export function startTour(task: string): void {
  active = { task, key: Date.now() };
  emit();
}

export function stopTour(): void {
  active = null;
  emit();
}

export const useActiveTour = (): ActiveTour =>
  useSyncExternalStore(
    subscribe,
    () => active,
    () => null,
  );

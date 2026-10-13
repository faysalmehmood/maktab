import { useSyncExternalStore } from 'react';
import { emit, subscribe } from './tour';

/* Which "Show me" tours each user has finished (the guide pages and the tour engine; lazy). */

/** localStorage `maktab.tours`: { [userId]: taskId[] }. Best effort: storage may be unavailable. */
export const TOURS_KEY = 'maktab.tours';

function readAll(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(TOURS_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

let version = 0;
export function completedTours(userId: string | undefined): string[] {
  if (!userId) return [];
  const list = readAll()[userId];
  return Array.isArray(list) ? list : [];
}

export function markTourDone(userId: string | undefined, task: string): void {
  if (!userId) return;
  const all = readAll();
  const list = new Set(all[userId] ?? []);
  list.add(task);
  all[userId] = [...list];
  try {
    localStorage.setItem(TOURS_KEY, JSON.stringify(all));
  } catch {
    // Not fatal: the "seen" mark just will not survive a reload.
  }
  version++;
  emit();
}

/** The finished tours of a user; re-renders when one is marked done. */
export function useCompletedTours(userId: string | undefined): string[] {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  );
  return completedTours(userId);
}

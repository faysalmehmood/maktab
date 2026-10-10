/**
 * Wires the attendance outbox (outbox.ts, experiment 6) to the app: when to sync, what the header
 * shows, and what "Save" means on the register screen.
 *
 * Save always goes through the outbox (enqueue, then an immediate sync), so online and offline
 * saves take the same path and a dropped connection mid-request is just a retry. It is a plain async
 * call, deliberately outside react-query: a mutation with the default networkMode 'online' pauses
 * while the browser says it is offline, and then nothing would reach the outbox. The outbox is the
 * source of truth; the network attempt is its job. The server's per-register answer is captured
 * from the response (and broadcast to subscribers) so the screen can say "saved, 2 absence messages
 * queued" or why it was refused — also for a register that was saved offline and synced later.
 *
 * Triggers (PLAN §12 exp6; Background Sync is not relied on): `online`, the tab becoming visible,
 * and a timer that runs only while something is waiting.
 */
import type { AttendanceSubmission, AttendanceSyncResult } from '@maktab/shared';
import { useSyncExternalStore } from 'react';
import * as outbox from './outbox';

export type OutboxStatus = {
  pending: number;
  failed: number;
  paused: boolean;
  offline: boolean;
};

let status: OutboxStatus = { pending: 0, failed: 0, paused: false, offline: false };
const listeners = new Set<() => void>();

function set(next: Partial<OutboxStatus>): void {
  const merged = { ...status, ...next };
  if (
    merged.pending === status.pending &&
    merged.failed === status.failed &&
    merged.paused === status.paused &&
    merged.offline === status.offline
  )
    return;
  status = merged;
  for (const l of listeners) l();
}

export function useOutboxStatus(): OutboxStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

/** Answers seen in sync responses, by client_id; the register screen waits on its own. */
const answers = new Map<string, AttendanceSyncResult>();
const answerListeners = new Set<(r: AttendanceSyncResult) => void>();

/** Called with every per-register answer the server sends (background syncs included). */
export function onAnswer(fn: (r: AttendanceSyncResult) => void): () => void {
  answerListeners.add(fn);
  return () => answerListeners.delete(fn);
}

const capturingFetch = async (url: string, init: RequestInit): Promise<Response> => {
  const resp = await globalThis.fetch(url, { credentials: 'same-origin', ...init });
  if (resp.ok) {
    const body = (await resp
      .clone()
      .json()
      .catch(() => null)) as { results?: AttendanceSyncResult[] } | null;
    for (const r of body?.results ?? []) {
      if (!r.client_id) continue;
      answers.set(r.client_id, r);
      for (const l of answerListeners) l(r);
    }
  }
  return resp;
};

/** Private windows and old WebViews may have no IndexedDB: the app still works online-only. */
const hasIdb = () => typeof indexedDB !== 'undefined';

export async function refreshStatus(): Promise<OutboxStatus> {
  if (!hasIdb()) return status;
  const [pending, failed, paused] = await Promise.all([
    outbox.pending(),
    outbox.failed(),
    outbox.authPaused(),
  ]);
  set({ pending, failed: failed.length, paused: !!paused });
  return status;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** One sync pass, then the status refresh and (if anything is still waiting) the next timer. */
export async function syncNow({ force = false } = {}): Promise<OutboxStatus> {
  if (!hasIdb()) return status;
  const out = await outbox.sync(capturingFetch, { force });
  set({ offline: out.offline || (typeof navigator !== 'undefined' && navigator.onLine === false) });
  await refreshStatus();
  if (timer) clearTimeout(timer);
  timer = null;
  if (out.nextAt !== null && !out.paused) {
    // Never hammer: at least 5 s, at most a minute (the outbox's own backoff caps at 60 s).
    const wait = Math.min(60_000, Math.max(5_000, out.nextAt - Date.now()));
    timer = setTimeout(() => void syncNow(), wait);
  }
  return status;
}

export type SaveOutcome =
  /** The server answered for this register. */
  | { kind: 'answered'; result: AttendanceSyncResult }
  /** Kept on the phone; it will go when the connection is back. */
  | { kind: 'queued' }
  /** Kept on the phone; sync waits until the user signs in again. */
  | { kind: 'paused' };

export async function saveRegister(
  sub: AttendanceSubmission,
  meta: { label?: string | null } = {},
): Promise<SaveOutcome> {
  // No IndexedDB (private window, old WebView): online-only, straight to the server.
  if (!hasIdb()) {
    const resp = await capturingFetch('/api/attendance/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([sub]),
    });
    const result = answers.get(sub.client_id);
    answers.delete(sub.client_id);
    if (result) return { kind: 'answered', result };
    throw new Error(resp.status === 401 ? 'unauthenticated' : 'db_error');
  }
  await outbox.enqueue(sub, meta);
  // The browser says offline: keep it on the phone; the `online` trigger sends it.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    set({ offline: true });
    await refreshStatus();
    return { kind: 'queued' };
  }
  // force: a fresh save must not wait behind the backoff of an older failed attempt. A second
  // pass covers a save that landed while a background pass (which could not see it) was running.
  let s = status;
  for (let pass = 0; pass < 2 && !answers.has(sub.client_id); pass++) {
    s = await syncNow({ force: true });
    if (s.paused || s.offline) break;
  }
  const result = answers.get(sub.client_id);
  answers.delete(sub.client_id);
  if (result) return { kind: 'answered', result };
  return s.paused ? { kind: 'paused' } : { kind: 'queued' };
}

/** After a successful sign-in: lift an auth pause and send what waited. */
export async function resumeAfterSignIn(): Promise<void> {
  if (await outbox.authPaused()) {
    await outbox.resume();
    await syncNow({ force: true });
  } else await refreshStatus();
}

/** Registers the server refused (or a request it refused), for the failed list. */
export const failedEntries = (): Promise<outbox.OutboxEntry[]> =>
  hasIdb() ? outbox.failed() : Promise.resolve([]);

/** Puts refused registers back in the queue and tries now (e.g. after the office fixed the cause). */
export async function retryFailed(ids?: readonly string[]): Promise<void> {
  await outbox.retryFailed(ids);
  await syncNow({ force: true });
}

export async function discardFailed(ids?: readonly string[]): Promise<void> {
  await outbox.discardFailed(ids);
  await refreshStatus();
}

/** Is this register still waiting (or refused) on this phone? */
export const isOnPhone = (clientId: string): Promise<boolean> =>
  hasIdb() ? outbox.has(clientId) : Promise.resolve(false);

let started = false;

/** Installs the triggers once per page; returns a stop function (tests). */
export function startAutoSync(): () => void {
  if (started || typeof window === 'undefined') return () => undefined;
  started = true;
  const onOnline = () => {
    set({ offline: false });
    void syncNow({ force: true });
  };
  const onOffline = () => set({ offline: true });
  const onVisible = () => {
    if (document.visibilityState === 'visible') void syncNow();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  document.addEventListener('visibilitychange', onVisible);
  set({ offline: navigator.onLine === false });
  syncNow().catch((err: unknown) => console.warn('attendance sync', err));
  return () => {
    started = false;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** Test helper: forget in-memory state between tests. */
export function _reset(): void {
  status = { pending: 0, failed: 0, paused: false, offline: false };
  answers.clear();
  answerListeners.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}

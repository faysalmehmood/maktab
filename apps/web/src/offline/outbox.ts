/**
 * Offline outbox for attendance registers, ported from experiment 6 (PLAN §12; 10/10 scenarios and a
 * chaos run passed). Not wired to a screen in milestone 0.
 *
 * Protocol: entries keyed by the register's ULID `client_id` (re-enqueue is a no-op); per
 * (group, date, subject) ordering so a newer register never overtakes an older one that is backing
 * off; exponential backoff 1 s → 60 s (a longer Retry-After wins).
 * Response classes:
 *   2xx                       per-entry results (applied | replaced | duplicate | stale = done; rejected = failed)
 *   401; 403 whose error.code is disabled | not_invited | unauthenticated
 *                             PAUSE: nothing is sent until resume() (after the user signs in again);
 *                             entries stay pending and untouched — an expired session must never
 *                             turn a teacher's register into a "failed" one.
 *   other 403 (`forbidden`)   the route refuses this user; re-auth won't help: entries move to `failed`
 *   408 / 429 / 5xx / network retry with backoff
 *   any other 4xx             the request itself is bad: entries move to `failed`
 * Triggers are the caller's job (online, visibilitychange, a timer); Background Sync is not relied on.
 */
import type { AttendanceSubmission, AttendanceSyncResult } from '@maktab/shared';

export type OutboxState = 'pending' | 'failed';

export type OutboxEntry = {
  client_id: string;
  submission: AttendanceSubmission;
  state: OutboxState;
  attempts: number;
  next_at: number;
  error: string | null;
  seq: number;
  created_at: number;
};

export type SyncOutcome = {
  sent: number;
  acked: number;
  failed: number;
  retried: number;
  /** null when nothing is waiting (or the outbox is paused). */
  nextAt: number | null;
  offline: boolean;
  /** Set while sync is paused for re-authentication: the UI shows "sign in again". */
  paused: AuthPause | null;
};

export type AuthPause = { status: number; at: number };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const CAP_MS = 60_000;
const BASE_MS = 1_000;

const cfg = {
  chunk: 25,
  dbName: 'attendance-outbox',
  url: '/api/attendance/sync',
  now: (): number => Date.now(),
  jitter: (): number => 0,
};

let dbp: Promise<IDBDatabase> | null = null;
let inflight: Promise<SyncOutcome> | null = null;

export function configure(o: Partial<typeof cfg>): void {
  Object.assign(cfg, o);
}

/** Test helper: drop the connection so the next call reopens. */
export function _close(): void {
  if (dbp) void dbp.then((d) => d.close());
  dbp = null;
  inflight = null;
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onabort = () => rej(tx.error);
    tx.onerror = () => rej(tx.error);
  });

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const o = indexedDB.open(cfg.dbName, 1);
    o.onupgradeneeded = () => {
      const d = o.result;
      d.createObjectStore('outbox', { keyPath: 'client_id' }).createIndex('seq', 'seq');
      d.createObjectStore('meta');
    };
    o.onsuccess = () => {
      // Another tab upgrading the schema must not be blocked by this connection.
      o.result.onversionchange = () => {
        o.result.close();
        dbp = null;
      };
      res(o.result);
    };
    o.onerror = () => rej(o.error);
  });
  return dbp;
}

export const backoffMs = (attempts: number): number =>
  Math.min(CAP_MS, BASE_MS * 2 ** (attempts - 1)) + cfg.jitter();

/** Transient HTTP statuses: the request may succeed unchanged later. */
const isRetryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;
/** 403 codes that mean "who you are" is the problem (sign in again), not "what you asked for". */
const AUTH_403_CODES = new Set(['disabled', 'not_invited', 'unauthenticated']);
const isAuth = (status: number, body: SyncBody): boolean =>
  status === 401 || (status === 403 && AUTH_403_CODES.has(body?.error?.code ?? ''));

/** Retry-After in ms (seconds or HTTP date), or 0. */
function retryAfterMs(resp: Response): number {
  const h = resp.headers.get('retry-after');
  if (!h) return 0;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? 0 : Math.max(0, at - cfg.now());
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return (await req(d.transaction('meta').objectStore('meta').get(key))) as T | undefined;
}

async function setMeta(key: string, value: unknown): Promise<void> {
  const d = await db();
  const tx = d.transaction('meta', 'readwrite');
  if (value === undefined) tx.objectStore('meta').delete(key);
  else tx.objectStore('meta').put(value, key);
  await done(tx);
}

/** Non-null while sync waits for the user to sign in again (survives reloads). */
export async function authPaused(): Promise<AuthPause | null> {
  return (await getMeta<AuthPause>('auth_paused')) ?? null;
}

/** Call after a successful sign-in: lifts the pause; pending entries go out on the next sync. */
export async function resume(): Promise<void> {
  await setMeta('auth_paused', undefined);
}

const keyOf = (s: AttendanceSubmission): string =>
  `${s.grp_id}|${s.date}|${s.grp_subject_id ?? ''}`;

/** Idempotent on client_id (double-tap safe). */
export async function enqueue(submission: AttendanceSubmission): Promise<{ queued: boolean }> {
  if (!submission.client_id) throw new TypeError('client_id required');
  if (!Array.isArray(submission.marks)) throw new TypeError('marks required');
  const d = await db();
  const tx = d.transaction(['outbox', 'meta'], 'readwrite');
  const box = tx.objectStore('outbox');
  const meta = tx.objectStore('meta');
  const finished = done(tx);
  let queued = false;
  if (!(await req(box.get(submission.client_id)))) {
    const seq = (((await req(meta.get('seq'))) as number | undefined) ?? 0) + 1;
    meta.put(seq, 'seq');
    // Stored via structured clone: later UI mutations of `submission` cannot leak in.
    const entry: OutboxEntry = {
      client_id: submission.client_id,
      submission,
      state: 'pending',
      attempts: 0,
      next_at: 0,
      error: null,
      seq,
      created_at: cfg.now(),
    };
    box.put(entry);
    queued = true;
  }
  await finished;
  return { queued };
}

async function all(): Promise<OutboxEntry[]> {
  const d = await db();
  return req(d.transaction('outbox').objectStore('outbox').index('seq').getAll()) as Promise<
    OutboxEntry[]
  >;
}

export async function pending(): Promise<number> {
  return (await all()).filter((e) => e.state === 'pending').length;
}

export async function failed(): Promise<OutboxEntry[]> {
  return (await all()).filter((e) => e.state === 'failed');
}

export async function retryFailed(): Promise<void> {
  const d = await db();
  const tx = d.transaction('outbox', 'readwrite');
  const s = tx.objectStore('outbox');
  for (const e of (await req(s.getAll())) as OutboxEntry[]) {
    if (e.state === 'failed')
      s.put({ ...e, state: 'pending', attempts: 0, next_at: 0, error: null });
  }
  await done(tx);
}

/** Read-modify-write in one transaction; `fn` returns the new entry, or null to delete it. */
async function update(id: string, fn: (e: OutboxEntry) => OutboxEntry | null): Promise<void> {
  const d = await db();
  const tx = d.transaction('outbox', 'readwrite');
  const s = tx.objectStore('outbox');
  const cur = (await req(s.get(id))) as OutboxEntry | undefined;
  if (cur) {
    const next = fn(cur);
    if (next) s.put(next);
    else s.delete(id);
  }
  await done(tx);
}

const bump = (e: OutboxEntry, msg: string, minDelayMs = 0): OutboxEntry => ({
  ...e,
  attempts: e.attempts + 1,
  error: msg,
  next_at: cfg.now() + Math.max(backoffMs(e.attempts + 1), minDelayMs),
});

type SyncBody = {
  results?: AttendanceSyncResult[];
  error?: { code?: string; message?: string };
} | null;

async function runOnce(fetchImpl: FetchLike, force: boolean): Promise<SyncOutcome> {
  const out: SyncOutcome = {
    sent: 0,
    acked: 0,
    failed: 0,
    retried: 0,
    nextAt: null,
    offline: false,
    paused: await authPaused(),
  };
  if (out.paused) return out;
  // Head-of-line blocking per key: sending a newer register while an older one backs off would let
  // the server see them out of order.
  const blocked = new Set<string>();
  const due: OutboxEntry[] = [];
  for (const e of await all()) {
    if (e.state !== 'pending') continue;
    const k = keyOf(e.submission);
    if (blocked.has(k)) continue;
    if (force || e.next_at <= cfg.now()) due.push(e);
    else blocked.add(k);
  }

  for (let i = 0; i < due.length; i += cfg.chunk) {
    const chunk = due.slice(i, i + cfg.chunk);
    out.sent += chunk.length;
    let resp: Response;
    let body: SyncBody;
    try {
      resp = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chunk.map((e) => e.submission)),
      });
      body =
        resp.ok || !isRetryable(resp.status)
          ? ((await resp.json().catch(() => null)) as SyncBody)
          : null;
    } catch (err) {
      // Offline / dropped / aborted: keep everything, back off, and skip later chunks (they would fail too).
      out.offline = true;
      const msg = err instanceof Error ? err.message : String(err);
      for (const e of chunk) {
        await update(e.client_id, (c) => bump(c, `network: ${msg}`));
        out.retried++;
      }
      break;
    }
    if (isAuth(resp.status, body)) {
      // Session expired or revoked: keep everything exactly as it is and stop until resume().
      out.paused = { status: resp.status, at: cfg.now() };
      await setMeta('auth_paused', out.paused);
      return out;
    }
    if (isRetryable(resp.status)) {
      const wait = retryAfterMs(resp);
      for (const e of chunk) {
        await update(e.client_id, (c) => bump(c, `HTTP ${resp.status}`, wait));
        out.retried++;
      }
      break;
    }
    if (resp.status >= 400 || !body || !Array.isArray(body.results)) {
      const msg = `HTTP ${resp.status}: ${body?.error?.message ?? 'bad response'}`;
      for (const e of chunk) {
        await update(e.client_id, (c) => ({ ...c, state: 'failed', error: msg }));
        out.failed++;
      }
      continue;
    }
    const byId = new Map(body.results.map((r) => [r.client_id, r]));
    for (const e of chunk) {
      const r = byId.get(e.client_id);
      if (r?.status === 'rejected') {
        await update(e.client_id, (c) => ({ ...c, state: 'failed', error: r.error ?? 'rejected' }));
        out.failed++;
      } else if (r) {
        await update(e.client_id, () => null); // acknowledged => delete
        out.acked++;
      } else {
        await update(e.client_id, (c) => bump(c, 'missing from response'));
        out.retried++;
      }
    }
  }

  // Effective due time of an entry = max over earlier entries with the same key.
  const eff = new Map<string, number>();
  let min: number | null = null;
  for (const e of await all()) {
    if (e.state !== 'pending') continue;
    const k = keyOf(e.submission);
    const at = Math.max(e.next_at, eff.get(k) ?? 0);
    eff.set(k, at);
    min = min === null ? at : Math.min(min, at);
  }
  out.nextAt = min;
  return out;
}

/** One pass over due entries. Never throws on network/HTTP errors. Single-flight per tab and across tabs. */
export function sync(
  fetchImpl: FetchLike = (u, i) => globalThis.fetch(u, i),
  { force = false }: { force?: boolean } = {},
): Promise<SyncOutcome> {
  if (inflight) return inflight;
  const run = () => runOnce(fetchImpl, force);
  const locks = globalThis.navigator?.locks;
  const guarded = locks ? () => locks.request('attendance-outbox-sync', run) : run;
  inflight = guarded().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Loops until nothing is pending (or maxPasses). `sleep` is injectable for tests. */
export async function syncUntilDone(
  fetchImpl?: FetchLike,
  {
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    maxPasses = 100,
  }: { sleep?: (ms: number) => Promise<void>; maxPasses?: number } = {},
): Promise<SyncOutcome | undefined> {
  let r: SyncOutcome | undefined;
  for (let i = 0; i < maxPasses; i++) {
    r = await sync(fetchImpl);
    if (r.nextAt === null) return r;
    await sleep(Math.max(0, r.nextAt - cfg.now()));
  }
  return r;
}

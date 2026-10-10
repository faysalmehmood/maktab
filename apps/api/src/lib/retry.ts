/**
 * D1 returns internal error 7500 while a remote export holds the database (PLAN §12 exp5), and
 * SQLITE_BUSY under local contention. Both are transient, so one retry is worth it; more is not.
 * Only wrap idempotent work. The caller generates every id *before* calling withD1Retry and passes
 * it in (e.g. `const id = newId(); withD1Retry(() => createSession(db, id, …))`), so the retried
 * write is byte-for-byte the same statement and an ambiguous first attempt cannot double-apply.
 * Never call newId() inside the retried closure.
 */
const TRANSIENT = /\b7500\b|SQLITE_BUSY|database is locked/i;

export function isTransientD1Error(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const message = e instanceof Error ? e.message : String(e);
    if (TRANSIENT.test(message)) return true;
    e = e instanceof Error ? e.cause : undefined;
  }
  return false;
}

export async function withD1Retry<T>(
  fn: () => Promise<T>,
  { delayMs = 100, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientD1Error(err)) throw err;
    await sleep(delayMs);
    return fn();
  }
}

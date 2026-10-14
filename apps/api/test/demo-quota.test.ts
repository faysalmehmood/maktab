import { type AppDb, demoBackedOff, isQuotaError } from '@maktab/db';
import { createTestDb } from '@maktab/db/node';
import { describe, expect, it } from 'vitest';
import { demoTick } from '../src/routes/demo';
import { env, PARENT_SECRET, testApp } from './helpers';

/**
 * D1's daily limits (docs/demo.md "The D1 budget"): once the account's 5,000,000 rows read (or
 * 100,000 written) are used up, D1 refuses every query, reads included, until 00:00 UTC. The demo
 * must then stop, not retry every minute. In its own file: the backoff is per isolate (module state).
 */
const READ_LIMIT = "D1_ERROR: exceeded D1's free tier daily row read limit: SQLITE_ERROR";

/** A database that refuses everything as D1 does at the read limit, counting the attempts. */
function refusing(): { db: AppDb; calls: () => number } {
  const real = createTestDb();
  let calls = 0;
  const db = new Proxy(real, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (
        typeof v !== 'function' ||
        !['all', 'run', 'get', 'values', 'batch'].includes(String(prop))
      )
        return v;
      return () => {
        calls++;
        throw Object.assign(new Error('D1_ERROR', { cause: new Error(READ_LIMIT) }), {
          code: 7500,
        });
      };
    },
  });
  return { db, calls: () => calls };
}

describe('the demo at the D1 read limit', () => {
  it('recognises the read-limit error (message or code 7500) as a quota error', () => {
    expect(isQuotaError(new Error(READ_LIMIT))).toBe(true);
    expect(isQuotaError(new Error('Failed query', { cause: new Error(READ_LIMIT) }))).toBe(true);
    expect(isQuotaError(Object.assign(new Error('D1_ERROR'), { code: 7500 }))).toBe(true);
    expect(isQuotaError(new Error('D1_ERROR: something failed (code: 7500)'))).toBe(true);
    // Not every number 7500 is the limit, and other errors are not.
    expect(isQuotaError(new Error('amount 7500 is over the due'))).toBe(false);
    expect(isQuotaError(new Error('UNIQUE constraint failed: receipt.id'))).toBe(false);
  });

  it('a tick that hits it backs off until 00:00 UTC without touching D1 again; so does the step route', async () => {
    const { db, calls } = refusing();
    const now = Date.now();
    const midnight =
      Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000;
    const denv = { ...env, DEMO_MODE: '1', PARENT_LINK_SECRET: PARENT_SECRET };
    await expect(demoTick(db, denv, now)).rejects.toThrow();
    const tried = calls();
    expect(tried).toBeGreaterThan(0);
    // Every later tick before midnight: nothing at all, not even a read of the saved state.
    expect(await demoTick(db, denv, now + 60_000)).toBe(false);
    expect(await demoTick(db, denv, midnight - 1)).toBe(false);
    expect(calls()).toBe(tried);
    expect(demoBackedOff({ backoff_until: null }, midnight - 1)).toBe(true);
    expect(demoBackedOff({ backoff_until: null }, midnight)).toBe(false);
    // The public step route answers 503 without a query.
    const { request } = testApp({ db, demo: true, env: denv });
    const res = await request('/api/demo/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    expect(calls()).toBe(tried);
    // From 00:00 UTC it tries again.
    await expect(demoTick(db, denv, midnight + 60_000)).rejects.toThrow();
    expect(calls()).toBeGreaterThan(tried);
  });
});

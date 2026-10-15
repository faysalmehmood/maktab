import { type AppDb, startDemoReset } from '@maktab/db';
import { createTestDb } from '@maktab/db/node';
import { describe, expect, it, vi } from 'vitest';
import { env, PARENT_SECRET, testApp } from './helpers';

/**
 * A quota error inside a running reset is recorded once (one alarm, one state write): the runner
 * records it, and the step route does not again. Its own file: the backoff is per isolate.
 */
describe('the demo at the D1 read limit, mid-reset', () => {
  it('the step route logs one d1_quota alarm for one refusal', async () => {
    const real = createTestDb();
    await startDemoReset(real, { reason: 'test', daily: false, today: '2026-10-14' });
    let armed = false;
    let calls = 0;
    const db = new Proxy(real, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (
          typeof v !== 'function' ||
          !['all', 'run', 'get', 'values', 'batch'].includes(String(prop))
        )
          return v;
        return (...args: unknown[]) => {
          // The route's status read and the runner's lease (5 queries) succeed; the step fails.
          if (armed && ++calls > 7)
            throw new Error("D1_ERROR: exceeded D1's free tier daily row read limit");
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as AppDb;
    const alarms = vi.spyOn(console, 'error').mockImplementation(() => {});
    const denv = { ...env, DEMO_MODE: '1', PARENT_LINK_SECRET: PARENT_SECRET };
    const { request } = testApp({ db, demo: true, env: denv });
    armed = true;
    const res = await request('/api/demo/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    expect(calls).toBeGreaterThan(7);
    const quota = alarms.mock.calls.filter((c) => String(c[0]).includes('d1_quota'));
    alarms.mockRestore();
    expect(quota).toHaveLength(1);
  });
});

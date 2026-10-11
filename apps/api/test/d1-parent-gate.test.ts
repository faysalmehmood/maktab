import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '@maktab/db';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createApp } from '../src/app';
import { linkToken, randomSalt, sha256Hex } from '../src/lib/messaging';
import { env, ORIGIN, PARENT_SECRET } from './helpers';

/**
 * The parent-page gate lockout on workerd's real D1 (M5 fix pass): 20 wrong answers sent at once
 * must not all slip in under the limit. Each attempt is claimed by one atomic UPDATE before it is
 * checked, so at most 5 are counted (400) and the rest find the gate locked (429).
 */
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
let token = '';

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(import.meta.dirname, '../wrangler.toml'),
    persist: false,
  });
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()) {
    const stmts = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gm, '').trim() !== '');
    await proxy.env.DB.batch(stmts.map((s) => proxy.env.DB.prepare(s)));
  }
  const salt = randomSalt();
  token = await linkToken(PARENT_SECRET, salt);
  const hash = await sha256Hex(token);
  const db = proxy.env.DB;
  await db.batch([
    db.prepare(
      `INSERT INTO school (id, name, weekly_off, parent_gate) VALUES ('SCH', 'Test', '[]', 'birth_year')`,
    ),
    db.prepare(`INSERT INTO family (id, name) VALUES ('F1', 'Khan')`),
    db.prepare(
      `INSERT INTO guardian (id, family_id, name, phone) VALUES ('G1', 'F1', 'Imran Khan', '923001234567')`,
    ),
    db.prepare(
      `INSERT INTO student (id, family_id, admission_no, name, admission_date, dob)
       VALUES ('S1', 'F1', 'A1', 'Ali Khan', '2026-04-01', '2016-05-04')`,
    ),
    db
      .prepare(
        `INSERT INTO parent_link (id, guardian_id, token_hash, token_salt, expires_at, gate)
         VALUES ('L1', 'G1', ?, ?, '2099-01-01T00:00:00.000Z', 'birth_year')`,
      )
      .bind(hash, salt),
  ]);
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe('parent gate lockout on D1', () => {
  it('20 parallel wrong answers: at most 5 counted, the rest locked out', async () => {
    const { app } = createApp({ getDb: (e) => getDb({ DB: e.DB }) });
    const bindings = { ...env, DB: proxy.env.DB };
    const attempt = (year: number) =>
      app.request(
        '/api/p/gate',
        {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            'x-parent-token': token,
          },
          body: JSON.stringify({ birth_year: year }),
        },
        bindings,
      );
    const statuses = (
      await Promise.all(Array.from({ length: 20 }, (_, i) => attempt(1990 + (i % 10))))
    ).map((r) => r.status);
    const counted = statuses.filter((s) => s === 400).length;
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBe(20 - counted);
    const row = await proxy.env.DB.prepare(
      `SELECT gate_failures, gate_locked_until FROM parent_link WHERE id = 'L1'`,
    ).first<{ gate_failures: number; gate_locked_until: string | null }>();
    expect(row?.gate_failures).toBeLessThanOrEqual(5);
    expect(row?.gate_locked_until).toBeTruthy();
    // Locked: even the right answer waits.
    expect((await attempt(2016)).status).toBe(429);
    // Lock over (time passes): the right answer opens the gate and resets the count.
    await proxy.env.DB.prepare(
      `UPDATE parent_link SET gate_locked_until = '2000-01-01T00:00:00.000Z',
         gate_last_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = 'L1'`,
    ).run();
    expect((await attempt(2016)).status).toBe(200);
    const after = await proxy.env.DB.prepare(
      `SELECT gate_failures, gate_locked_until FROM parent_link WHERE id = 'L1'`,
    ).first<{ gate_failures: number; gate_locked_until: string | null }>();
    expect(after).toEqual({ gate_failures: 0, gate_locked_until: null });
  });
});

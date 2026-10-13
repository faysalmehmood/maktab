import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateAlarms, getDb, runDailyOps } from '@maktab/db';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import type { ExportJobDto, ExportPartDto } from '@maktab/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createApp } from '../src/app';
import { signSession } from '../src/auth/signed';
import { createSession } from '../src/auth/signin';
import { env, ORIGIN, SECRET } from './helpers';

/**
 * M6 on workerd's real D1: the export reads (sqlite_master with D1's `_cf_` tables, the
 * pragma_table_info() column list, keyset paging on rowid) and the alarm pass (the
 * ledger_consistency view and the window queries) behave as on better-sqlite3.
 */
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
let cookie = '';

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
  const d = proxy.env.DB;
  await d.batch([
    d.prepare(
      `INSERT INTO user (id, email, name, status) VALUES ('U1', 'o@x.pk', 'Owner', 'active')`,
    ),
    d.prepare(`INSERT INTO role (user_id, role) VALUES ('U1', 'owner')`),
    d.prepare(`INSERT INTO school (id, name, weekly_off) VALUES ('SCH', 'Test', '[]')`),
    d.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
       INSERT INTO family (id, name) SELECT printf('FAM%04d', i), 'F' || i FROM n`,
    ),
  ]);
  const s = await createSession(getDb({ DB: d }), 'SESS1', 'U1', {
    ua: null,
    ip: null,
    nowMs: Date.now(),
  });
  cookie = `maktab_sid=${await signSession(SECRET, s.id, s.exp)}`;
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe('M6 on D1', () => {
  it('export: job, columns and rowid paging', async () => {
    const { app } = createApp({ getDb: (e) => getDb({ DB: e.DB }) });
    const bindings = { ...env, DB: proxy.env.DB };
    const call = (path: string, method = 'GET') =>
      app.request(path, { method, headers: { cookie, origin: ORIGIN } }, bindings);
    const start = await call('/api/backup/export', 'POST');
    expect(start.status).toBe(201);
    const job = (await start.json()) as ExportJobDto;
    expect(job.tables).toContain('family');
    expect(job.tables.some((t) => t.startsWith('_cf_') || t === 'user_session')).toBe(false);
    let after = 0;
    let rows = 0;
    let parts = 0;
    for (;;) {
      const r = await call(`/api/backup/export/${job.id}/part?table=family&after=${after}`);
      expect(r.status).toBe(200);
      const part = (await r.json()) as ExportPartDto;
      expect(part.columns.slice(0, 2)).toEqual(['id', 'name']);
      rows += part.rows.length;
      parts++;
      if (part.next === null) break;
      after = part.next;
    }
    expect([rows, parts]).toEqual([250, 2]);
    // A composite-key table (rowid is implicit) pages too.
    const m = await call(`/api/backup/export/${job.id}/part?table=role`);
    expect(((await m.json()) as ExportPartDto).rows).toEqual([
      ['U1', 'owner', expect.any(String), null],
    ]);
  });

  it('alarms and the daily pass', async () => {
    const db = getDb({ DB: proxy.env.DB });
    const now = Date.parse('2026-10-12T23:00:00.000Z');
    expect((await evaluateAlarms(db, now)).total).toBe(0);
    expect(await runDailyOps(db, { now })).toMatchObject({ day: '2026-10-13', total: 0 });
    expect(await runDailyOps(db, { now })).toEqual({ day: '2026-10-13', skipped: 'done' });
  });
});

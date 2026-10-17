import { type SQL, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import { failedChunkStatements, karachiToday, runBatch } from '../src/ledger';
import { createTestDb } from '../src/node';
import {
  applyRetention,
  backupStale,
  evaluateAlarms,
  RETENTION_BATCH,
  RETENTION_MAX_BATCHES,
  runDailyOps,
} from '../src/ops/alarms';

// M6: the alarms panel / daily pass and data retention, on fixtures with one of each alarm.

const run = (db: AppDb, ...qs: string[]) =>
  atomic(
    db,
    () => qs.map((q) => rawStatement(db, sql.raw(q))) as [ReturnType<typeof rawStatement>],
  );
const all = <T = Record<string, unknown>>(db: AppDb, q: SQL) => db.all<T>(q);

// 2026-10-13 04:00 Asia/Karachi (23:00 UTC the day before).
const NOW = Date.parse('2026-10-12T23:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

let db: AppDb;

async function base(db: AppDb) {
  await run(
    db,
    `INSERT INTO user (id, email, name, status) VALUES ('U1', 'o@x.pk', 'Owner', 'active')`,
    `INSERT INTO school (id, name, weekly_off) VALUES ('SCH', 'Test', '[]')`,
    `INSERT INTO family (id, name) VALUES ('F1', 'Khan')`,
    `INSERT INTO guardian (id, family_id, name, phone) VALUES ('G1', 'F1', 'Imran', '923001234567')`,
    `INSERT INTO programme (id, name, kind) VALUES ('P1', 'Class 1', 'grade')`,
    `INSERT INTO grp (id, programme_id, name) VALUES ('GRP1', 'P1', 'A')`,
  );
}

const counts = async (db: AppDb, now = NOW) =>
  Object.fromEntries((await evaluateAlarms(db, now)).alarms.map((a) => [a.kind, a.count]));

beforeEach(async () => {
  db = createTestDb();
  await base(db);
});

describe('alarms', () => {
  it('a healthy database raises none', async () => {
    const r = await evaluateAlarms(db, NOW);
    expect(r.total).toBe(0);
    expect(r.alarms.map((a) => a.kind)).toEqual([
      'ledger_consistency',
      'messages_stuck',
      'messages_failed',
      'gate_lockouts',
      'billing_attention',
      'backup_stale',
      'backup_offsite',
    ]);
  });

  it('ledger_consistency: a mis-numbered cash receipt without a drawer session', async () => {
    // Only a bypassed trigger could write this row: drop the backstop on this throwaway db.
    await run(
      db,
      'DROP TRIGGER receipt_payment_shape',
      `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key)
         VALUES ('BAD1', 'HAND-7', 'payment', 'family', 'F1', 100, 'cash', 'U1', '2026-10-12', 'k1')`,
    );
    const r = await evaluateAlarms(db, NOW);
    const l = r.alarms.find((a) => a.kind === 'ledger_consistency');
    expect(l?.count).toBe(2);
    expect(l?.sample.map((s) => s.label).sort()).toEqual([
      'cash_receipt_no_session × 1',
      'receipt_no_format × 1',
    ]);
    expect(r.total).toBe(1);
  });

  it('messages queued for more than 3 days, and failed ones from the last 7 days', async () => {
    await run(
      db,
      `INSERT INTO message (id, family_id, channel, template_key, lang, status, created_at) VALUES
        ('M1', 'F1', 'wa_manual', 'absence', 'ur', 'queued', '${iso(NOW - 4 * DAY)}'),
        ('M2', 'F1', 'wa_manual', 'absence', 'ur', 'queued', '${iso(NOW - 2 * DAY)}'),
        ('M3', 'F1', 'wa_api', 'fee_due', 'ur', 'failed', '${iso(NOW - 1 * DAY)}'),
        ('M4', 'F1', 'wa_api', 'fee_due', 'ur', 'failed', '${iso(NOW - 9 * DAY)}')`,
    );
    const c = await counts(db);
    expect(c.messages_stuck).toBe(1);
    expect(c.messages_failed).toBe(1);
  });

  it('gate lockouts in the last 24 hours', async () => {
    await run(
      db,
      `INSERT INTO guardian (id, family_id, name, phone) VALUES ('G2', 'F1', 'Sana', '923001234568')`,
      `INSERT INTO parent_link (id, guardian_id, token_hash, gate_failures, gate_locked_until) VALUES
        ('L1', 'G1', 'h1', 5, '${iso(NOW - 2 * 3_600_000)}'),
        ('L2', 'G2', 'h2', 5, '${iso(NOW - 30 * 3_600_000)}')`,
    );
    const c = await counts(db);
    expect(c.gate_lockouts).toBe(1);
  });

  it('billing attention after three failed generation chunks in a row', async () => {
    const period = karachiToday(NOW).slice(0, 7);
    // Chunks are minutes apart in life; a few ms here keeps "latest" well defined.
    const fail = async () => {
      await new Promise((r) => setTimeout(r, 3));
      await runBatch(
        db,
        failedChunkStatements({
          period,
          grpId: 'GRP1',
          afterStudentId: null,
          code: 'constraint',
          message: 'boom',
          by: null,
          now: iso(NOW),
        }),
      );
    };
    await fail();
    await fail();
    expect((await counts(db)).billing_attention).toBe(0);
    await fail();
    const r = await evaluateAlarms(db, NOW);
    expect(r.alarms.find((a) => a.kind === 'billing_attention')).toMatchObject({
      count: 1,
      sample: [{ id: 'GRP1', label: 'constraint × 3' }],
    });
  });
});

describe('daily pass', () => {
  it('waits for 03:00 Karachi, then runs once per day (idempotent)', async () => {
    const early = Date.parse('2026-10-12T21:30:00.000Z'); // 02:30 PKT on the 13th
    expect(await runDailyOps(db, { now: early })).toEqual({
      day: '2026-10-13',
      skipped: 'before_03',
    });
    await run(
      db,
      `INSERT INTO message (id, family_id, channel, template_key, lang, status, created_at)
       VALUES ('M1', 'F1', 'wa_manual', 'absence', 'ur', 'queued', '${iso(NOW - 4 * DAY)}')`,
    );
    const first = await runDailyOps(db, { now: NOW });
    expect(first).toMatchObject({ day: '2026-10-13', total: 1 });
    const second = await runDailyOps(db, { now: NOW + 30 * 60_000 });
    expect(second).toEqual({ day: '2026-10-13', skipped: 'done' });
    const rows = await all<{ day: string; total: number; alarms: string }>(
      db,
      sql`SELECT day, total, alarms FROM alarm_event`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.total).toBe(1);
    expect(JSON.parse(rows[0]?.alarms ?? '[]')).toHaveLength(7);
    // The next Karachi day gets its own row; a quiet day is recorded with total 0.
    await run(
      db,
      `UPDATE message SET status = 'skipped', skipped_reason = 'x', skipped_at = '${iso(NOW)}' WHERE id = 'M1'`,
    );
    expect(await runDailyOps(db, { now: NOW + DAY })).toMatchObject({
      day: '2026-10-14',
      total: 0,
    });
  });
});

describe('retention', () => {
  it('deletes access log rows older than the school setting and old export jobs', async () => {
    await run(
      db,
      `UPDATE school SET access_log_days = 30`,
      `INSERT INTO parent_link (id, guardian_id, token_hash) VALUES ('L1', 'G1', 'h1')`,
      `INSERT INTO parent_link_access (id, link_id, at) VALUES
        ('A1', 'L1', '${iso(NOW - 31 * DAY)}'), ('A2', 'L1', '${iso(NOW - 29 * DAY)}')`,
      `INSERT INTO export_job (id, created_by, created_at, tables) VALUES
        ('J1', 'U1', '${iso(NOW - 40 * DAY)}', '[]'), ('J2', 'U1', '${iso(NOW - DAY)}', '[]')`,
    );
    expect(await applyRetention(db, NOW)).toEqual({ access_log: 1, export_jobs: 1 });
    expect(await all(db, sql`SELECT id FROM parent_link_access`)).toEqual([{ id: 'A2' }]);
    expect(await all(db, sql`SELECT id FROM export_job`)).toEqual([{ id: 'J2' }]);
    // Nothing left to do: a second pass deletes nothing.
    expect(await applyRetention(db, NOW)).toEqual({ access_log: 0, export_jobs: 0 });
  });

  it('works in batches up to the cap, and stops when the time budget is spent', async () => {
    const old = RETENTION_BATCH * RETENTION_MAX_BATCHES + 50;
    await run(
      db,
      `INSERT INTO parent_link (id, guardian_id, token_hash) VALUES ('L1', 'G1', 'h1')`,
    );
    await run(
      db,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${old})
       INSERT INTO parent_link_access (id, link_id, at) SELECT 'A' || i, 'L1', '${iso(NOW - 400 * DAY)}' FROM n`,
    );
    // The cap: 8 batches of 200 in one pass, the rest the next day.
    expect(await applyRetention(db, NOW)).toEqual({
      access_log: RETENTION_BATCH * RETENTION_MAX_BATCHES,
      export_jobs: 0,
    });
    // A spent budget: no statement at all.
    let t = 0;
    expect(await applyRetention(db, NOW, { clock: () => (t += 1000), budgetMs: 500 })).toEqual({
      access_log: 0,
      export_jobs: 0,
    });
    // One batch fits the budget, then time is up.
    t = 0;
    await run(
      db,
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO parent_link_access (id, link_id, at) SELECT 'B' || i, 'L1', '${iso(NOW - 400 * DAY)}' FROM n`,
    );
    expect(
      (await applyRetention(db, NOW, { clock: () => (t += 600), budgetMs: 1000 })).access_log,
    ).toBe(RETENTION_BATCH);
    expect(await applyRetention(db, NOW)).toEqual({
      access_log: 50 + 300 - RETENTION_BATCH,
      export_jobs: 0,
    });
  });
});

describe('backup_stale alarm', () => {
  const HOUR = 3_600_000;
  const nightly = (id: string, status: string, at: number, enabled: boolean | null = true) =>
    `INSERT INTO backup_run (id, kind, status, finished_at, details) VALUES ('${id}', 'nightly', '${status}',
      '${iso(at)}', ${enabled === null ? 'NULL' : `'${JSON.stringify({ backup_enabled: enabled })}'`})`;

  it('is silent before backups are set up (no run at all)', async () => {
    expect(await backupStale(db, NOW)).toMatchObject({ count: 0, since: null });
  });

  it('is silent while no run ever succeeded (a failing first setup)', async () => {
    await run(db, nightly('R1', 'failed', NOW - 100 * HOUR));
    expect((await backupStale(db, NOW)).count).toBe(0);
  });

  it('is silent when the latest report does not say backup_enabled', async () => {
    await run(db, nightly('R1', 'ok', NOW - 100 * HOUR, null));
    expect((await backupStale(db, NOW)).count).toBe(0);
    await run(db, nightly('R2', 'ok', NOW - 90 * HOUR, false));
    expect((await backupStale(db, NOW)).count).toBe(0);
  });

  it('is quiet with a good run inside 36 hours (ok or partial)', async () => {
    await run(db, nightly('R1', 'partial', NOW - 20 * HOUR));
    expect(await backupStale(db, NOW)).toMatchObject({
      count: 0,
      since: iso(NOW - 20 * HOUR),
    });
  });

  it('fires when the last good run is older than 36 hours', async () => {
    await run(db, nightly('R1', 'ok', NOW - 37 * HOUR));
    const a = await backupStale(db, NOW);
    expect(a).toMatchObject({ kind: 'backup_stale', count: 1, since: iso(NOW - 37 * HOUR) });
    expect(a.sample[0]).toMatchObject({ id: 'R1' });
    expect(a.sample[0]?.label).toMatch(/^last ok /);
  });

  it('fires when the latest nightly failed, even right after a good one', async () => {
    await run(db, nightly('R1', 'ok', NOW - 25 * HOUR), nightly('R2', 'failed', NOW - HOUR));
    const a = await backupStale(db, NOW);
    expect(a).toMatchObject({ count: 1, since: iso(NOW - 25 * HOUR) });
    expect(a.sample[0]).toMatchObject({ id: 'R2' });
    expect(a.sample[0]?.label).toMatch(/^failed /);
  });

  it('drills never count as nightly runs; it shows in the panel and the daily pass', async () => {
    await run(
      db,
      nightly('R1', 'ok', NOW - 50 * HOUR),
      `INSERT INTO backup_run (id, kind, status, finished_at) VALUES ('D1', 'drill', 'ok', '${iso(NOW - HOUR)}')`,
    );
    expect((await counts(db)).backup_stale).toBe(1);
    expect(await runDailyOps(db, { now: NOW })).toMatchObject({ total: 1 });
  });
});

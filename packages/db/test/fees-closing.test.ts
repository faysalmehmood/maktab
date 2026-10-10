import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import { applyLateFines, failingGroups, generateCharges, runScheduled } from '../src/ledger';
import { createTestDb } from '../src/node';

/**
 * M3a closing pass: the second review's repros (review-m3a2/cron.ts, scen.ts) as permanent tests.
 * This file: the cron starvation repro (H1).
 */

type Row = Record<string, unknown>;
const exec = (db: AppDb, ...qs: string[]) =>
  atomic(
    db,
    () => qs.map((q) => rawStatement(db, sql.raw(q))) as [ReturnType<typeof rawStatement>],
  );

/** A database whose reads throw for any group id starting `GBAD` (the reviewer's proxy). */
function poisoned(base: AppDb): AppDb {
  const d = new SQLiteSyncDialect();
  return new Proxy(base as object, {
    get(t, p) {
      const v = (t as Record<string | symbol, unknown>)[p];
      if (p === 'all')
        return (q: Parameters<SQLiteSyncDialect['sqlToQuery']>[0]) => {
          const { params } = d.sqlToQuery(q);
          if (params.some((x) => typeof x === 'string' && /^GBAD/.test(x))) throw new Error('boom');
          return (v as (q: unknown) => unknown).call(t, q);
        };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as AppDb;
}

async function seedCron(base: AppDb) {
  await exec(
    base,
    `INSERT INTO "user" (id, email, name, status) VALUES ('U1','a@x','Admin','active')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at) VALUES ('SCH','T','R','2026-04-01')`,
    `INSERT INTO session (id, name, start_date, end_date, is_current) VALUES ('SES','2026-27','2026-04-01','2027-03-31',1)`,
    `INSERT INTO programme (id, name, kind) VALUES ('P5','Class 5','grade')`,
    `INSERT INTO grp (id, programme_id, session_id, name) VALUES ('GBAD1','P5','SES','a'),('GBAD2','P5','SES','b'),('GBAD3','P5','SES','c'),('GOK','P5','SES','d')`,
    `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI','Tuition','tuition','monthly')`,
    `INSERT INTO fee_rate (id, fee_head_id, programme_id, amount, effective_from) VALUES ('r1','TUI','P5',100000,'2026-04-01')`,
    `INSERT INTO family (id, name) VALUES ('F1','K')`,
    `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S1','F1','1','a','2026-04-01'),('S2','F1','2','b','2026-04-01'),('S3','F1','3','c','2026-04-01'),('S4','F1','4','d','2026-04-01')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('E1','S1','GBAD1',1,'2026-04-01'),('E2','S2','GBAD2',1,'2026-04-01'),('E3','S3','GBAD3',1,'2026-04-01'),('E4','S4','GOK',1,'2026-04-01')`,
  );
}

const T0 = Date.parse('2026-10-02T03:00:00Z');
const TICK = 30 * 60_000;

describe('H1 cron starvation (review-m3a2/cron.ts)', () => {
  it('three bad groups first: the healthy group is billed by the second tick, failures back off, an alert is raised', async () => {
    const base = createTestDb();
    await seedCron(base);
    const db = poisoned(base);
    const ticks: { failed: string[]; generated: string[] }[] = [];
    for (let tick = 0; tick < 8; tick++) {
      const r = await runScheduled(db, { now: T0 + tick * TICK });
      ticks.push({
        failed: r.failed.map((f) => f.grp_id),
        generated: r.generated.map((g) => g.grp_id as string),
      });
    }
    // Tick 0 knows nothing yet: the three bad groups (lowest ids) fail; failures do not use the
    // success budget but are bounded per tick. Tick 1: they are in backoff, so GOK is billed.
    expect(ticks[0]).toEqual({ failed: ['GBAD1', 'GBAD2', 'GBAD3'], generated: [] });
    expect(ticks[1]).toEqual({ failed: [], generated: ['GOK'] });
    // Backoff 2^n ticks: retried at tick 2 (n=1 → 2 ticks), then tick 6 (n=2 → 4 ticks).
    expect(ticks.map((t) => t.failed.length)).toEqual([3, 0, 3, 0, 0, 0, 3, 0]);
    expect(
      await base.all<Row>(sql`SELECT count(*) AS n FROM charge WHERE student_id = 'S4'`),
    ).toEqual([{ n: 1 }]);
    // Without backoff this was 3 rows per tick (24); now bounded by the schedule.
    const rows = await base.all<Row>(sql`SELECT grp_id, fail_streak, retry_after FROM billing_chunk
      WHERE status = 'failed' AND grp_id = 'GBAD1' ORDER BY created_at, id`);
    expect(rows).toEqual([
      { grp_id: 'GBAD1', fail_streak: 1, retry_after: new Date(T0 + 2 * TICK).toISOString() },
      {
        grp_id: 'GBAD1',
        fail_streak: 2,
        retry_after: new Date(T0 + 2 * TICK + 4 * TICK).toISOString(),
      },
      {
        grp_id: 'GBAD1',
        fail_streak: 3,
        retry_after: new Date(T0 + 6 * TICK + 8 * TICK).toISOString(),
      },
    ]);
    expect(
      await base.all<Row>(sql`SELECT count(*) AS n FROM billing_chunk WHERE status = 'failed'`),
    ).toEqual([{ n: 9 }]);
    // Third failure in a row: attention_required for every bad group.
    const alerts = await failingGroups(base, '2026-10');
    expect(alerts.map((a) => [a.grp_id, a.fail_streak, a.attention_required])).toEqual([
      ['GBAD1', 3, true],
      ['GBAD2', 3, true],
      ['GBAD3', 3, true],
    ]);
  });

  it('backoff is capped at 24 h, and a success resets the streak', async () => {
    const base = createTestDb();
    await seedCron(base);
    const db = poisoned(base);
    let now = T0;
    // Drive GBAD1 to a long streak by always running at its retry time.
    for (let i = 0; i < 7; i++) {
      await runScheduled(db, { now });
      const [r] = await base.all<{ retry_after: string }>(sql`SELECT retry_after FROM billing_chunk
        WHERE grp_id = 'GBAD1' ORDER BY created_at DESC, id DESC LIMIT 1`);
      now = Date.parse(r?.retry_after as string);
    }
    const [last] = await base.all<{ fail_streak: number; retry_after: string; at: string }>(sql`
      SELECT fail_streak, retry_after FROM billing_chunk WHERE grp_id = 'GBAD1'
      ORDER BY created_at DESC, id DESC LIMIT 1`);
    expect(last?.fail_streak).toBe(7);
    // 2^7 ticks = 64 h → capped at 24 h after the attempt.
    const prevAttempt = now - 24 * 3_600_000;
    expect(Date.parse(last?.retry_after as string) - prevAttempt).toBe(24 * 3_600_000);
    // The group is fixed: the next attempt succeeds and the alert clears.
    await runScheduled(base, { now });
    expect((await failingGroups(base, '2026-10')).map((a) => a.grp_id)).not.toContain('GBAD1');
    expect(
      await base.all<Row>(sql`SELECT count(*) AS n FROM charge WHERE student_id = 'S1'`),
    ).toEqual([{ n: 1 }]);
  });
});

/** The reviewer's world (scen.ts), trimmed: two classes, fines after the 10th (Rs 200 fixed). */
async function seedWorld(db: AppDb) {
  await exec(
    db,
    `INSERT INTO "user" (id, email, name, status) VALUES ('U1','a@x','Admin','active'),('U2','b@x','Acct','active')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at, fine_rule) VALUES ('SCH','T','R','2026-04-01','{"enabled":true,"grace_day":10,"type":"fixed","value":20000,"cap":null}')`,
    `INSERT INTO session (id, name, start_date, end_date, is_current) VALUES ('SES','2026-27','2026-04-01','2027-03-31',1)`,
    `INSERT INTO programme (id, name, kind) VALUES ('P5','Class 5','grade')`,
    `INSERT INTO grp (id, programme_id, session_id, name) VALUES ('G5A','P5','SES','A')`,
    `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI','Tuition','tuition','monthly')`,
    `INSERT INTO fee_rate (id, fee_head_id, programme_id, amount, effective_from) VALUES ('r1','TUI','P5',300000,'2026-04-01')`,
    `INSERT INTO family (id, name) VALUES ('F1','Khan')`,
    `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S1','F1','0001','Ali','2026-04-01')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('E1','S1','G5A',1,'2026-04-01')`,
  );
}

describe('fines across periods (verifier item)', () => {
  it('a month-old overdue charge is fined by the cron tick, once, filed under its own period', async () => {
    const db = createTestDb();
    await seedWorld(db);
    await generateCharges(db, { period: '2026-09', scope: { grpId: 'G5A' }, by: 'U1' });
    // October 5th: October is not yet due, September is (due 2026-09-10) and was never fined.
    const r = await runScheduled(db, { now: Date.parse('2026-10-05T03:00:00Z') });
    expect(r.fines[0]?.applied).toBe(1);
    const fines = () =>
      db.all<Row>(sql`SELECT f.period_key, f.amount, p.period_key AS root_period, r.period_key AS run_period
        FROM charge f JOIN charge p ON p.id = f.parent_charge_id JOIN billing_run r ON r.id = f.run_id
        WHERE f.kind = 'fine' ORDER BY f.period_key`);
    expect(await fines()).toEqual([
      { period_key: '2026-09', amount: 20000, root_period: '2026-09', run_period: '2026-09' },
    ]);
    // Idempotent: the next tick, and an explicit single-period run, add nothing for September.
    await runScheduled(db, { now: Date.parse('2026-10-05T03:30:00Z') });
    expect(
      (await applyLateFines(db, { period: '2026-09', asOf: '2026-10-05', by: null })).applied,
    ).toBe(0);
    // After October's due day the cron fines October too.
    await runScheduled(db, { now: Date.parse('2026-10-11T03:00:00Z') });
    expect((await fines()).map((f) => f.period_key)).toEqual(['2026-09', '2026-10']);
    expect(await db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });
});

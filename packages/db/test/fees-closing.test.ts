import { newId } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import {
  applyLateFines,
  collect,
  collectionByCollector,
  errorText,
  failingGroups,
  generateCharges,
  generationCursor,
  refund,
  runScheduled,
  sponsorShares,
  voidCharge,
} from '../src/ledger';
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

// ---- review-m3a2/scen.ts --------------------------------------------------------------------------

const RS = (n: number) => n * 100;

/** scen.ts's world: two classes, a sponsored child (S4, 50%), a late joiner (S5), a transfer (S6). */
async function seedScen(db: AppDb) {
  await exec(
    db,
    `INSERT INTO "user" (id, email, name, status) VALUES ('U1','a@x','Admin','active'),('U2','b@x','Acct','active')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at) VALUES ('SCH','T','R','2026-04-01')`,
    `INSERT INTO session (id, name, start_date, end_date, is_current) VALUES ('SES','2026-27','2026-04-01','2027-03-31',1)`,
    `INSERT INTO programme (id, name, kind) VALUES ('P5','Class 5','grade')`,
    `INSERT INTO grp (id, programme_id, session_id, name) VALUES ('G5A','P5','SES','A'),('G5B','P5','SES','B')`,
    `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI','Tuition','tuition','monthly')`,
    `INSERT INTO fee_rate (id, fee_head_id, programme_id, grp_id, amount, effective_from) VALUES
      ('r1','TUI','P5',NULL,${RS(3000)},'2026-04-01'),('r2','TUI',NULL,'G5B',${RS(3500)},'2026-04-01')`,
    `INSERT INTO family (id, name) VALUES ('F1','Khan'),('F2','Ahmed'),('F3','Bibi'),('F4','New')`,
    `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES
      ('S1','F1','0001','Ali','2026-04-01'),('S3','F2','0003','Omar','2026-04-01'),('S4','F3','0004','Zara','2026-04-01'),
      ('S5','F4','0005','Late','2026-10-20'),('S6','F4','0006','Mover','2026-04-01')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES
      ('E1','S1','G5A',1,'2026-04-01'),('E3','S3','G5B',1,'2026-04-01'),('E4','S4','G5A',1,'2026-04-01'),('E5','S5','G5A',1,'2026-10-20')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, end_date, status) VALUES ('E6a','S6','G5A',0,'2026-04-01','2026-10-15','transferred')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, prev_enrolment_id) VALUES ('E6b','S6','G5B',1,'2026-10-16','E6a')`,
    `INSERT INTO sponsor (id, name) VALUES ('SP','Trust')`,
    `INSERT INTO sponsorship (id, sponsor_id, student_id, fee_head_id, share_pct, valid_from) VALUES ('SH','SP','S4',NULL,50,'2026-04-01')`,
    `INSERT INTO account (id, name, kind) VALUES ('CASH','Drawers','cash'),('BANK','Bank','bank')`,
  );
}

describe('scen.ts repros (M3a closing pass)', () => {
  let db: AppDb;
  const all = (q: Parameters<AppDb['all']>[0]) => db.all<Row>(q);
  const consistency = () => all(sql`SELECT * FROM ledger_consistency`);
  const genAll = async (period: string) => {
    for (let c = await generationCursor(db, period); c; c = await generationCursor(db, period))
      await generateCharges(db, {
        period,
        scope: { grpId: c.grp_id, afterStudentId: c.after_student_id },
        by: 'U1',
      });
  };
  const pay = (payer: string, amount: number, day: string, extra: Record<string, unknown> = {}) =>
    collect(db, {
      payerType: 'family',
      payerId: payer,
      amount,
      method: 'cash',
      businessDate: day,
      today: day,
      collectorId: 'U2',
      idempotencyKey: newId(),
      ...extra,
    } as Parameters<typeof collect>[1]);
  /** 'BLOCKED (message)' or 'ALLOWED', like the reviewer's adv(). */
  const adv = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return 'ALLOWED';
    } catch (e) {
      return `BLOCKED (${errorText(e).replace(/\s+/g, ' ')})`;
    }
  };
  const roots = (student: string, period: string) =>
    all(sql`SELECT c.id, c.payer_type AS pt, c.amount AS a, n.net, n.paid, c.due_date AS d
      FROM charge c JOIN charge_net n ON n.id = c.id
      WHERE c.student_id = ${student} AND c.period_key = ${period} AND c.kind = 'fee'
      ORDER BY c.payer_type`);

  beforeEach(async () => {
    db = createTestDb();
    await seedScen(db);
    await genAll('2026-10');
  });

  it('item 5: X3–X6 — every refund/reversal/payment is numbered from its series; refunds are today only, need an account when non-cash', async () => {
    await pay('F2', RS(9000), '2026-10-05'); // F2 owes 3500: 5500 credit
    const x3 = await adv(() =>
      exec(
        db,
        `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, account_id, collector_id, business_date, idempotency_key) VALUES ('x3','ANYTHING','payment','family','F3',100,'bank','BANK','U2','2026-10-10','kx12')`,
      ),
    );
    expect(x3).toMatch(/BLOCKED .*next number of its series/);
    const x4 = await adv(() =>
      exec(
        db,
        `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key) VALUES ('x4','ZZ','refund','family','F2',-100,'cash','U1','2026-10-10','kx13')`,
      ),
    );
    expect(x4).toMatch(/BLOCKED .*cash receipt needs a cash session/);
    // Even with a correctly bumped number, a cash refund needs a drawer.
    const x4b = await adv(() =>
      exec(
        db,
        `UPDATE receipt_series SET next_no = next_no + 1 WHERE series = 'R' AND year = 2026`,
        `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key) VALUES ('x4b',(SELECT 'R-2026-' || printf('%05d', next_no - 1) FROM receipt_series WHERE series='R'),'refund','family','F2',-100,'cash','U1','2026-10-10','kx13b')`,
      ),
    );
    expect(x4b).toMatch(/BLOCKED .*cash receipt needs a cash session/);
    const x5 = await adv(() =>
      refund(db, {
        payerType: 'family',
        payerId: 'F2',
        amount: 100,
        method: 'bank',
        reason: 'x',
        by: 'U1',
        businessDate: '2026-10-10',
        today: '2026-10-10',
        idempotencyKey: 'ref9',
      }),
    );
    expect(x5).toMatch(/BLOCKED .*account_required|BLOCKED .*needs the account/);
    const x6 = await adv(() =>
      refund(db, {
        payerType: 'family',
        payerId: 'F2',
        amount: 100,
        method: 'cash',
        reason: 'x',
        by: 'U1',
        businessDate: '2025-01-01',
        today: '2026-10-10',
        idempotencyKey: 'ref10',
      }),
    );
    expect(x6).toMatch(/BLOCKED .*must be today/);
    expect(await all(sql`SELECT * FROM cash_session WHERE business_date = '2025-01-01'`)).toEqual(
      [],
    );
    // Yesterday is refused too: money out is entered the day it goes out.
    const y = await adv(() =>
      refund(db, {
        payerType: 'family',
        payerId: 'F2',
        amount: 100,
        method: 'bank',
        accountId: 'BANK',
        reason: 'x',
        by: 'U1',
        businessDate: '2026-10-09',
        today: '2026-10-10',
        idempotencyKey: 'ref11',
      }),
    );
    expect(y).toMatch(/BLOCKED .*bad_business_date|BLOCKED .*must be today/);
    // The legitimate shapes still pass.
    await refund(db, {
      payerType: 'family',
      payerId: 'F2',
      amount: 100,
      method: 'bank',
      accountId: 'BANK',
      reason: 'x',
      by: 'U1',
      businessDate: '2026-10-10',
      today: '2026-10-10',
      idempotencyKey: 'ref12',
    });
    expect(
      await all(sql`SELECT receipt_no, account_id FROM receipt WHERE idempotency_key = 'ref12'`),
    ).toEqual([{ receipt_no: 'R-2026-00002', account_id: 'BANK' }]);
    expect(await consistency()).toEqual([]);
  });

  it('item 2: cash is never backdated; non-cash yesterday by owner/admin with a reason', async () => {
    const cash = await adv(() =>
      pay('F1', RS(10), '2026-10-09', {
        today: '2026-10-10',
        allowYesterday: true,
        backdateReason: 'late slip',
      }),
    );
    expect(cash).toMatch(/BLOCKED .*Cash cannot be backdated/);
    expect(await all(sql`SELECT * FROM cash_session`)).toEqual([]);
    for (const method of ['bank', 'jazzcash', 'easypaisa', 'cheque', 'other']) {
      const r = await pay('F1', RS(10), '2026-10-09', {
        method,
        accountId: 'BANK',
        today: '2026-10-10',
        allowYesterday: true,
        backdateReason: 'late slip',
      });
      expect(
        await all(sql`SELECT r.business_date, a.action FROM receipt r
          JOIN audit a ON a.entity_id = r.id AND a.action = 'backdate' WHERE r.id = ${r.receipt_id}`),
      ).toEqual([{ business_date: '2026-10-09', action: 'backdate' }]);
    }
    expect(await consistency()).toEqual([]);
  });

  it('item 3: an overlapping sponsorship is refused by the DB; the planner takes the latest-starting row per sponsor', async () => {
    const a3b = await adv(() =>
      exec(
        db,
        `INSERT INTO sponsorship (id, sponsor_id, student_id, share_pct, valid_from) VALUES ('SH3','SP','S4',60,'2026-12-01')`,
      ),
    );
    expect(a3b).toMatch(/BLOCKED .*sponsorship overlaps another/);
    // Head-specific vs all-heads overlaps too; a different sponsor or a later, non-overlapping row is fine.
    expect(
      await adv(() =>
        exec(
          db,
          `INSERT INTO sponsorship (id, sponsor_id, student_id, fee_head_id, share_pct, valid_from) VALUES ('SH4','SP','S4','TUI',10,'2027-01-01')`,
        ),
      ),
    ).toMatch(/BLOCKED/);
    await exec(
      db,
      `UPDATE sponsorship SET valid_to = '2026-11-30' WHERE id = 'SH'`,
      `INSERT INTO sponsor (id, name) VALUES ('SP2','Zakat')`,
      `INSERT INTO sponsorship (id, sponsor_id, student_id, share_pct, valid_from) VALUES ('SH5','SP','S4',60,'2026-12-01'),('SH6','SP2','S4',10,'2026-04-01')`,
    );
    // Pure planner: two live rows of one sponsor never add up — the latest-starting one wins.
    const live = [
      {
        id: 'a',
        sponsor_id: 'SP',
        student_id: 'S4',
        fee_head_id: null,
        share_pct: 50,
        valid_from: '2026-04-01',
        valid_to: null,
      },
      {
        id: 'b',
        sponsor_id: 'SP',
        student_id: 'S4',
        fee_head_id: null,
        share_pct: 40,
        valid_from: '2026-09-01',
        valid_to: null,
      },
    ];
    expect(sponsorShares(live, RS(1000))).toEqual([
      { sponsor_id: 'SP', ids: ['b'], pct: 40, amount: RS(400) },
    ]);
    expect(sponsorShares([...live].reverse(), RS(1000))).toEqual([
      { sponsor_id: 'SP', ids: ['b'], pct: 40, amount: RS(400) },
    ]);
  });

  it('item 4: voiding a sponsored fee voids the whole unit (family + sponsor roots); twice is already_void', async () => {
    await genAll('2026-11');
    const [fam] =
      await all(sql`SELECT id FROM charge WHERE student_id = 'S4' AND period_key = '2026-11'
      AND payer_type = 'family' AND kind = 'fee'`);
    const [spo] =
      await all(sql`SELECT id FROM charge WHERE student_id = 'S4' AND period_key = '2026-11'
      AND payer_type = 'sponsor' AND kind = 'fee'`);
    // Both payers have paid something on S4's November unit.
    await pay('F3', RS(500), '2026-11-02', {
      directed: [{ chargeId: fam?.id as string, amount: RS(500) }],
    });
    await collect(db, {
      payerType: 'sponsor',
      payerId: 'SP',
      amount: RS(1500),
      method: 'bank',
      accountId: 'BANK',
      businessDate: '2026-11-02',
      today: '2026-11-02',
      collectorId: 'U2',
      idempotencyKey: 'sp1',
      directed: [{ chargeId: spo?.id as string, amount: RS(1500) }],
    });
    // N10: voiding the family root takes the sponsor root with it.
    const v = await voidCharge(db, { chargeId: fam?.id as string, reason: 'never came', by: 'U1' });
    expect(v.voided.map((x) => x.charge_id).sort()).toEqual([fam?.id, spo?.id].sort());
    expect(v.amount).toBe(RS(3000));
    expect(v.released).toBe(RS(500) + RS(1500));
    expect((await roots('S4', '2026-11')).map((r) => [r.pt, r.net, r.paid])).toEqual([
      ['family', 0, 0],
      ['sponsor', 0, 0],
    ]);
    // The released money is credit again (the sponsor's 1500 + F3's 500 went to their open dues).
    expect(
      await adv(() => voidCharge(db, { chargeId: spo?.id as string, reason: 'x', by: 'U1' })),
    ).toMatch(/BLOCKED .*already void/);
    expect(
      await adv(() => voidCharge(db, { chargeId: fam?.id as string, reason: 'x', by: 'U1' })),
    ).toMatch(/BLOCKED .*already void/);
    // N6c: voiding from the sponsor side voids the family root too.
    const [spOct] =
      await all(sql`SELECT id FROM charge WHERE student_id = 'S4' AND period_key = '2026-10'
      AND payer_type = 'sponsor' AND kind = 'fee'`);
    const v2 = await voidCharge(db, { chargeId: spOct?.id as string, reason: 'x', by: 'U1' });
    expect(v2.voided).toHaveLength(2);
    expect((await roots('S4', '2026-10')).map((r) => r.net)).toEqual([0, 0]);
    expect(await consistency()).toEqual([]);
  });

  it('item 6: a joiner gets start + (due day − 1); a mid-month transfer keeps the normal due date', async () => {
    expect((await roots('S5', '2026-10')).map((r) => r.d)).toEqual(['2026-10-29']);
    expect((await roots('S6', '2026-10')).map((r) => r.d)).toEqual(['2026-10-10']);
    expect((await roots('S1', '2026-10')).map((r) => r.d)).toEqual(['2026-10-10']);
  });

  it('item 7: collection counts cash on its drawer session’s date, non-cash on its business_date', async () => {
    await pay('F1', RS(100), '2026-10-10');
    await pay('F2', RS(200), '2026-10-09', {
      method: 'bank',
      accountId: 'BANK',
      today: '2026-10-10',
      allowYesterday: true,
      backdateReason: 'late slip',
    });
    // A legacy cash row (entered before cash backdating was refused): dated 10-09, in 10-10's drawer.
    const [s] = await all(sql`SELECT id FROM cash_session WHERE business_date = '2026-10-10'`);
    await exec(
      db,
      `UPDATE receipt_series SET next_no = next_no + 1 WHERE series = 'R' AND year = 2026`,
      `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, cash_session_id, business_date, idempotency_key) VALUES ('old',(SELECT 'R-2026-' || printf('%05d', next_no - 1) FROM receipt_series WHERE series='R'),'payment','family','F3',${RS(300)},'cash','U2','${s?.id}','2026-10-09','kold')`,
    );
    const day = async (d: string) =>
      (await collectionByCollector(db, { from: d, to: d })).map((r) => [r.method, r.received]);
    expect(await day('2026-10-09')).toEqual([['bank', RS(200)]]);
    expect(await day('2026-10-10')).toEqual([['cash', RS(400)]]);
  });
});

import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import {
  addConcession,
  applyCredit,
  applyLateFines,
  closeSession,
  collect,
  collectionByCollector,
  defaulters,
  endConcession,
  ensureSeries,
  ensureSessionStatement,
  familyStatement,
  feeRegister,
  generateCharges,
  generationCursor,
  recordOpeningBalance,
  recordTransfer,
  refund,
  regenerateForStudent,
  reopenSession,
  reverseReceipt,
  roundRupee,
  runScheduled,
  sessionIdFor,
  sponsorStatement,
  waiveFine,
} from '../src/ledger';
import { createTestDb } from '../src/node';

// M3 ledger helpers on better-sqlite3 (the D1 path is apps/api/test/d1-fees.test.ts). Every test
// ends with ledger_consistency empty.

type Row = Record<string, unknown>;
const all = (db: AppDb, q: SQL) => db.all<Row>(q);
const run = (db: AppDb, ...qs: string[]) =>
  atomic(
    db,
    () => qs.map((q) => rawStatement(db, sql.raw(q))) as [ReturnType<typeof rawStatement>],
  );
const consistency = (db: AppDb) => all(db, sql`SELECT * FROM ledger_consistency`);

async function expectFail(fn: () => Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected failure ${pattern}`).toBeDefined();
  const text = [caught, (caught as { cause?: unknown }).cause]
    .map((e) =>
      e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e),
    )
    .join(' | ');
  expect(text).toMatch(pattern);
}

const RS = (n: number) => n * 100;

/**
 * Class 5 (P5): sections A (programme rate Rs 3,000) and B (group rate Rs 3,500); Class 6 (P6,
 * Rs 4,000). Tuition monthly, Admission once (Rs 5,000 for P5). Rate change: P5 tuition Rs 3,200
 * from November. Families: F1 = S1 (5-A) + S2 (6); F2 = S3 (5-B); F3 = S4 (5-A), sponsored 50%.
 */
async function seed(db: AppDb) {
  await run(
    db,
    `INSERT INTO "user" (id, email, name, status) VALUES ('U1', 'admin@x.pk', 'Admin', 'active'),
       ('U2', 'acct@x.pk', 'Accountant', 'active')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at, fine_rule, sibling_rule)
       VALUES ('SCH', 'Test School', 'R', '2026-04-01',
       '{"enabled":true,"grace_day":10,"type":"fixed","value":20000,"cap":null}', '[{"nth":2,"pct":10}]')`,
    `INSERT INTO session (id, name, start_date, end_date, is_current) VALUES ('SES', '2026-27', '2026-04-01', '2027-03-31', 1)`,
    `INSERT INTO programme (id, name, kind) VALUES ('P5', 'Class 5', 'grade'), ('P6', 'Class 6', 'grade')`,
    `INSERT INTO grp (id, programme_id, session_id, name) VALUES ('G5A', 'P5', 'SES', 'A'), ('G5B', 'P5', 'SES', 'B'), ('G6', 'P6', 'SES', 'A')`,
    `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI', 'Tuition', 'tuition', 'monthly'), ('ADM', 'Admission', 'admission', 'once')`,
    `INSERT INTO fee_rate (id, fee_head_id, programme_id, grp_id, amount, effective_from) VALUES
       ('r1', 'TUI', 'P5', NULL, ${RS(3000)}, '2026-04-01'),
       ('r2', 'TUI', NULL, 'G5B', ${RS(3500)}, '2026-04-01'),
       ('r3', 'TUI', 'P6', NULL, ${RS(4000)}, '2026-04-01'),
       ('r4', 'ADM', 'P5', NULL, ${RS(5000)}, '2026-04-01'),
       ('r5', 'TUI', 'P5', NULL, ${RS(3200)}, '2026-11-01')`,
    `INSERT INTO family (id, name) VALUES ('F1', 'Khan'), ('F2', 'Ahmed'), ('F3', 'Bibi')`,
    `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES
       ('S1', 'F1', '2026-0001', 'Ali', '2026-04-01'), ('S2', 'F1', '2026-0002', 'Sara', '2026-04-01'),
       ('S3', 'F2', '2026-0003', 'Omar', '2026-04-01'), ('S4', 'F3', '2026-0004', 'Zara', '2026-04-01')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES
       ('E1', 'S1', 'G5A', 1, '2026-04-01'), ('E2', 'S2', 'G6', 1, '2026-04-01'),
       ('E3', 'S3', 'G5B', 1, '2026-04-01'), ('E4', 'S4', 'G5A', 1, '2026-04-01')`,
    `INSERT INTO sponsor (id, name) VALUES ('SP', 'Trust')`,
    `INSERT INTO sponsorship (id, sponsor_id, student_id, fee_head_id, share_pct, valid_from) VALUES ('SH', 'SP', 'S4', NULL, 50, '2026-04-01')`,
    `INSERT INTO account (id, name, kind) VALUES ('CASH', 'Drawers', 'cash'), ('BANK', 'Bank', 'bank')`,
  );
}

let db: AppDb;
beforeEach(async () => {
  db = createTestDb();
  await seed(db);
});

const gen = (period: string, grpId: string, extra: Record<string, unknown> = {}) =>
  generateCharges(db, { period, scope: { grpId }, by: 'U1', ...extra });
const genAll = async (period: string) => {
  for (let cur = await generationCursor(db, period); cur; cur = await generationCursor(db, period))
    await generateCharges(db, {
      period,
      scope: { grpId: cur.grp_id, afterStudentId: cur.after_student_id },
      by: 'U1',
    });
};
const roots = (where = sql`1`) =>
  all(
    db,
    sql`SELECT c.student_id AS s, c.fee_head_id AS h, c.period_key AS p, c.payer_type AS pt, c.amount AS a, n.net, n.paid
        FROM charge c JOIN charge_net n ON n.id = c.id WHERE ${where} ORDER BY c.student_id, c.fee_head_id, c.payer_type, c.period_key`,
  );
/** Collected on its business day (the counter only takes today, or yesterday for an admin). */
const pay = (payer: string, amount: number, extra: Partial<Parameters<typeof collect>[1]> = {}) =>
  collect(db, {
    payerType: 'family',
    payerId: payer,
    amount,
    method: 'cash',
    businessDate: '2026-10-05',
    today: extra.businessDate ?? '2026-10-05',
    collectorId: 'U2',
    idempotencyKey: newId(),
    ...extra,
  });

describe('rounding', () => {
  it('rounds half-up to the rupee', () => {
    expect(roundRupee(RS(3335) * 10, 100)).toBe(RS(334)); // 333.50 -> 334
    expect(roundRupee(333_349 * 10, 100)).toBe(RS(333)); // 333.349 -> 333
    expect(roundRupee(300_000 * 16, 31)).toBe(RS(1548)); // 1548.387 -> 1548
    expect(roundRupee(0, 100)).toBe(0);
  });
});

describe('generation', () => {
  it('bills programme vs group rates, splits the sponsored share, and is idempotent', async () => {
    const first = await gen('2026-10', 'G5A');
    expect(first.counts).toEqual({ fees: 2, concessions: 0, sponsored: 1, allocations: 0 });
    expect(first.group_done).toBe(true);
    expect(first.next_grp_id).toBe('G5B');
    await gen('2026-10', 'G5B');
    expect(await roots()).toEqual([
      { s: 'S1', h: 'TUI', p: '2026-10', pt: 'family', a: RS(3000), net: RS(3000), paid: 0 },
      { s: 'S3', h: 'TUI', p: '2026-10', pt: 'family', a: RS(3500), net: RS(3500), paid: 0 },
      { s: 'S4', h: 'TUI', p: '2026-10', pt: 'family', a: RS(1500), net: RS(1500), paid: 0 },
      { s: 'S4', h: 'TUI', p: '2026-10', pt: 'sponsor', a: RS(1500), net: RS(1500), paid: 0 },
    ]);
    const again = await gen('2026-10', 'G5A');
    expect(again.counts).toEqual({ fees: 0, concessions: 0, sponsored: 0, allocations: 0 });
    expect(again.planned).toEqual([]);
    expect(
      await all(
        db,
        sql`SELECT kind, grp_id, done, fees, sponsored FROM billing_chunk ORDER BY rowid`,
      ),
    ).toEqual([
      { kind: 'fees', grp_id: 'G5A', done: 1, fees: 2, sponsored: 1 },
      { kind: 'fees', grp_id: 'G5B', done: 1, fees: 1, sponsored: 0 },
      { kind: 'fees', grp_id: 'G5A', done: 1, fees: 0, sponsored: 0 },
    ]);
    expect(await all(db, sql`SELECT count(*) AS n FROM billing_run`)).toEqual([{ n: 1 }]);
    expect(await consistency(db)).toEqual([]);
  });

  it('a dry run writes nothing and returns the would-insert list', async () => {
    const r = await gen('2026-10', 'G5A', { dryRun: true });
    expect(r.planned.map((c) => [c.student_id, c.payer_type, c.amount])).toEqual([
      ['S1', 'family', RS(3000)],
      ['S4', 'family', RS(1500)],
      ['S4', 'sponsor', RS(1500)],
    ]);
    expect(await all(db, sql`SELECT count(*) AS n FROM charge`)).toEqual([{ n: 0 }]);
    expect(await all(db, sql`SELECT count(*) AS n FROM billing_chunk`)).toEqual([{ n: 0 }]);
  });

  it('a rate change applies from its effective period only', async () => {
    await gen('2026-10', 'G5A');
    await gen('2026-11', 'G5A');
    expect((await roots(sql`c.student_id = 'S1'`)).map((r) => [r.p, r.a])).toEqual([
      ['2026-10', RS(3000)],
      ['2026-11', RS(3200)],
    ]);
  });

  it('concessions: pct rounded half-up, fixed capped at the fee, ended ones stop', async () => {
    await run(
      db,
      `INSERT INTO fee_rate (id, fee_head_id, programme_id, amount, effective_from) VALUES ('rx', 'TUI', 'P6', 333500, '2026-04-01')`,
    );
    await addConcession(db, {
      studentId: 'S2',
      feeHeadId: null,
      type: 'pct',
      value: 10,
      reason: 'sibling',
      approvedBy: 'U1',
      validFrom: '2026-04-01',
    });
    await addConcession(db, {
      studentId: 'S1',
      feeHeadId: 'TUI',
      type: 'fixed',
      value: RS(99999),
      reason: 'orphan',
      approvedBy: 'U1',
      validFrom: '2026-04-01',
    });
    const k = await addConcession(db, {
      studentId: 'S3',
      feeHeadId: null,
      type: 'pct',
      value: 50,
      reason: 'needy',
      approvedBy: 'U1',
      validFrom: '2026-04-01',
    });
    await endConcession(db, { id: k, endedAt: '2026-10-01', reason: 'reviewed', by: 'U1' });
    await genAll('2026-10');
    const lines = await all(
      db,
      sql`SELECT student_id AS s, amount AS a FROM charge WHERE kind = 'concession' ORDER BY student_id`,
    );
    // S2: 10% of Rs 3,335 = Rs 333.50 -> Rs 334. S1: fixed beyond the fee -> the whole fee.
    expect(lines).toEqual([
      { s: 'S1', a: -RS(3000) },
      { s: 'S2', a: -RS(334) },
    ]);
    expect((await roots(sql`c.student_id IN ('S1', 'S3')`)).map((r) => [r.s, r.net])).toEqual([
      ['S1', 0],
      ['S3', RS(3500)],
    ]);
    await expectFail(
      () => endConcession(db, { id: k, endedAt: '2026-11-01', reason: 'x', by: 'U1' }),
      /already_ended|already ended/,
    );
    expect(await consistency(db)).toEqual([]);
  });

  it('sponsorship share is of the amount after concessions; the family line shows the discount', async () => {
    await addConcession(db, {
      studentId: 'S4',
      feeHeadId: null,
      type: 'pct',
      value: 20,
      reason: 'topper',
      approvedBy: 'U1',
      validFrom: '2026-10-01',
    });
    await gen('2026-10', 'G5A');
    expect(await roots(sql`c.student_id = 'S4'`)).toEqual([
      { s: 'S4', h: 'TUI', p: '2026-10', pt: 'family', a: RS(1800), net: RS(1200), paid: 0 },
      { s: 'S4', h: 'TUI', p: '2026-10', pt: 'sponsor', a: RS(1200), net: RS(1200), paid: 0 },
    ]);
  });

  it('transferred mid-month: billed once, by the new group; a leaver before the period is not billed', async () => {
    await run(
      db,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S5', 'F2', '5', 'Hina', '2026-04-01'), ('S6', 'F2', '6', 'Bilal', '2026-04-01'), ('S8', 'F2', '8', 'Asad', '2026-04-01')`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, end_date, status) VALUES
         ('E5', 'S5', 'G5A', 1, '2026-04-01', '2026-10-15', 'transferred'),
         ('E6', 'S6', 'G5A', 1, '2026-04-01', '2026-09-20', 'withdrawn'),
         ('E8', 'S8', 'G5A', 1, '2026-04-01', '2026-10-05', 'withdrawn')`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, prev_enrolment_id) VALUES ('E5b', 'S5', 'G5B', 1, '2026-10-15', 'E5')`,
    );
    await genAll('2026-10');
    expect(
      (await roots(sql`c.student_id IN ('S5', 'S6', 'S8')`)).map((r) => [r.s, r.h, r.a]),
    ).toEqual([
      ['S5', 'TUI', RS(3500)],
      ['S8', 'TUI', RS(3000)],
    ]);
  });

  it('a mid-month joiner: full by default, pro-rata by days when asked; once heads only in the first period', async () => {
    await run(
      db,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S7', 'F2', '7', 'Nida', '2026-10-16')`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('E7', 'S7', 'G5A', 1, '2026-10-16')`,
    );
    const dry = await gen('2026-10', 'G5A', { dryRun: true });
    expect(
      dry.planned
        .filter((c) => c.student_id === 'S7')
        .map((c) => [c.fee_head_id, c.amount, c.due_date]),
    ).toEqual([
      // A mid-period joiner gets the month's grace from their start: 10-16 + (due day 10 − 1) days.
      ['ADM', RS(5000), '2026-10-25'],
      ['TUI', RS(3000), '2026-10-25'],
    ]);
    await gen('2026-10', 'G5A', { proRata: true });
    await gen('2026-11', 'G5A');
    // 16 of 31 days of Rs 3,000 = Rs 1,548.39 -> Rs 1,548; admission never again.
    expect((await roots(sql`c.student_id = 'S7'`)).map((r) => [r.p, r.h, r.a])).toEqual(
      [
        ['2026-10', 'ADM', RS(5000)],
        ['2026-11', 'TUI', RS(3200)],
        ['2026-10', 'TUI', RS(1548)],
      ].sort((a, b) => (`${a[1]}${a[0]}` < `${b[1]}${b[0]}` ? -1 : 1)),
    );
  });

  it('a group larger than the row budget is cut into resumable chunks', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `SX${String(i).padStart(2, '0')}`);
    await run(
      db,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ${ids.map((s) => `('${s}', 'F2', '${s}', '${s}', '2026-04-01')`).join(',')}`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ${ids.map((s) => `('E${s}', '${s}', 'G6', 1, '2026-04-01')`).join(',')}`,
    );
    const first = await generateCharges(db, {
      period: '2026-10',
      scope: { grpId: 'G6' },
      by: 'U1',
      maxRows: 25,
    });
    expect(first.group_done).toBe(false);
    expect(first.counts.fees).toBe(5);
    expect(await generationCursor(db, '2026-10')).toEqual({
      grp_id: 'G5A',
      after_student_id: null,
    });
    await genAll('2026-10');
    expect(await generationCursor(db, '2026-10')).toBeNull();
    expect(
      await all(
        db,
        sql`SELECT count(*) AS n FROM charge WHERE fee_head_id = 'TUI' AND student_id LIKE 'SX%'`,
      ),
    ).toEqual([{ n: 12 }]);
  });

  it('opening balance: owed becomes a root fee, credit becomes opening credit, once per student', async () => {
    await recordOpeningBalance(db, {
      studentId: 'S1',
      amount: RS(1200),
      asOf: '2026-09-30',
      by: 'U1',
    });
    await recordOpeningBalance(db, {
      studentId: 'S3',
      amount: -RS(800),
      asOf: '2026-09-30',
      by: 'U1',
    });
    await expectFail(
      () => recordOpeningBalance(db, { studentId: 'S1', amount: 1, asOf: '2026-09-30', by: 'U1' }),
      /already_recorded|already recorded/,
    );
    expect(await roots(sql`c.student_id = 'S1'`)).toEqual([
      expect.objectContaining({ s: 'S1', p: '2026-09', a: RS(1200), net: RS(1200) }),
    ]);
    expect(await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = 'F2'`)).toEqual([
      { credit: RS(800) },
    ]);
    // The credit pays the next month automatically.
    await gen('2026-10', 'G5B');
    expect(await roots(sql`c.student_id = 'S3'`)).toEqual([
      expect.objectContaining({ net: RS(3500), paid: RS(800) }),
    ]);
    await expectFail(
      () =>
        run(
          db,
          `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key) VALUES ('x', 'x', 'opening', 'family', 'F1', 5, 'cash', 'U1', 'd', 'opening:S2')`,
        ),
      /opening credit must match/,
    );
    expect(await consistency(db)).toEqual([]);
  });
});

describe('collection', () => {
  beforeEach(async () => {
    await genAll('2026-09');
    await genAll('2026-10');
  });

  it('allocates oldest first across siblings; partial; numbers from the series; opens the session', async () => {
    const r = await pay('F1', RS(9000));
    const allocs = await all(
      db,
      sql`SELECT c.student_id AS s, c.period_key AS p, a.amount FROM receipt_allocation a JOIN charge c ON c.id = a.charge_id WHERE a.receipt_id = ${r.receipt_id} ORDER BY a.rowid`,
    );
    // Sep: Ali 3000, Sara 4000 (oldest month first, then by name); then Oct: Ali 2000 of 3000.
    expect(allocs).toEqual([
      { s: 'S1', p: '2026-09', amount: RS(3000) },
      { s: 'S2', p: '2026-09', amount: RS(4000) },
      { s: 'S1', p: '2026-10', amount: RS(2000) },
    ]);
    expect(
      await all(db, sql`SELECT receipt_no, cash_session_id IS NOT NULL AS s FROM receipt`),
    ).toEqual([{ receipt_no: 'R-2026-00001', s: 1 }]);
    expect(
      await all(db, sql`SELECT collector_id, business_date, closed_at FROM cash_session`),
    ).toEqual([{ collector_id: 'U2', business_date: '2026-10-05', closed_at: null }]);
    expect(await consistency(db)).toEqual([]);
  });

  it('directed allocation pays exactly the chosen rows; the rest is credit', async () => {
    const [oct] = await all(
      db,
      sql`SELECT id FROM charge WHERE student_id = 'S2' AND period_key = '2026-10' AND kind = 'fee'`,
    );
    const r = await pay('F1', RS(5000), {
      directed: [{ chargeId: oct?.id as string, amount: RS(4000) }],
    });
    expect(
      await all(
        db,
        sql`SELECT charge_id, amount FROM receipt_allocation WHERE receipt_id = ${r.receipt_id}`,
      ),
    ).toEqual([{ charge_id: oct?.id, amount: RS(4000) }]);
    expect(await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = 'F1'`)).toEqual([
      { credit: RS(1000) },
    ]);
    await expectFail(
      () => pay('F1', RS(100), { directed: [{ chargeId: oct?.id as string, amount: RS(100) }] }),
      /not an open charge/,
    );
    const [sep] = await all(
      db,
      sql`SELECT id FROM charge WHERE student_id = 'S2' AND period_key = '2026-09' AND kind = 'fee'`,
    );
    await expectFail(
      () => pay('F1', RS(5000), { directed: [{ chargeId: sep?.id as string, amount: RS(4001) }] }),
      /exceeds_due/,
    );
  });

  it('advance credit is applied to the next generated month', async () => {
    await pay('F2', RS(10000)); // Sep + Oct 3500 each; 3000 credit
    expect(await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = 'F2'`)).toEqual([
      { credit: RS(3000) },
    ]);
    const nov = await gen('2026-11', 'G5B');
    expect(nov.counts.allocations).toBe(1);
    expect(await roots(sql`c.student_id = 'S3' AND c.period_key = '2026-11'`)).toEqual([
      expect.objectContaining({ net: RS(3500), paid: RS(3000) }),
    ]);
    expect(await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = 'F2'`)).toEqual([
      { credit: 0 },
    ]);
    expect(await consistency(db)).toEqual([]);
  });

  it('an idempotency replay returns the same receipt; a different body with the key is refused', async () => {
    const key = newId();
    const a = await pay('F1', RS(1000), { idempotencyKey: key });
    const b = await pay('F1', RS(1000), { idempotencyKey: key });
    expect(b).toEqual({ receipt_id: a.receipt_id, replayed: true });
    await expectFail(() => pay('F1', RS(2000), { idempotencyKey: key }), /idempotency_conflict/);
    expect(await all(db, sql`SELECT count(*) AS n, max(receipt_no) AS no FROM receipt`)).toEqual([
      { n: 1, no: 'R-2026-00001' },
    ]);
  });

  it('a closed session refuses receipts until reopened with a reason', async () => {
    const r = await pay('F1', RS(1000));
    const [s] = await all(
      db,
      sql`SELECT cash_session_id AS id FROM receipt WHERE id = ${r.receipt_id}`,
    );
    const closed = await closeSession(db, {
      sessionId: s?.id as string,
      counted: RS(900),
      by: 'U2',
    });
    expect([closed.expected, closed.counted, closed.variance]).toEqual([
      RS(1000),
      RS(900),
      -RS(100),
    ]);
    await expectFail(() => pay('F1', RS(500)), /session_closed/);
    await reopenSession(db, { sessionId: s?.id as string, reason: 'late receipt', by: 'U1' });
    await pay('F1', RS(500));
    expect(
      await all(db, sql`SELECT action FROM audit WHERE entity = 'cash_session' ORDER BY rowid`),
    ).toEqual([{ action: 'close' }, { action: 'reopen' }]);
  });

  it('expected cash nets reversals, refunds and handovers out of the drawer', async () => {
    const a = await pay('F1', RS(20000)); // 14000 due over 2 months -> 6000 credit
    await recordTransfer(db, {
      fromAccount: 'CASH',
      toAccount: 'BANK',
      amount: RS(5000),
      date: '2026-10-05',
      note: 'deposit',
      by: 'U2',
    });
    await refund(db, {
      payerType: 'family',
      payerId: 'F1',
      amount: RS(1000),
      method: 'cash',
      reason: 'overpaid',
      by: 'U2',
      businessDate: '2026-10-05',
      today: '2026-10-05',
      idempotencyKey: newId(),
    });
    const [s] = await all(
      db,
      sql`SELECT cash_session_id AS id FROM receipt WHERE id = ${a.receipt_id}`,
    );
    const closed = await closeSession(db, {
      sessionId: s?.id as string,
      counted: RS(14000),
      by: 'U2',
    });
    expect(closed.expected).toBe(RS(20000 - 5000 - 1000));
    expect(closed.variance).toBe(0);
    await expectFail(
      () =>
        recordTransfer(db, {
          fromAccount: 'CASH',
          toAccount: 'BANK',
          amount: 1,
          date: '2026-10-05',
          by: 'U2',
        }),
      /session_closed/,
    );
    expect(await consistency(db)).toEqual([]);
  });

  it('reversal with re-entry, and refunds only within credit', async () => {
    const a = await pay('F1', RS(5000));
    const { reversalId, reentryId } = await reverseReceipt(db, {
      receiptId: a.receipt_id,
      byUserId: 'U1',
      reason: 'keyed 5000 instead of 4000',
      series: { series: 'R', year: 2026 },
      businessDate: '2026-10-06',
      prelude: [
        ensureSeries({ series: 'R', year: 2026 }),
        ensureSessionStatement('U1', '2026-10-06'),
      ],
      cashSessionId: sessionIdFor('U1', '2026-10-06'),
      reenter: { amount: RS(4000), allocations: [] },
    });
    expect(reversalId).toBeTruthy();
    await applyCredit(db, { payerType: 'family', payerId: 'F1' });
    expect(await all(db, sql`SELECT kind, amount FROM receipt ORDER BY receipt_no`)).toEqual([
      { kind: 'payment', amount: RS(5000) },
      { kind: 'reversal', amount: -RS(5000) },
      { kind: 'payment', amount: RS(4000) },
    ]);
    expect(
      (
        await all(
          db,
          sql`SELECT sum(amount) AS s FROM receipt_allocation WHERE receipt_id = ${reentryId}`,
        )
      )[0]?.s,
    ).toBe(RS(4000));
    await expectFail(
      () =>
        refund(db, {
          payerType: 'family',
          payerId: 'F1',
          amount: 1,
          method: 'cash',
          reason: 'x',
          by: 'U1',
          businessDate: '2026-10-06',
          today: '2026-10-06',
          idempotencyKey: newId(),
        }),
      /exceeds_credit/,
    );
    await pay('F1', RS(20000), { businessDate: '2026-10-06' });
    const credit = (await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = 'F1'`))[0]
      ?.credit as number;
    await refund(db, {
      payerType: 'family',
      payerId: 'F1',
      amount: credit,
      method: 'cash',
      reason: 'leaving',
      by: 'U1',
      businessDate: '2026-10-06',
      today: '2026-10-06',
      idempotencyKey: newId(),
    });
    expect(await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = 'F1'`)).toEqual([
      { credit: 0 },
    ]);
    expect(await consistency(db)).toEqual([]);
  });

  it('a concession added to a paid month releases the surplus as credit (regenerate)', async () => {
    await pay('F2', RS(7000)); // Sep + Oct paid in full
    await addConcession(db, {
      studentId: 'S3',
      feeHeadId: null,
      type: 'pct',
      value: 20,
      reason: 'scholarship',
      approvedBy: 'U1',
      validFrom: '2026-10-01',
    });
    const dry = await regenerateForStudent(db, {
      studentId: 'S3',
      period: '2026-10',
      by: 'U1',
      dryRun: true,
    });
    expect(dry.counts).toMatchObject({ late_concessions: 1, released: RS(700) });
    const r = await regenerateForStudent(db, { studentId: 'S3', period: '2026-10', by: 'U1' });
    expect(r.counts).toMatchObject({ late_concessions: 1, released: RS(700) });
    expect(await roots(sql`c.student_id = 'S3' AND c.period_key = '2026-10'`)).toEqual([
      expect.objectContaining({ net: RS(2800), paid: RS(2800) }),
    ]);
    expect(await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = 'F2'`)).toEqual([
      { credit: RS(700) },
    ]);
    const again = await regenerateForStudent(db, { studentId: 'S3', period: '2026-10', by: 'U1' });
    expect(again.counts.late_concessions).toBe(0);
    expect(await consistency(db)).toEqual([]);
  });
});

describe('fines', () => {
  beforeEach(async () => {
    await genAll('2026-10');
  });

  it('applies once after the grace day, never to paid roots or sponsors; pct is capped', async () => {
    await pay('F1', RS(3000)); // Ali's Oct paid; Sara's not
    expect(
      (await applyLateFines(db, { period: '2026-10', asOf: '2026-10-10', by: 'U1' })).applied,
    ).toBe(0);
    const r = await applyLateFines(db, { period: '2026-10', asOf: '2026-10-11', by: 'U1' });
    expect(r.applied).toBe(3); // Sara, Omar, Zara's family share
    expect(
      (await applyLateFines(db, { period: '2026-10', asOf: '2026-10-12', by: 'U1' })).applied,
    ).toBe(0);
    expect(
      await all(
        db,
        sql`SELECT student_id AS s, amount FROM charge WHERE kind = 'fine' ORDER BY student_id`,
      ),
    ).toEqual([
      { s: 'S2', amount: RS(200) },
      { s: 'S3', amount: RS(200) },
      { s: 'S4', amount: RS(200) },
    ]);
    await run(
      db,
      `UPDATE school SET fine_rule = '{"enabled":true,"grace_day":10,"type":"pct","value":10,"cap":30000}'`,
    );
    await genAll('2026-11');
    await applyLateFines(db, { period: '2026-11', asOf: '2026-11-11', by: 'U1' });
    expect(
      await all(
        db,
        sql`SELECT student_id AS s, amount FROM charge WHERE kind = 'fine' AND period_key = '2026-11' ORDER BY student_id`,
      ),
    ).toEqual([
      { s: 'S1', amount: RS(300) }, // 10% of 3200 = 320, capped at 300
      { s: 'S2', amount: RS(300) },
      { s: 'S3', amount: RS(300) },
      { s: 'S4', amount: RS(160) },
    ]);
    expect(await consistency(db)).toEqual([]);
  });

  it('a waiver removes the fine; on a paid root it releases the surplus first', async () => {
    await applyLateFines(db, { period: '2026-10', asOf: '2026-10-11', by: 'U1' });
    await pay('F2', RS(3700)); // Omar's fee + fine
    const [fine] = await all(
      db,
      sql`SELECT id FROM charge WHERE kind = 'fine' AND student_id = 'S3'`,
    );
    const w = await waiveFine(db, { fineId: fine?.id as string, reason: 'first time', by: 'U1' });
    expect(w).toMatchObject({ amount: RS(200), released: RS(200) });
    expect(await roots(sql`c.student_id = 'S3'`)).toEqual([
      expect.objectContaining({ net: RS(3500), paid: RS(3500) }),
    ]);
    expect(await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = 'F2'`)).toEqual([
      { credit: RS(200) },
    ]);
    await expectFail(
      () => waiveFine(db, { fineId: fine?.id as string, reason: 'again', by: 'U1' }),
      /already_waived/,
    );
    expect(await consistency(db)).toEqual([]);
  });
});

describe('reports', () => {
  beforeEach(async () => {
    await genAll('2026-09');
    await genAll('2026-10');
  });

  it('defaulters count overdue months with partial payments; sponsored students can be excluded', async () => {
    await pay('F1', RS(5000)); // Sep: Ali 3000, Sara 2000 of 4000
    const rows = await defaulters(db, { today: '2026-10-20' });
    expect(rows.map((r) => [r.student_id, r.months_overdue, r.overdue, r.sponsored])).toEqual([
      ['S3', 2, RS(7000), false],
      ['S2', 2, RS(6000), false],
      ['S1', 1, RS(3000), false],
      ['S4', 2, RS(3000), true],
    ]);
    expect(
      (await defaulters(db, { today: '2026-10-20', excludeSponsored: true })).map(
        (r) => r.student_id,
      ),
    ).toEqual(['S3', 'S2', 'S1']);
    expect(
      (await defaulters(db, { today: '2026-10-20', minMonths: 2, minAmount: RS(6500) })).map(
        (r) => r.student_id,
      ),
    ).toEqual(['S3']);
    expect(
      (await defaulters(db, { today: '2026-10-20', grpId: 'G5A' })).map((r) => r.student_id),
    ).toEqual(['S1', 'S4']);
    // Before October's due date only September counts.
    expect(
      (await defaulters(db, { today: '2026-10-05' })).find((r) => r.student_id === 'S3')
        ?.months_overdue,
    ).toBe(1);
  });

  it('family and sponsor statements, the register and collection by collector agree with the ledger', async () => {
    await pay('F1', RS(5000));
    await collect(db, {
      payerType: 'sponsor',
      payerId: 'SP',
      amount: RS(1500),
      method: 'bank',
      accountId: 'BANK',
      businessDate: '2026-10-05',
      today: '2026-10-05',
      collectorId: 'U1',
      idempotencyKey: newId(),
    });
    const st = await familyStatement(db, 'F1', '2026-10-20');
    expect(st?.totals).toMatchObject({
      net: RS(14000),
      paid: RS(5000),
      due: RS(9000),
      overdue: RS(9000),
    });
    expect(st?.receipts).toHaveLength(1);
    const sp = await sponsorStatement(db, 'SP');
    expect(sp?.totals).toEqual({ net: RS(3000), paid: RS(1500), due: RS(1500) });
    const reg = await feeRegister(db, { grpId: 'G5A', period: '2026-10' });
    expect(reg.map((r) => [r.student_id, r.payer_type, r.net, r.paid])).toEqual([
      ['S1', 'family', RS(3000), 0],
      ['S4', 'family', RS(1500), 0],
      ['S4', 'sponsor', RS(1500), 0], // the sponsor's payment went to September first
    ]);
    const col = await collectionByCollector(db, { from: '2026-10-01', to: '2026-10-31' });
    expect(col.map((c) => [c.collector_id, c.method, c.payments, c.net])).toEqual([
      ['U2', 'cash', 1, RS(5000)], // "Accountant" sorts before "Admin"
      ['U1', 'bank', 1, RS(1500)],
    ]);
    const [sum] = await all(
      db,
      sql`SELECT sum(amount) AS s FROM receipt WHERE kind IN ('payment','reversal','refund')`,
    );
    expect(col.reduce((a, c) => a + c.net, 0)).toBe(sum?.s);
  });
});

describe('cron', () => {
  it('generates the Karachi month chunk by chunk, then fines after the grace day', async () => {
    // 2026-09-30 19:30 UTC = 1 October 00:30 in Karachi.
    const oct1 = Date.UTC(2026, 8, 30, 19, 30);
    const r1 = await runScheduled(db, { now: oct1, maxChunks: 2 });
    expect(r1.period).toBe('2026-10');
    expect(r1.generated.map((g) => g.grp_id)).toEqual(['G5A', 'G5B']);
    const r2 = await runScheduled(db, { now: oct1 + 1_800_000, maxChunks: 2 });
    expect(r2.generated.map((g) => g.grp_id)).toEqual(['G6']);
    // Fines are checked every tick (any period); nothing is overdue before the due day.
    expect(r2.fines).toEqual([{ applied: 0, done: true }]);
    const r3 = await runScheduled(db, { now: Date.UTC(2026, 9, 11, 3) });
    expect(r3.generated).toEqual([]);
    expect(r3.fines).toEqual([{ applied: 4, done: true }]);
    expect((await runScheduled(db, { now: Date.UTC(2026, 9, 11, 4) })).fines).toEqual([
      { applied: 0, done: true },
    ]);
    await run(db, `UPDATE school SET setup_completed_at = NULL`);
    expect((await runScheduled(db, { now: oct1 })).skipped).toBe('setup_incomplete');
    expect(await consistency(db)).toEqual([]);
  });
});

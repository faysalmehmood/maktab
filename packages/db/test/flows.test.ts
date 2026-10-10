import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createdObjects, currentSqlFiles } from '../scripts/sync-custom-sql';
import { type AppDb, atomic, rawStatement } from '../src/client';
import { allocate, createReceipt, LedgerError, reverseReceipt } from '../src/ledger';
import { createTestDb, MIGRATIONS_DIR } from '../src/node';

// The M0 closing review (ADR 0002): the reviewer's flow script, as tests. Every legitimate flow must
// pass AND leave ledger_consistency empty; every adversarial sequence (first review + probes) must be
// refused as a whole batch, by the named rule.

type Row = Record<string, unknown>;

async function expectAbort(fn: () => unknown, pattern: RegExp) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected failure matching ${pattern}`).toBeDefined();
  const text = [caught, (caught as { cause?: unknown }).cause]
    .map((e) => (e instanceof Error ? e.message : String(e)))
    .join(' | ');
  expect(text).toMatch(pattern);
}

const all = (db: AppDb, q: SQL) => db.all<Row>(q);
const batch = (db: AppDb, ...qs: SQL[]) =>
  atomic(db, () => qs.map((q) => rawStatement(db, q)) as [ReturnType<typeof rawStatement>]);

let n = 0;
const C = (
  id: string,
  kind: string,
  amount: number,
  parent: string | null = null,
  student = 'S1',
  payer = 'F1',
  period = '2026-03',
) => sql`INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount,
          due_date, kind, parent_charge_id, reason)
        VALUES (${id}, ${student}, 'H1', ${period}, 'family', ${payer}, ${amount}, '2026-03-10',
          ${kind}, ${parent}, 'r')`;
/**
 * Raw receipt rows. Since the M3 fix pass (sql/50_fees.sql receipt_payment_shape) a payment without a
 * session is a bank payment into A2; with a session it is cash, numbered from series R — bump it first
 * (`bumpR`).
 */
const R = (
  id: string,
  kind: 'payment' | 'reversal' | 'refund',
  amount: number,
  reverses: string | null = null,
  session: string | null = null,
  payer = 'F1',
) => {
  n++;
  const method = session ? 'cash' : 'bank';
  const no = session
    ? sql`(SELECT series || '-' || year || '-' || printf('%05d', next_no - 1) FROM receipt_series WHERE series = 'R' AND year = 2026)`
    : sql`${`N${n}`}`;
  return sql`INSERT INTO receipt (id, receipt_no, kind, reverses_id, payer_type, payer_id, amount, method,
          account_id, collector_id, cash_session_id, business_date, idempotency_key)
        VALUES (${id}, ${no}, ${kind}, ${reverses}, 'family', ${payer}, ${amount}, ${method},
          ${session ? null : 'A2'}, 'U1', ${session}, '2026-03-05', ${`k${n}`})`;
};
const bumpR = sql`UPDATE receipt_series SET next_no = next_no + 1 WHERE series = 'R' AND year = 2026`;
const A = (r: string, c: string, amount: number, id = newId()) =>
  sql`INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES (${id}, ${r}, ${c}, ${amount})`;
const raw = (q: string) => sql.raw(q);

const credit = async (db: AppDb, payer = 'F1') =>
  (await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = ${payer}`))[0]?.credit ?? 0;
const status = (db: AppDb) =>
  all(db, sql`SELECT id, net, paid, due FROM charge_status ORDER BY id`);
const consistency = (db: AppDb) => all(db, sql`SELECT * FROM ledger_consistency`);

async function seed(db: AppDb) {
  await batch(
    db,
    raw(`INSERT INTO user (id, email) VALUES ('U1', 'a@x.pk'), ('U2', 'b@x.pk')`),
    raw(`INSERT INTO family (id, name) VALUES ('F1', 'Khan'), ('F2', 'Ahmed')`),
    raw(`INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES
         ('S1', 'F1', '1', 'Ali', '2026-01-01'), ('S2', 'F1', '2', 'Sara', '2026-01-01'),
         ('S9', 'F2', '9', 'Omar', '2026-01-01')`),
    raw(
      `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('H1', 'Tuition', 'tuition', 'monthly')`,
    ),
    raw(
      `INSERT INTO account (id, name, kind) VALUES ('A1', 'Drawer', 'cash'), ('A2', 'Bank', 'bank')`,
    ),
    raw(`INSERT INTO staff (id, name) VALUES ('T1', 'Teacher')`),
    raw(`INSERT INTO receipt_series (series, year, next_no) VALUES ('R', 2026, 1)`),
  );
}

const fresh = async () => {
  const db = createTestDb();
  await seed(db);
  return db;
};

const closeCs = `UPDATE cash_session SET expected = 5000, counted = 5000, closed_at = 'x', closed_by = 'U1',
                 reopened_by = NULL, reopened_at = NULL WHERE id = 'cs'`;
const reopenCs = (reason: string) =>
  `UPDATE cash_session SET closed_at = NULL, reopened_by = 'U2', reopened_at = 'y', reopen_reason = '${reason}' WHERE id = 'cs'`;
const payslip = [
  raw(`INSERT INTO payslip (id, staff_id, period_key) VALUES ('ps', 'T1', '2026-03')`),
  raw(`INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('l1', 'ps', 'basic', 30000),
       ('l2', 'ps', 'allowance', 2000), ('l3', 'ps', 'deduction', 1500), ('l4', 'ps', 'advance_recovery', 500)`),
  raw(`UPDATE payslip SET status = 'approved', approved_by = 'U1' WHERE id = 'ps'`),
];
const pay = (id: string, amount: number) =>
  raw(
    `INSERT INTO salary_payment (id, payslip_id, amount, account_id, date) VALUES ('${id}', 'ps', ${amount}, 'A1', 'd')`,
  );

/** The reviewer's 10 legitimate flows. */
const legit: [string, SQL[], ((db: AppDb) => Promise<void>)?][] = [
  [
    'family receipt across siblings',
    [
      C('a', 'fee', 5000),
      C('b', 'fee', 4000, null, 'S2'),
      R('p', 'payment', 9000),
      A('p', 'a', 5000),
      A('p', 'b', 4000),
    ],
    async (db) => expect((await status(db)).map((r) => r.due)).toEqual([0, 0]),
  ],
  [
    'partial payment',
    [C('a', 'fee', 5000), R('p', 'payment', 2000), A('p', 'a', 2000)],
    async (db) => expect((await status(db))[0]).toMatchObject({ paid: 2000, due: 3000 }),
  ],
  [
    'advance credit auto-applied later',
    [
      R('p', 'payment', 10000),
      C('a', 'fee', 5000),
      A('p', 'a', 5000),
      C('b', 'fee', 5000, null, 'S1', 'F1', '2026-04'),
      A('p', 'b', 5000),
    ],
    async (db) => expect(await credit(db)).toBe(0),
  ],
  [
    'release + concession in one batch (paid fee)',
    [
      C('a', 'fee', 5000),
      R('p', 'payment', 5000),
      A('p', 'a', 5000),
      A('p', 'a', -1000),
      C('k', 'concession', -1000, 'a'),
    ],
    async (db) => expect(await credit(db)).toBe(1000),
  ],
  [
    'reversal with re-entry',
    [
      C('a', 'fee', 5000),
      R('p', 'payment', 5000),
      A('p', 'a', 5000),
      R('rv', 'reversal', -5000, 'p'),
      A('rv', 'a', -5000),
      R('p2', 'payment', 5000),
      A('p2', 'a', 5000),
    ],
    async (db) => expect(await credit(db)).toBe(0),
  ],
  [
    'refund from credit',
    [C('a', 'fee', 5000), R('p', 'payment', 8000), A('p', 'a', 5000), R('rf', 'refund', -3000)],
    async (db) => expect(await credit(db)).toBe(0),
  ],
  [
    'fine then waiver (fine paid, release, waive)',
    [
      C('a', 'fee', 5000),
      C('f', 'fine', 500, 'a'),
      R('p', 'payment', 5500),
      A('p', 'a', 5500),
      A('p', 'a', -500),
      C('w', 'fine_waiver', -500, 'f'),
    ],
    async (db) => expect((await status(db))[0]).toMatchObject({ net: 5000, paid: 5000, due: 0 }),
  ],
  [
    'mid-month backfill (late fee row after payment credit)',
    [R('p', 'payment', 3000), C('a', 'fee', 3000, null, 'S1', 'F1', '2026-02'), A('p', 'a', 3000)],
  ],
  [
    'cash handover then close, reopen with reason, receipt',
    [
      raw(
        `INSERT INTO cash_session (id, collector_id, business_date, opening) VALUES ('cs', 'U1', '2026-03-05', 0)`,
      ),
      bumpR,
      R('p', 'payment', 5000, null, 'cs'),
      raw(
        `INSERT INTO transfer (id, from_account, to_account, cash_session_id, amount, date) VALUES ('t', 'A1', 'A2', 'cs', 5000, '2026-03-05')`,
      ),
      raw(closeCs),
      raw(reopenCs('late receipt')),
      bumpR,
      R('p2', 'payment', 100, null, 'cs'),
    ],
  ],
  [
    'payslip draft -> approved -> paid (in two instalments, up to net)',
    [
      ...payslip,
      pay('sp1', 20000),
      pay('sp2', 10000),
      raw(`UPDATE payslip SET status = 'paid' WHERE id = 'ps'`),
    ],
  ],
];

describe('reviewer flows: legitimate', () => {
  for (const [name, stmts, check] of legit) {
    it(`${name}: allowed, ledger_consistency empty`, async () => {
      const db = await fresh();
      await batch(db, ...stmts);
      await check?.(db);
      expect(await consistency(db)).toEqual([]);
    });
  }
});

/** First-review adversarial sequences plus the closing review's probes. */
const adversarial: [string, SQL[], RegExp][] = [
  [
    'release larger than allocated',
    [C('a', 'fee', 5000), R('p', 'payment', 5000), A('p', 'a', 3000), A('p', 'a', -4000)],
    /release exceeds/,
  ],
  [
    'reversal then refund exceeding credit',
    [
      C('a', 'fee', 5000),
      R('p', 'payment', 5000),
      A('p', 'a', 5000),
      R('rv', 'reversal', -5000, 'p'),
      A('rv', 'a', -5000),
      R('rf', 'refund', -1000),
    ],
    /refund exceeds unallocated credit/,
  ],
  [
    'concession with no release when fully paid',
    [
      C('a', 'fee', 5000),
      R('p', 'payment', 5000),
      A('p', 'a', 5000),
      C('k', 'concession', -1000, 'a'),
    ],
    /release the allocation first/,
  ],
  [
    'reopen cash session without reason',
    [
      raw(`INSERT INTO cash_session (id, collector_id, business_date) VALUES ('cs', 'U1', 'd')`),
      raw(closeCs),
      raw(
        `UPDATE cash_session SET closed_at = NULL, reopened_by = 'U2', reopened_at = 'y' WHERE id = 'cs'`,
      ),
    ],
    /only a reopen with reason/,
  ],
  [
    'payslip paid without approval',
    [
      raw(`INSERT INTO payslip (id, staff_id, period_key) VALUES ('ps', 'T1', '2026-03')`),
      raw(`UPDATE payslip SET status = 'paid', approved_by = 'U1' WHERE id = 'ps'`),
    ],
    /only moves draft -> approved -> paid/,
  ],
  [
    'salary_payment on draft slip',
    [
      raw(`INSERT INTO payslip (id, staff_id, period_key) VALUES ('ps', 'T1', '2026-03')`),
      pay('sp', 1),
    ],
    /payslip is not approved/,
  ],
  [
    'sign: allocate +2000 to A, -1000 to B from a 1000 receipt',
    [
      C('a', 'fee', 5000),
      C('b', 'fee', 5000, null, 'S2'),
      R('p', 'payment', 1000),
      A('p', 'a', 2000),
      A('p', 'b', -1000),
    ],
    /allocations exceed receipt amount/,
  ],
  [
    'PROBE refund then allocate the refunded credit',
    [C('a', 'fee', 5000), R('p', 'payment', 5000), R('rf', 'refund', -5000), A('p', 'a', 5000)],
    /allocation exceeds payer credit/,
  ],
  [
    'PROBE refund then reverse the same payment',
    [R('p', 'payment', 5000), R('rf', 'refund', -5000), R('rv', 'reversal', -5000, 'p')],
    /reversal would leave negative payer credit/,
  ],
  [
    'PROBE salary_payment exceeds payslip',
    [...payslip, pay('sp', 999999)],
    /salary payments exceed payslip net/,
  ],
  [
    'PROBE repeated salary overpayment (each below net, together above)',
    [...payslip, pay('sp1', 30000), pay('sp2', 1)],
    /salary payments exceed payslip net/,
  ],
  [
    'PROBE second reopen reuses the stale reopen record',
    [
      raw(`INSERT INTO cash_session (id, collector_id, business_date) VALUES ('cs', 'U1', 'd')`),
      raw(closeCs),
      raw(reopenCs('r1')),
      raw(closeCs),
      raw(`UPDATE cash_session SET closed_at = NULL WHERE id = 'cs'`),
    ],
    /only a reopen with reason/,
  ],
  [
    'PROBE second reopen repeats the previous reason',
    [
      raw(`INSERT INTO cash_session (id, collector_id, business_date) VALUES ('cs', 'U1', 'd')`),
      raw(closeCs),
      raw(reopenCs('r1')),
      raw(closeCs),
      raw(reopenCs('r1')),
    ],
    /reopen reason must differ/,
  ],
  [
    'PROBE close without clearing the reopen record',
    [
      raw(`INSERT INTO cash_session (id, collector_id, business_date) VALUES ('cs', 'U1', 'd')`),
      raw(closeCs),
      raw(reopenCs('r1')),
      raw(`UPDATE cash_session SET counted = 0, closed_at = 'z' WHERE id = 'cs'`),
    ],
    /closing must clear reopened_by and reopened_at/,
  ],
  [
    'PROBE edit reopen audit fields while open',
    [
      raw(`INSERT INTO cash_session (id, collector_id, business_date) VALUES ('cs', 'U1', 'd')`),
      raw(closeCs),
      raw(reopenCs('r1')),
      raw(`UPDATE cash_session SET reopened_by = 'U1', reopen_reason = 'nothing' WHERE id = 'cs'`),
    ],
    /reopen record is fixed while the session is open/,
  ],
  [
    'PROBE born with a forged reopen record',
    [
      raw(
        `INSERT INTO cash_session (id, collector_id, business_date, reopened_by, reopened_at, reopen_reason) VALUES ('cs', 'U1', 'd', 'U2', 'y', 'r')`,
      ),
    ],
    /no reopen record/,
  ],
  [
    'PROBE allocate across payers',
    [C('a', 'fee', 5000, null, 'S9', 'F2'), R('p', 'payment', 5000), A('p', 'a', 5000)],
    /payer must match/,
  ],
  ['PROBE REAL money', [R('p', 'payment', 12.5)], /receipt_amount_int/],
  ['PROBE dup fee row', [C('a', 'fee', 5000), C('a2', 'fee', 5000)], /UNIQUE constraint failed/],
  [
    'PROBE att_mark delete',
    [
      raw(`INSERT INTO programme (id, name, kind) VALUES ('P', 'Class 5', 'grade')`),
      raw(`INSERT INTO grp (id, programme_id, name) VALUES ('G', 'P', '5-A')`),
      raw(`INSERT INTO att_register (id, client_id, grp_id, date, taken_by, taken_at, batch_token)
           VALUES ('AR', 'c', 'G', '2026-03-05', 'U1', '2026-03-05T08:00:00Z', 'b')`),
      raw(`INSERT INTO att_mark (register_id, student_id, status) VALUES ('AR', 'S1', 'P')`),
      raw(`DELETE FROM att_mark`),
    ],
    /att_mark is append-only/,
  ],
  [
    'PROBE negative payslip line to inflate the net',
    [
      raw(`INSERT INTO payslip (id, staff_id, period_key) VALUES ('ps', 'T1', '2026-03')`),
      raw(
        `INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('l', 'ps', 'deduction', -5000)`,
      ),
    ],
    /payslip_line_amount/,
  ],
];

describe('reviewer flows: adversarial', () => {
  for (const [name, stmts, pattern] of adversarial) {
    it(`${name}: refused, nothing written`, async () => {
      const db = await fresh();
      await expectAbort(() => batch(db, ...stmts), pattern);
      for (const table of ['receipt', 'charge', 'receipt_allocation', 'cash_session', 'payslip']) {
        expect((await all(db, raw(`SELECT count(*) AS n FROM ${table}`)))[0]?.n, table).toBe(0);
      }
    });
  }

  it('PROBE reversal without unwinding allocations: the DB cannot see the missing rows, the view does', async () => {
    // The reversal trigger assumes its unwinds follow (ADR 0002); reverseReceipt always writes them.
    const db = await fresh();
    await batch(
      db,
      C('a', 'fee', 5000),
      R('p', 'payment', 5000),
      A('p', 'a', 5000),
      R('rv', 'reversal', -5000, 'p'),
    );
    expect(
      (await consistency(db)).map((r) => [
        r.issue,
        r.receipt_id ?? r.payer_id,
        r.expected,
        r.actual,
      ]),
    ).toEqual([
      ['negative_credit', 'F1', 0, -5000],
      ['reversal_allocations', 'rv', -5000, 0],
    ]);
  });
});

describe('payer credit never goes below zero', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = await fresh();
    await batch(db, C('a', 'fee', 5000), C('b', 'fee', 3000, null, 'S2'));
  });

  it('refund then allocate is blocked; allocating what is left is fine', async () => {
    await batch(db, R('p', 'payment', 5000), R('rf', 'refund', -2000));
    await expectAbort(() => batch(db, A('p', 'a', 3001)), /allocation exceeds payer credit/);
    await batch(db, A('p', 'a', 3000));
    expect(await credit(db)).toBe(0);
  });

  it('refund then reverse is blocked; reversing with the allocation still held is fine', async () => {
    await batch(db, R('p', 'payment', 5000), A('p', 'a', 3000), R('rf', 'refund', -2000));
    await expectAbort(
      () => batch(db, R('rv', 'reversal', -5000, 'p')),
      /reversal would leave negative payer credit/,
    );
    // A second payment is allocated in full; reversing it puts its allocation back as due.
    await batch(db, R('q', 'payment', 3000), A('q', 'b', 3000));
    await batch(db, R('rv', 'reversal', -3000, 'q'), A('rv', 'b', -3000));
    expect(await credit(db)).toBe(0);
    expect(await consistency(db)).toEqual([]);
  });
});

describe('ledger helpers', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = await fresh();
    await batch(
      db,
      C('a', 'fee', 5000),
      C('b', 'fee', 4000, null, 'S2'),
      raw(
        `INSERT INTO cash_session (id, collector_id, business_date) VALUES ('cs0', 'U1', '2026-03-05')`,
      ),
    );
  });
  const base = {
    payerType: 'family',
    payerId: 'F1',
    method: 'cash',
    collectorId: 'U1',
    businessDate: '2026-03-05',
    series: { series: 'R', year: 2026 },
    cashSessionId: 'cs0',
  } as const;

  it('createReceipt numbers from the series and allocates in one batch', async () => {
    await createReceipt(db, {
      ...base,
      id: 'p',
      idempotencyKey: 'i1',
      amount: 9000,
      allocations: [
        { id: newId(), chargeId: 'a', amount: 5000 },
        { id: newId(), chargeId: 'b', amount: 4000 },
      ],
    });
    expect(await all(db, sql`SELECT receipt_no FROM receipt`)).toEqual([
      { receipt_no: 'R-2026-00001' },
    ]);
    expect((await status(db)).map((r) => r.due)).toEqual([0, 0]);
    await expectAbort(
      () =>
        createReceipt(db, {
          ...base,
          id: 'x',
          idempotencyKey: 'i2',
          amount: 1,
          series: { series: 'Z', year: 2026 },
        }),
      // The payment-shape trigger (cash = next number of a series) fires before NOT NULL.
      /NOT NULL constraint failed: receipt.receipt_no|receipt number must be the next number/,
    );
  });

  it('a retried "apply credit" with the same allocation id is a no-op', async () => {
    await createReceipt(db, { ...base, id: 'p', idempotencyKey: 'i1', amount: 9000 });
    const apply = [{ id: newId(), chargeId: 'a', amount: 5000 }];
    await allocate(db, 'p', apply);
    await allocate(db, 'p', apply); // the response was lost; the client re-sends
    await allocate(db, 'p', [{ ...apply[0], amount: 9000 } as (typeof apply)[0]]); // same id = same allocation
    expect(
      await all(db, sql`SELECT count(*) AS n, sum(amount) AS s FROM receipt_allocation`),
    ).toEqual([{ n: 1, s: 5000 }]);
    expect(await credit(db)).toBe(4000);
    expect(await consistency(db)).toEqual([]);
  });

  it('reverseReceipt writes reversal + unwinds + re-entry + audit as one batch', async () => {
    await createReceipt(db, {
      ...base,
      id: 'p',
      idempotencyKey: 'i1',
      amount: 9500,
      allocations: [
        { id: newId(), chargeId: 'a', amount: 5000 },
        { id: newId(), chargeId: 'b', amount: 4000 },
      ],
    });
    // A later release on the pair: the unwind must mirror the live pair sum (3000), not the first row.
    await allocate(db, 'p', [{ id: newId(), chargeId: 'b', amount: -1000 }]);
    const { reversalId, reentryId } = await reverseReceipt(db, {
      receiptId: 'p',
      byUserId: 'U2',
      reason: 'wrong amount keyed',
      series: base.series,
      reenter: {
        amount: 8000,
        method: 'bank',
        accountId: 'A2',
        allocations: [
          { id: newId(), chargeId: 'a', amount: 5000 },
          { id: newId(), chargeId: 'b', amount: 3000 },
        ],
      },
    });
    expect(
      await all(
        db,
        sql`SELECT id, receipt_no, kind, amount, method, note FROM receipt ORDER BY receipt_no`,
      ),
    ).toEqual([
      {
        id: 'p',
        receipt_no: 'R-2026-00001',
        kind: 'payment',
        amount: 9500,
        method: 'cash',
        note: null,
      },
      {
        id: reversalId,
        receipt_no: 'R-2026-00002',
        kind: 'reversal',
        amount: -9500,
        method: 'cash',
        note: 'wrong amount keyed',
      },
      {
        id: reentryId,
        receipt_no: 'R-2026-00003',
        kind: 'payment',
        amount: 8000,
        method: 'bank',
        note: 're-entry for p',
      },
    ]);
    expect(
      await all(
        db,
        sql`SELECT id, charge_id, amount FROM receipt_allocation WHERE receipt_id = ${reversalId} ORDER BY charge_id`,
      ),
    ).toEqual([
      { id: `${reversalId}:a`, charge_id: 'a', amount: -5000 },
      { id: `${reversalId}:b`, charge_id: 'b', amount: -3000 },
    ]);
    expect((await status(db)).map((r) => [r.id, r.paid, r.due])).toEqual([
      ['a', 5000, 0],
      ['b', 3000, 1000],
    ]);
    expect(await credit(db)).toBe(0);
    expect(await all(db, sql`SELECT user_id, entity_id, action, diff FROM audit`)).toEqual([
      {
        user_id: 'U2',
        entity_id: 'p',
        action: 'reverse',
        diff: JSON.stringify({
          reason: 'wrong amount keyed',
          reversal_id: reversalId,
          reentry_id: reentryId,
        }),
      },
    ]);
    expect(await consistency(db)).toEqual([]);
  });

  it('reverseReceipt is all-or-nothing and refuses bad input', async () => {
    await createReceipt(db, {
      ...base,
      id: 'p',
      idempotencyKey: 'i1',
      amount: 5000,
      allocations: [{ id: newId(), chargeId: 'a', amount: 5000 }],
    });
    const input = {
      receiptId: 'p',
      byUserId: 'U2',
      reason: 'bounced',
      series: base.series,
      cashSessionId: 'cs0',
    };
    // Re-entry over-allocates: the whole batch (reversal, unwinds, series bumps, audit) rolls back.
    await expectAbort(
      () =>
        reverseReceipt(db, {
          ...input,
          reenter: { amount: 1000, allocations: [{ id: newId(), chargeId: 'a', amount: 2000 }] },
        }),
      /allocations exceed receipt amount/,
    );
    expect(await all(db, sql`SELECT count(*) AS n FROM receipt`)).toEqual([{ n: 1 }]);
    expect(await all(db, sql`SELECT next_no FROM receipt_series`)).toEqual([{ next_no: 2 }]);
    expect(await all(db, sql`SELECT count(*) AS n FROM audit`)).toEqual([{ n: 0 }]);
    await expect(reverseReceipt(db, { ...input, reason: '  ' })).rejects.toBeInstanceOf(
      LedgerError,
    );
    await expect(reverseReceipt(db, { ...input, receiptId: 'nope' })).rejects.toThrow(/not found/);
    // A refund already paid the money out: the reversal is refused (credit would go negative).
    await createReceipt(db, { ...base, id: 'q', idempotencyKey: 'i2', amount: 2000 });
    await createReceipt(db, {
      ...base,
      id: 'rf',
      idempotencyKey: 'i3',
      kind: 'refund',
      amount: -2000,
    });
    await expectAbort(
      () => reverseReceipt(db, { ...input, receiptId: 'q' }),
      /negative payer credit/,
    );
    await expect(reverseReceipt(db, { ...input, receiptId: 'rf' })).rejects.toThrow(
      /only a payment/,
    );
    // The happy path, then a second reversal of the same payment is refused.
    await reverseReceipt(db, input);
    await expectAbort(
      () => reverseReceipt(db, input),
      /UNIQUE constraint failed: receipt\.(idempotency_key|reverses_id)/,
    );
    expect(await consistency(db)).toEqual([]);
  });
});

describe('schema presence', () => {
  it('every object named in sql/*.sql exists after all migrations (a table rebuild must not drop triggers)', async () => {
    const db = createTestDb();
    const present = new Set(
      (await all(db, sql`SELECT type, name FROM sqlite_master`)).map((r) => `${r.type}:${r.name}`),
    );
    const expected = Object.values(currentSqlFiles()).flatMap((text) =>
      createdObjects(text).map((o) => `${o.kind.toLowerCase()}:${o.name}`),
    );
    expect(expected.length).toBeGreaterThan(60);
    expect(expected.filter((o) => !present.has(o))).toEqual([]);
  });

  it('the migrations folder carries the manifest outside meta/ (drizzle-kit parses meta/*.json)', () => {
    const manifest = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'custom_sql.json'), 'utf8'));
    expect(manifest.entries.length).toBeGreaterThan(0);
    expect(fileURLToPath(new URL('../migrations', import.meta.url))).toBe(MIGRATIONS_DIR);
  });
});

import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildMigration,
  currentSqlFiles,
  pendingChanges,
  readManifest,
} from '../scripts/sync-custom-sql';
import { type AppDb, atomic, rawStatement } from '../src/client';
import { createTestDb } from '../src/node';

// Regression tests for the M0 review (ADR 0002). Each `review #n` reproduces a sequence from the
// reviewer's adversarial script with valid preconditions, so the named invariant is what blocks it.

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

const run = (db: AppDb, q: SQL) => db.run(q);
const all = (db: AppDb, q: SQL) => db.all<Row>(q);
/** Several statements atomically (one D1 batch in production). */
const batch = (db: AppDb, ...qs: SQL[]) =>
  atomic(db, () => qs.map((q) => rawStatement(db, q)) as [ReturnType<typeof rawStatement>]);

const charge = (
  id: string,
  kind: string,
  amount: number,
  parent: string | null = null,
  o: { period?: string; payer?: string; reason?: string | null } = {},
) => sql`INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount,
          due_date, kind, parent_charge_id, reason)
        VALUES (${id}, 'S1', 'H1', ${o.period ?? '2026-01'}, 'family', ${o.payer ?? 'F1'}, ${amount},
          '2026-01-10', ${kind}, ${parent}, ${o.reason === undefined ? 'test' : o.reason})`;

/**
 * Raw receipt rows. Since the M3 fix pass a payment's shape is checked (sql/50_fees.sql): a cash
 * payment needs a session and its series number, a non-cash one an account. So these rows default to
 * method 'bank' into account ACC; with `session` they are cash, numbered from series N (base()).
 */
const receipt = (
  id: string,
  kind: 'payment' | 'reversal' | 'refund',
  amount: number,
  o: { reverses?: string; method?: string; payer?: string; session?: string } = {},
) => {
  const method = o.method ?? (o.session ? 'cash' : 'bank');
  const no = o.session
    ? sql`(SELECT series || '-' || year || '-' || printf('%05d', next_no - 1) FROM receipt_series WHERE series = 'N')`
    : sql`${`N-${id}`}`;
  return sql`INSERT INTO receipt (id, receipt_no, kind, reverses_id, payer_type, payer_id, amount, method,
          account_id, collector_id, cash_session_id, business_date, idempotency_key)
        VALUES (${id}, ${no}, ${kind}, ${o.reverses ?? null}, 'family', ${o.payer ?? 'F1'},
          ${amount}, ${method}, ${method === 'cash' ? null : 'ACC'}, 'U1', ${o.session ?? null}, '2026-01-05', ${`k-${id}`})`;
};

const alloc = (r: string, c: string, amount: number, id = newId()) =>
  sql`INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES (${id}, ${r}, ${c}, ${amount})`;

const net = async (db: AppDb, id: string) =>
  (await all(db, sql`SELECT net, paid, due FROM charge_status WHERE id = ${id}`))[0];
const credit = async (db: AppDb, payer = 'F1') =>
  (await all(db, sql`SELECT credit FROM payer_credit WHERE payer_id = ${payer}`))[0]?.credit ?? 0;

async function base(db: AppDb) {
  await run(db, sql`INSERT INTO user (id, email) VALUES ('U1', 'a@x.pk'), ('U2', 'b@x.pk')`);
  await run(db, sql`INSERT INTO account (id, name, kind) VALUES ('ACC', 'Bank', 'bank')`);
  await run(db, sql`INSERT INTO receipt_series (series, year, next_no) VALUES ('N', 2026, 1)`);
  await run(db, sql`INSERT INTO family (id, name) VALUES ('F1', 'Khan'), ('F2', 'Ahmed')`);
  await run(
    db,
    sql`INSERT INTO student (id, family_id, admission_no, name, admission_date)
        VALUES ('S1', 'F1', '1', 'Ali', '2026-01-01')`,
  );
  await run(
    db,
    sql`INSERT INTO fee_head (id, name, kind, cadence) VALUES ('H1', 'Tuition', 'tuition', 'monthly')`,
  );
  await run(db, charge('cA', 'fee', 300000, null, { period: '2026-01' }));
  await run(db, charge('cB', 'fee', 100000, null, { period: '2026-02' }));
  await run(db, receipt('r1', 'payment', 100000));
}

describe('allocation signs per (receipt, charge) pair', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await base(db);
  });

  it('review #1: a receipt cannot allocate more than its amount across charges', async () => {
    await expectAbort(
      () => batch(db, alloc('r1', 'cA', 200000), alloc('r1', 'cB', -100000)),
      /allocations exceed receipt amount/,
    );
  });

  it('review #1b: a negative row on a pair that holds nothing is refused (no inflating)', async () => {
    await expectAbort(
      () => batch(db, alloc('r1', 'cB', -100000), alloc('r1', 'cA', 200000)),
      /release exceeds what this receipt allocated/,
    );
    expect(await net(db, 'cA')).toMatchObject({ paid: 0 });
  });

  it('a release can take a pair back to zero but not below', async () => {
    await batch(db, alloc('r1', 'cA', 60000));
    await batch(db, alloc('r1', 'cA', -60000));
    await expectAbort(() => batch(db, alloc('r1', 'cA', -1)), /release exceeds/);
    expect(await credit(db)).toBe(100000);
  });

  it('zero and fractional allocations are refused', async () => {
    await expectAbort(() => batch(db, alloc('r1', 'cA', 0)), /receipt_allocation_nonzero/);
    await expectAbort(() => batch(db, alloc('r1', 'cA', 10.5)), /receipt_allocation_amount_int/);
  });

  it("allocations must match the charge's payer", async () => {
    await run(db, receipt('rF2', 'payment', 50000, { payer: 'F2' }));
    await expectAbort(() => batch(db, alloc('rF2', 'cA', 50000)), /payer must match/);
  });

  it('review #4 / invariant 4: concession after full payment needs a release; credit = release', async () => {
    await batch(db, alloc('r1', 'cB', 100000));
    // Without the release the concession would push net (10,000) below paid (100,000).
    await expectAbort(
      () => batch(db, charge('cc', 'concession', -90000, 'cB', { period: '2026-02' })),
      /net would fall below allocated; release the allocation first/,
    );
    expect(await credit(db)).toBe(0);
    // Release first, then the concession, in one batch.
    await batch(
      db,
      alloc('r1', 'cB', -90000),
      charge('cc', 'concession', -90000, 'cB', { period: '2026-02' }),
    );
    expect(await net(db, 'cB')).toEqual({ net: 10000, paid: 10000, due: 0 });
    expect(await credit(db)).toBe(90000);
  });
});

describe('reversals', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await base(db);
    await run(db, receipt('r2', 'payment', 100000));
    await batch(db, alloc('r2', 'cB', 100000));
  });

  it('review #5: a reversal cannot allocate to a charge the original never paid', async () => {
    await expectAbort(
      () =>
        batch(
          db,
          receipt('rv', 'reversal', -100000, { reverses: 'r2' }),
          alloc('rv', 'cA', -100000),
        ),
      /reversal can only unwind what the original allocated/,
    );
  });

  it('a reversal unwinds at most the original pair sum, and never positively', async () => {
    await expectAbort(
      () =>
        batch(
          db,
          receipt('rv', 'reversal', -100000, { reverses: 'r2' }),
          alloc('rv', 'cB', -60000),
          alloc('rv', 'cB', -60000),
        ),
      /reversal can only unwind/,
    );
    await expectAbort(
      () => batch(db, receipt('rv', 'reversal', -100000, { reverses: 'r2' }), alloc('rv', 'cB', 5)),
      /reversal can only unwind/,
    );
    await batch(
      db,
      receipt('rv', 'reversal', -100000, { reverses: 'r2' }),
      alloc('rv', 'cB', -100000),
    );
    expect(await net(db, 'cB')).toMatchObject({ paid: 0, due: 100000 });
    // r1 (100,000, unallocated) is the only credit left.
    expect(await credit(db)).toBe(100000);
  });

  it('a reversed payment takes no further allocations or releases', async () => {
    await batch(
      db,
      receipt('rv', 'reversal', -100000, { reverses: 'r2' }),
      alloc('rv', 'cB', -100000),
    );
    await expectAbort(() => batch(db, alloc('r2', 'cB', -1)), /receipt has been reversed/);
    await expectAbort(() => batch(db, alloc('r2', 'cA', 1)), /receipt has been reversed/);
  });

  it('review #18: a reversal of a reversal is refused', async () => {
    await batch(db, receipt('rv', 'reversal', -100000, { reverses: 'r2' }));
    await expectAbort(
      () => batch(db, receipt('rvv', 'reversal', -100000, { reverses: 'rv' })),
      /reversal must mirror a payment exactly/,
    );
  });

  it('review #19: amount, payer and method must mirror the original exactly', async () => {
    for (const bad of [
      receipt('rv', 'reversal', -99999999, { reverses: 'r1' }),
      receipt('rv', 'reversal', -50000, { reverses: 'r1' }),
      receipt('rv', 'reversal', -100000, { reverses: 'r1', method: 'cash' }),
      receipt('rv', 'reversal', -100000, { reverses: 'r1', payer: 'F2' }),
    ]) {
      await expectAbort(() => batch(db, bad), /reversal must mirror a payment exactly/);
    }
  });
});

describe('refunds', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await base(db);
    await batch(db, alloc('r1', 'cA', 70000)); // credit 30,000
  });

  it('review #15: a refund takes no allocations', async () => {
    await expectAbort(
      () => batch(db, receipt('rf', 'refund', -100), alloc('rf', 'cA', -100)),
      /a refund takes no allocations/,
    );
  });

  it('a refund is a negative receipt within unallocated credit', async () => {
    await expectAbort(() => batch(db, receipt('rf', 'refund', 100)), /receipt_kind_shape/);
    await expectAbort(
      () => batch(db, receipt('rf', 'refund', -30001)),
      /refund exceeds unallocated credit/,
    );
    await batch(db, receipt('rf', 'refund', -30000));
    expect(await credit(db)).toBe(0);
    await expectAbort(() => batch(db, receipt('rf2', 'refund', -1)), /refund exceeds/);
  });
});

describe('charge kinds and the tree', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await base(db);
  });

  it('review #2 / #3: fees and fines are positive; concessions, waivers and reversals negative', async () => {
    await expectAbort(
      () => run(db, charge('cN', 'fee', -500000, null, { period: '2026-03' })),
      /charge_kind_sign/,
    );
    await expectAbort(() => run(db, charge('cc', 'concession', 50000, 'cB')), /charge_kind_sign/);
    await expectAbort(() => run(db, charge('f', 'fine', -100, 'cA')), /charge_kind_sign/);
  });

  it('review #14: a fine must hang off a fee; root fines are refused', async () => {
    await expectAbort(() => run(db, charge('fx', 'fine', 100)), /charge_root_kind/);
    await expectAbort(() => run(db, charge('cc', 'concession', -100)), /charge_root_kind/);
    await run(db, charge('f1', 'fine', 5000, 'cA'));
    await expectAbort(
      () => run(db, charge('f2', 'fine', 5000, 'cA')),
      /UNIQUE constraint failed: charge.parent_charge_id/,
    );
  });

  it('fine_waiver hangs off a fine and never waives more than the fine', async () => {
    await run(db, charge('f1', 'fine', 5000, 'cA'));
    await expectAbort(() => run(db, charge('w0', 'fine_waiver', -100, 'cA')), /invalid parent/);
    await expectAbort(
      () => run(db, charge('w1', 'fine_waiver', -5001, 'f1')),
      /line exceeds remaining net/,
    );
    await run(db, charge('w1', 'fine_waiver', -3000, 'f1'));
    await expectAbort(
      () => run(db, charge('w2', 'fine_waiver', -2001, 'f1')),
      /line exceeds remaining net/,
    );
    expect(await net(db, 'cA')).toMatchObject({ net: 302000 });
  });

  it('a reversal line targets a fee or fine, within its remaining net, with a reason', async () => {
    await expectAbort(
      () => run(db, charge('x1', 'reversal', -100, 'cA', { reason: null })),
      /charge_reason/,
    );
    await expectAbort(
      () => run(db, charge('x1', 'reversal', -100, 'cA', { reason: '  ' })),
      /charge_reason/,
    );
    await expectAbort(
      () => run(db, charge('x1', 'reversal', -300001, 'cA')),
      /line exceeds remaining net/,
    );
    await run(db, charge('cc', 'concession', -1000, 'cA'));
    await expectAbort(() => run(db, charge('x2', 'reversal', -100, 'cc')), /invalid parent/);
    await run(db, charge('x1', 'reversal', -299000, 'cA'));
    expect(await net(db, 'cA')).toMatchObject({ net: 0, due: 0 });
  });

  it('a child line must belong to the same payer as its parent', async () => {
    await expectAbort(
      () => run(db, charge('cc', 'concession', -100, 'cA', { payer: 'F2' })),
      /invalid parent/,
    );
  });

  it('review #17: money is integer paisa in every money column', async () => {
    await expectAbort(
      () => run(db, charge('cR', 'fee', 12.5, null, { period: '2026-05' })),
      /charge_amount_int/,
    );
    await expectAbort(() => run(db, receipt('rR', 'payment', 0.5)), /receipt_amount_int/);
    await expectAbort(
      () =>
        run(
          db,
          sql`INSERT INTO opening_balance (student_id, amount, as_of) VALUES ('S1', 1.25, '2026-01-01')`,
        ),
      /opening_balance_amount_int/,
    );
    await expectAbort(
      () =>
        run(
          db,
          sql`INSERT INTO cash_session (id, collector_id, business_date, opening) VALUES ('cs', 'U1', 'd', 0.1)`,
        ),
      /cash_session_opening_int/,
    );
  });
});

describe('cash session is close-only', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await base(db);
    await run(
      db,
      sql`INSERT INTO cash_session (id, collector_id, business_date) VALUES ('cs', 'U1', '2026-01-05')`,
    );
    await run(
      db,
      sql`INSERT INTO account (id, name, kind) VALUES ('a', 'Drawer', 'cash'), ('b', 'Bank', 'bank')`,
    );
    await run(db, sql`INSERT INTO expense_category (id, name) VALUES ('ec', 'Chalk')`);
  });
  const close = sql`UPDATE cash_session SET expected = 5000, counted = 4800, closed_at = 't', closed_by = 'U1' WHERE id = 'cs'`;

  it('variance is derived; closing needs counted, expected and closer', async () => {
    await expectAbort(
      () => run(db, sql`UPDATE cash_session SET closed_at = 't' WHERE id = 'cs'`),
      /cash_session_closed_shape/,
    );
    await run(db, close);
    expect((await all(db, sql`SELECT variance FROM cash_session`))[0]).toEqual({ variance: -200 });
  });

  it('review #8: a closed session cannot be edited', async () => {
    await run(db, close);
    await expectAbort(
      () => run(db, sql`UPDATE cash_session SET counted = 999 WHERE id = 'cs'`),
      /cash_session is closed/,
    );
    await expectAbort(
      () => run(db, sql`UPDATE cash_session SET variance = 0 WHERE id = 'cs'`),
      /generated column/,
    );
    await expectAbort(
      () => run(db, sql`UPDATE cash_session SET closed_at = NULL WHERE id = 'cs'`),
      /only a reopen with reason/,
    );
    await expectAbort(
      () =>
        run(
          db,
          sql`UPDATE cash_session SET closed_at = NULL, reopened_by = 'U2', reopened_at = 't2',
              reopen_reason = 'miscount', counted = 5000 WHERE id = 'cs'`,
        ),
      /only a reopen with reason/,
    );
    await run(
      db,
      sql`UPDATE cash_session SET closed_at = NULL, reopened_by = 'U2', reopened_at = 't2',
          reopen_reason = 'miscount' WHERE id = 'cs'`,
    );
    await run(db, sql`UPDATE cash_session SET counted = 5000 WHERE id = 'cs'`);
  });

  it('review #9: a closed session takes no receipts, expenses or transfers', async () => {
    await run(db, close);
    await expectAbort(
      () => run(db, receipt('r9', 'payment', 100, { session: 'cs' })),
      /cash session is closed/,
    );
    await expectAbort(
      () =>
        run(
          db,
          sql`INSERT INTO expense (id, expense_no, category_id, account_id, cash_session_id, amount, date)
              VALUES ('e', 'E1', 'ec', 'a', 'cs', 5, 'd')`,
        ),
      /cash session is closed/,
    );
    await expectAbort(
      () =>
        run(
          db,
          sql`INSERT INTO transfer (id, from_account, to_account, cash_session_id, amount, date)
              VALUES ('t', 'a', 'b', 'cs', 5, 'd')`,
        ),
      /cash session is closed/,
    );
  });

  it('review #10 / #10b: a void needs a reason and cannot be undone', async () => {
    await run(
      db,
      sql`INSERT INTO expense (id, expense_no, category_id, account_id, amount, date) VALUES ('e', 'E1', 'ec', 'a', 5, 'd')`,
    );
    await expectAbort(
      () => run(db, sql`UPDATE expense SET voided_by = 'U1' WHERE id = 'e'`),
      /expense_void_reason/,
    );
    await run(
      db,
      sql`UPDATE expense SET voided_by = 'U1', void_reason = 'duplicate' WHERE id = 'e'`,
    );
    await expectAbort(
      () => run(db, sql`UPDATE expense SET voided_by = NULL, void_reason = NULL WHERE id = 'e'`),
      /already voided/,
    );
  });
});

describe('payslip maker-checker', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await base(db);
    await run(db, sql`INSERT INTO staff (id, name) VALUES ('st', 'S')`);
    await run(db, sql`INSERT INTO account (id, name, kind) VALUES ('a', 'Drawer', 'cash')`);
    await run(
      db,
      sql`INSERT INTO payslip (id, staff_id, period_key) VALUES ('p1', 'st', '2026-01')`,
    );
    await run(
      db,
      sql`INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('pl', 'p1', 'basic', 100)`,
    );
  });
  const pay = sql`INSERT INTO salary_payment (id, payslip_id, amount, account_id, date) VALUES ('sp', 'p1', 100, 'a', 'd')`;

  it('review #6: lines freeze once approved; a slip cannot be born approved or paid', async () => {
    await expectAbort(
      () =>
        run(
          db,
          sql`INSERT INTO payslip (id, staff_id, period_key, status) VALUES ('p2', 'st', '2026-02', 'paid')`,
        ),
      /payslip must start as draft/,
    );
    await run(db, sql`UPDATE payslip_line SET amount = 200 WHERE id = 'pl'`); // draft: editable
    await run(db, sql`UPDATE payslip SET status = 'approved', approved_by = 'U1' WHERE id = 'p1'`);
    await expectAbort(
      () => run(db, sql`UPDATE payslip_line SET amount = 999999 WHERE id = 'pl'`),
      /lines are frozen/,
    );
    await expectAbort(() => run(db, sql`DELETE FROM payslip_line`), /lines are frozen/);
    await expectAbort(
      () =>
        run(
          db,
          sql`INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('pl2', 'p1', 'allowance', 5)`,
        ),
      /lines are frozen/,
    );
  });

  it('review #7: status only moves draft -> approved -> paid; payment needs approval', async () => {
    await expectAbort(() => run(db, pay), /payslip is not approved/);
    await expectAbort(
      () => run(db, sql`UPDATE payslip SET status = 'paid', approved_by = 'U1' WHERE id = 'p1'`),
      /only moves draft -> approved -> paid/,
    );
    await expectAbort(
      () => run(db, sql`UPDATE payslip SET status = 'approved' WHERE id = 'p1'`),
      /payslip_approved_by/,
    );
    await run(db, sql`UPDATE payslip SET status = 'approved', approved_by = 'U1' WHERE id = 'p1'`);
    await run(db, pay);
    await run(db, sql`UPDATE payslip SET status = 'paid' WHERE id = 'p1'`);
    for (const back of ['draft', 'approved']) {
      await expectAbort(
        () => run(db, sql`UPDATE payslip SET status = ${back} WHERE id = 'p1'`),
        /only moves draft -> approved -> paid/,
      );
    }
    await expectAbort(
      () => run(db, sql`UPDATE payslip SET approved_by = 'U2' WHERE id = 'p1'`),
      /approver is fixed/,
    );
  });
});

describe('history tables and pointers', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await base(db);
    await run(db, sql`INSERT INTO programme (id, name, kind) VALUES ('P', 'Class 5', 'grade')`);
    await run(db, sql`INSERT INTO grp (id, programme_id, name) VALUES ('G', 'P', '5-A')`);
    await run(
      db,
      sql`INSERT INTO att_register (id, client_id, grp_id, date, taken_by, taken_at, batch_token) VALUES
          ('R1', 'c1', 'G', '2026-01-05', 'U1', '2026-01-05T08:00:00Z', 'b1'),
          ('R2', 'c2', 'G', '2026-01-05', 'U1', '2026-01-05T09:00:00Z', 'b2')`,
    );
    await run(
      db,
      sql`INSERT INTO att_mark (register_id, student_id, status) VALUES ('R1', 'S1', 'P')`,
    );
    await run(
      db,
      sql`INSERT INTO current_register (grp_id, date, register_id, taken_at) VALUES ('G', '2026-01-05', 'R2', '2026-01-05T09:00:00Z')`,
    );
    await run(
      db,
      sql`INSERT INTO audit (id, entity, entity_id, action) VALUES ('A1', 'x', 'y', 'z')`,
    );
  });

  it('review #20: the current_register pointer only moves forward in client time', async () => {
    await expectAbort(
      () =>
        run(
          db,
          sql`UPDATE current_register SET register_id = 'R1', taken_at = '2026-01-05T08:00:00Z'`,
        ),
      /only moves forward/,
    );
    await expectAbort(
      () => run(db, sql`UPDATE current_register SET register_id = 'R1'`),
      /only moves forward/,
    );
    await run(
      db,
      sql`UPDATE current_register SET register_id = 'R1', taken_at = '2026-01-05T10:00:00Z'`,
    );
    await expectAbort(() => run(db, sql`DELETE FROM current_register`), /cannot be deleted/);
  });

  it('audit, att_register and att_mark are append-only', async () => {
    for (const [stmt, msg] of [
      [sql`UPDATE audit SET action = 'x'`, /audit is append-only/],
      [sql`DELETE FROM audit`, /audit is append-only/],
      [sql`UPDATE att_register SET taken_at = 'x'`, /att_register is append-only/],
      [sql`DELETE FROM att_register WHERE id = 'R2'`, /att_register is append-only/],
      [sql`UPDATE att_mark SET status = 'A'`, /att_mark is append-only/],
      [sql`DELETE FROM att_mark`, /att_mark is append-only/],
    ] as const) {
      await expectAbort(() => run(db, stmt), msg);
    }
  });

  it('review #11: receipt_series only advances by one', async () => {
    await run(db, sql`INSERT INTO receipt_series (series, year, next_no) VALUES ('A', 2026, 5)`);
    await expectAbort(
      () => run(db, sql`UPDATE receipt_series SET next_no = 1`),
      /only advances by one/,
    );
    await expectAbort(
      () => run(db, sql`UPDATE receipt_series SET next_no = next_no + 2`),
      /only advances by one/,
    );
    await run(db, sql`UPDATE receipt_series SET next_no = next_no + 1`);
    await expectAbort(() => run(db, sql`DELETE FROM receipt_series`), /cannot be deleted/);
  });
});

describe('custom SQL migrations (append-only policy)', () => {
  it('a changed sql/ file becomes a new migration that drops and recreates its objects', async () => {
    const manifest = readManifest();
    const files = currentSqlFiles();
    expect(pendingChanges(manifest, files)).toEqual({ changed: [], deleted: [] });
    const edited = {
      ...files,
      '30_ledger.sql': files['30_ledger.sql']?.replace(
        /CREATE TRIGGER alloc_shape[\s\S]*?END;\n--> statement-breakpoint\n/,
        '',
      ),
    } as Record<string, string>;
    const pending = pendingChanges(manifest, edited);
    expect(pending).toEqual({ changed: ['30_ledger.sql'], deleted: [] });
    const body = buildMigration(pending, manifest, edited);
    // The removed trigger is dropped even though the new file no longer mentions it.
    expect(body).toContain('DROP TRIGGER IF EXISTS alloc_shape;');
    expect(body).not.toContain('CREATE TRIGGER alloc_shape');

    // Applying it on top of the current schema succeeds and really removes the trigger.
    const db = createTestDb();
    for (const stmt of body.split('--> statement-breakpoint')) {
      if (stmt.replace(/--.*$/gm, '').trim()) await db.run(sql.raw(stmt));
    }
    const names = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'alloc_%' ORDER BY name`,
    );
    expect(names.map((r) => r.name)).toEqual(['alloc_no_delete', 'alloc_no_update', 'alloc_sums']);
  });
});

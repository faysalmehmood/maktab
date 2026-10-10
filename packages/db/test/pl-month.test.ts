import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import {
  accountBalances,
  approvePayslip,
  cashbook,
  closeSession,
  collect,
  ensureSeries,
  ensureSessionStatement,
  generatePayslips,
  incomeExpense,
  openSession,
  paySalary,
  recordAdvance,
  recordExpense,
  recordOpeningBalance,
  recordTransfer,
  refund,
  reverseReceipt,
  seriesFor,
  sessionFor,
  sessionIdFor,
  setPayslipLines,
  voidExpense,
} from '../src/ledger';
import { createTestDb } from '../src/node';

/**
 * The M4 review's month walk-through (scratchpad review-m4/pl.mts), kept as a permanent test: one
 * October with every kind of money in and out, and the exact figures the reviewer worked out by hand.
 *
 *   In:  bank 4,000 (Butt) + cash 5,000 + 4,000 + 1,500 (Khan) − 1,500 reversal − 1,000 refund = 12,000
 *        by head: Tuition 10,000, Transport 1,000, unallocated credit 1,000
 *   Out: expenses 700 (drawer) + 10,000 rent (bank) = 10,700 (a voided 400 is not counted)
 *        salaries (pay = earnings − deductions): Teacher 32,000 − 1,000 = 31,000, Cleaner 15,000,
 *        Owner 80,000 = 126,000 (3 slips)
 *   Net: 12,000 − 10,700 − 126,000 = −124,700
 *   Reconciliation: salary paid 10,000 + 18,000 + 15,000 + 80,000 = 123,000, advances 3,000;
 *        12,000 − 10,700 − 123,000 − 3,000 = −124,700 = Σ account movements (the 3,000 transfer nets out)
 *   Drawers: accountant 20,000 float + 10,500 cash in − 3,000 handover − 700 − 3,000 advance − 10,000
 *        salary = 13,800 expected (counted 11,700 → −2,100); admin 5,000 − 1,500 − 1,000 = 2,500
 *   Accounts: Drawers −8,700 (floats are not movements), Bank −116,000
 * The accountant's view (no owner pay, F1): salaries 46,000 over 2 slips, net −44,700; the cashbook
 * shows the owner's 80,000 bank salary as an unnamed `owner_draw`.
 */

const RS = (n: number) => n * 100;
const T = '2026-10-05';
const run = (db: AppDb, ...qs: string[]) =>
  atomic(
    db,
    () => qs.map((q) => rawStatement(db, sql.raw(q))) as [ReturnType<typeof rawStatement>],
  );
const all = <R = Record<string, unknown>>(db: AppDb, q: SQL) => db.all<R>(q);

let db: AppDb;
const out: {
  drawerU2?: { expected: number | null; variance: number | null };
  drawerA?: { expected: number | null; variance: number | null };
  teacherStatus?: string;
} = {};

beforeAll(async () => {
  db = createTestDb();
  await run(
    db,
    `INSERT INTO "user" (id, email, name, status) VALUES ('O','o@x.pk','Owner','active'),('A','a@x.pk','Admin','active'),('U2','acct@x.pk','Accountant','active'),('T','t@x.pk','Teacher','active')`,
    `INSERT INTO role (user_id, role) VALUES ('O','owner'),('A','admin'),('U2','accountant'),('T','teacher')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at) VALUES ('SCH','Test','R','2026-04-01')`,
    `INSERT INTO staff (id, user_id, name, base_salary, allowances) VALUES ('ST_T','T','Teacher T',${RS(30000)},'[{"label":"Transport","amount":${RS(2000)}}]'),('ST_O','O','Owner O',${RS(80000)},NULL),('ST_X',NULL,'Cleaner',${RS(15000)},NULL)`,
    `INSERT INTO account (id, name, kind) VALUES ('CASH','Drawers','cash'),('BANK','Bank','bank')`,
    `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI','Tuition','tuition','monthly'),('TRN','Transport','misc','monthly')`,
    `INSERT INTO family (id, name) VALUES ('F1','Khan'),('F2','Butt')`,
    `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S1','F1','2026-0001','Ali','2026-04-01'),('S2','F2','2026-0002','Sara','2026-04-01')`,
    `INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind) VALUES
     ('C9','S1','TUI','2026-09','family','F1',${RS(3000)},'2026-09-10','fee'),
     ('C10','S1','TUI','2026-10','family','F1',${RS(3000)},'2026-10-10','fee'),
     ('C10T','S1','TRN','2026-10','family','F1',${RS(1000)},'2026-10-10','fee'),
     ('D10','S2','TUI','2026-10','family','F2',${RS(4000)},'2026-10-10','fee')`,
  );
  await openSession(db, { collectorId: 'U2', businessDate: T, opening: RS(20000) });
  await openSession(db, { collectorId: 'A', businessDate: T, opening: RS(5000) });
  await recordOpeningBalance(db, {
    studentId: 'S2',
    amount: -RS(500),
    asOf: '2026-10-01',
    by: 'A',
  });
  const col = (payer: string, amount: number, method: 'cash' | 'bank', date: string) =>
    collect(db, {
      payerType: 'family',
      payerId: payer,
      amount,
      method,
      accountId: method === 'bank' ? 'BANK' : null,
      businessDate: date,
      today: date,
      collectorId: 'U2',
      idempotencyKey: newId(),
    });
  await col('F2', RS(4000), 'bank', '2026-10-03');
  await col('F1', RS(5000), 'cash', T);
  await col('F1', RS(4000), 'cash', T); // over-payment → credit
  const c3 = await col('F1', RS(1500), 'cash', T);
  await reverseReceipt(db, {
    receiptId: c3.receipt_id,
    byUserId: 'A',
    reason: 'wrong',
    series: seriesFor('R', T),
    businessDate: T,
    prelude: [ensureSeries(seriesFor('R', T)), ensureSessionStatement('A', T)],
    cashSessionId: sessionIdFor('A', T),
  });
  await refund(db, {
    payerType: 'family',
    payerId: 'F1',
    amount: RS(1000),
    method: 'cash',
    reason: 'over',
    by: 'A',
    businessDate: T,
    idempotencyKey: newId(),
    today: T,
  });
  await recordTransfer(db, {
    fromAccount: 'CASH',
    toAccount: 'BANK',
    amount: RS(3000),
    date: T,
    by: 'U2',
  });
  const cat = async (c: string) =>
    (await all<{ id: string }>(db, sql`SELECT id FROM expense_category WHERE code = ${c}`))[0]
      ?.id ?? '';
  await recordExpense(db, {
    categoryId: await cat('stationery'),
    amount: RS(700),
    accountId: 'CASH',
    by: 'U2',
    today: T,
  });
  await recordExpense(db, {
    categoryId: await cat('rent'),
    amount: RS(10000),
    accountId: 'BANK',
    date: '2026-10-02',
    by: 'U2',
    today: T,
  });
  const v = await recordExpense(db, {
    categoryId: await cat('misc'),
    amount: RS(400),
    accountId: 'CASH',
    by: 'U2',
    today: T,
  });
  await voidExpense(db, { id: v.id, reason: 'dup', by: 'A' });
  await recordAdvance(db, {
    staffId: 'ST_T',
    amount: RS(3000),
    accountId: 'CASH',
    by: 'U2',
    today: T,
  });
  expect(await generatePayslips(db, { periodKey: '2026-10', by: 'U2' })).toEqual({
    created: 3,
    skipped: 0,
    next: null,
  });
  const slips = await all<{ id: string; staff_id: string }>(
    db,
    sql`SELECT id, staff_id FROM payslip`,
  );
  const sid = (s: string) => slips.find((x) => x.staff_id === s)?.id ?? '';
  const tl = await all<{ kind: 'basic'; amount: number; note: string | null }>(
    db,
    sql`SELECT kind, amount, note FROM payslip_line WHERE payslip_id = ${sid('ST_T')} ORDER BY kind`,
  );
  // Default lines: basic 30,000, transport 2,000, recovery 3,000 (min(advance, 25% of the net)).
  expect(tl.map((l) => [l.kind, l.amount / 100, l.note])).toEqual([
    ['advance_recovery', 3000, null],
    ['allowance', 2000, 'Transport'],
    ['basic', 30000, null],
  ]);
  await setPayslipLines(db, {
    id: sid('ST_T'),
    by: 'U2',
    lines: [...tl, { kind: 'deduction', amount: RS(1000), note: 'absent' }] as never,
  });
  await approvePayslip(db, { id: sid('ST_T'), by: 'O' });
  await approvePayslip(db, { id: sid('ST_X'), by: 'O' });
  await approvePayslip(db, { id: sid('ST_O'), by: 'A' });
  const pay = (s: string, amount: number, accountId: string, by = 'U2') =>
    paySalary(db, { payslipId: sid(s), amount, accountId, by, today: T });
  await pay('ST_T', RS(10000), 'CASH');
  out.teacherStatus = (await pay('ST_T', RS(18000), 'BANK')).status;
  await pay('ST_X', RS(15000), 'BANK');
  await pay('ST_O', RS(80000), 'BANK', 'A');
  const s = await sessionFor(db, 'U2', T);
  const closed = await closeSession(db, { sessionId: s?.id ?? '', counted: RS(11700), by: 'U2' });
  out.drawerU2 = { expected: closed.expected, variance: closed.variance };
  const sA = await sessionFor(db, 'A', T);
  const closedA = await closeSession(db, { sessionId: sA?.id ?? '', counted: RS(2500), by: 'A' });
  out.drawerA = { expected: closedA.expected, variance: closedA.variance };
});

const rs = (paisa: number | null | undefined) => (paisa ?? Number.NaN) / 100;

describe('one month, by hand (M4 review walk-through)', () => {
  it('income vs expense: the exact figures', async () => {
    const ie = await incomeExpense(db, { from: '2026-10', to: '2026-10' });
    expect(rs(ie.income.total)).toBe(12000);
    expect(ie.income.by_head.map((h) => [h.fee_head_id, rs(h.amount)])).toEqual([
      ['TUI', 10000],
      ['TRN', 1000],
    ]);
    expect(rs(ie.income.unallocated)).toBe(1000);
    expect(rs(ie.expenses.total)).toBe(10700);
    expect(
      ie.expenses.by_category.map((c) => [c.code, rs(c.amount)]).sort((a, b) => (a < b ? -1 : 1)),
    ).toEqual([
      ['rent', 10000],
      ['stationery', 700],
    ]);
    expect(ie.salaries).toEqual({ pay: RS(126000), slips: 3, scope: 'all' });
    expect(rs(ie.net)).toBe(-124700);
    expect(ie.months).toEqual([
      {
        period: '2026-10',
        income: RS(12000),
        expenses: RS(10700),
        salaries: RS(126000),
        net: -RS(124700),
      },
    ]);
    expect(ie.reconciliation).toEqual({
      income: RS(12000),
      expenses: RS(10700),
      salary_paid: RS(123000),
      advances_paid: RS(3000),
      expected_movement: -RS(124700),
      movement: -RS(124700),
      ties: true,
    });
  });

  it('drawers close at the hand-worked expected cash', () => {
    expect(out.drawerU2).toEqual({ expected: RS(13800), variance: -RS(2100) });
    expect(out.drawerA).toEqual({ expected: RS(2500), variance: 0 });
  });

  it('receipts, allocations, credit, slips and advances', async () => {
    const receipts = await all(
      db,
      sql`SELECT receipt_no, kind, method, amount / 100 AS rs, collector_id,
            cash_session_id IS NOT NULL AS sess, account_id FROM receipt ORDER BY receipt_no`,
    );
    expect(
      receipts.map((r) => [
        r.receipt_no,
        r.kind,
        r.method,
        r.rs,
        r.collector_id,
        r.sess,
        r.account_id,
      ]),
    ).toEqual([
      ['OB-2026-0002', 'opening', 'cash', 500, 'A', 0, null],
      ['R-2026-00001', 'payment', 'bank', 4000, 'U2', 0, 'BANK'],
      ['R-2026-00002', 'payment', 'cash', 5000, 'U2', 1, 'CASH'],
      ['R-2026-00003', 'payment', 'cash', 4000, 'U2', 1, 'CASH'],
      ['R-2026-00004', 'payment', 'cash', 1500, 'U2', 1, 'CASH'],
      ['R-2026-00005', 'reversal', 'cash', -1500, 'A', 1, 'CASH'],
      ['R-2026-00006', 'refund', 'cash', -1000, 'A', 1, 'CASH'],
    ]);
    const allocs = await all(
      db,
      sql`SELECT r.receipt_no, a.charge_id, a.amount / 100 AS rs FROM receipt_allocation a
          JOIN receipt r ON r.id = a.receipt_id ORDER BY r.receipt_no, a.charge_id`,
    );
    expect(allocs.map((a) => [a.receipt_no, a.charge_id, a.rs])).toEqual([
      ['R-2026-00001', 'D10', 4000],
      ['R-2026-00002', 'C10', 1000],
      ['R-2026-00002', 'C10T', 1000],
      ['R-2026-00002', 'C9', 3000],
      ['R-2026-00003', 'C10', 2000],
    ]);
    expect(
      await all(db, sql`SELECT payer_id, credit / 100 AS rs FROM payer_credit ORDER BY payer_id`),
    ).toEqual([
      { payer_id: 'F1', rs: 1000 },
      { payer_id: 'F2', rs: 500 },
    ]);
    const slips = await all(
      db,
      sql`SELECT staff_id, status, earnings / 100 AS e, deductions / 100 AS d, recovery / 100 AS r,
            pay / 100 AS pay, net / 100 AS net, paid / 100 AS paid FROM payslip_net ORDER BY staff_id`,
    );
    expect(slips).toEqual([
      {
        staff_id: 'ST_O',
        status: 'paid',
        e: 80000,
        d: 0,
        r: 0,
        pay: 80000,
        net: 80000,
        paid: 80000,
      },
      {
        staff_id: 'ST_T',
        status: 'paid',
        e: 32000,
        d: 1000,
        r: 3000,
        pay: 31000,
        net: 28000,
        paid: 28000,
      },
      {
        staff_id: 'ST_X',
        status: 'paid',
        e: 15000,
        d: 0,
        r: 0,
        pay: 15000,
        net: 15000,
        paid: 15000,
      },
    ]);
    expect(out.teacherStatus).toBe('paid');
    expect(
      await all(
        db,
        sql`SELECT staff_id, advanced / 100 AS a, recovered / 100 AS r, outstanding / 100 AS o
            FROM advance_balance ORDER BY staff_id`,
      ),
    ).toEqual([
      { staff_id: 'ST_O', a: 0, r: 0, o: 0 },
      { staff_id: 'ST_T', a: 3000, r: 3000, o: 0 },
      { staff_id: 'ST_X', a: 0, r: 0, o: 0 },
    ]);
  });

  it('account balances and both cashbooks', async () => {
    expect((await accountBalances(db)).map((b) => [b.account_id, rs(b.balance)])).toEqual([
      ['BANK', -116000],
      ['CASH', -8700],
    ]);
    const cb = await cashbook(db, { accountId: 'CASH', from: '2026-10-01', to: '2026-10-31' });
    expect([cb.opening, rs(cb.in), rs(cb.out), rs(cb.closing)]).toEqual([0, 10500, 19200, -8700]);
    expect(cb.rows.map((r) => `${r.kind}:${rs(r.amount)}:${r.party}`).sort()).toEqual(
      [
        'receipt:5000:Khan',
        'receipt:4000:Khan',
        'receipt:1500:Khan',
        'receipt:-1500:Khan',
        'receipt:-1000:Khan',
        'transfer_out:-3000:Bank',
        'expense:-700:Stationery',
        'advance:-3000:Teacher T',
        'salary:-10000:Teacher T',
      ].sort(),
    );
    const bank = await cashbook(db, { accountId: 'BANK', from: '2026-10-01', to: '2026-10-31' });
    expect([bank.opening, rs(bank.in), rs(bank.out), rs(bank.closing)]).toEqual([
      0, 7000, 123000, -116000,
    ]);
    expect(bank.rows.map((r) => `${r.kind}:${rs(r.amount)}:${r.party}`).sort()).toEqual(
      [
        'expense:-10000:Rent',
        'receipt:4000:Butt',
        'transfer_in:3000:Drawers',
        'salary:-15000:Cleaner',
        'salary:-18000:Teacher T',
        'salary:-80000:Owner O',
      ].sort(),
    );
    expect(await all(db, sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });

  it('the accountant’s view leaves the owner’s pay out (F1)', async () => {
    const ie = await incomeExpense(db, { from: '2026-10', to: '2026-10' }, { excludeOwners: true });
    expect(ie.salaries).toEqual({ pay: RS(46000), slips: 2, scope: 'excluding_owners' });
    expect(rs(ie.net)).toBe(-44700);
    expect(ie.months[0]?.salaries).toBe(RS(46000));
    // Income and expenses are the same; the books still tie on the full data.
    expect([rs(ie.income.total), rs(ie.expenses.total), ie.reconciliation.ties]).toEqual([
      12000,
      10700,
      true,
    ]);
    const bank = await cashbook(db, {
      accountId: 'BANK',
      from: '2026-10-01',
      to: '2026-10-31',
      maskOwners: true,
    });
    expect(bank.rows.map((r) => `${r.kind}:${rs(r.amount)}:${r.party}`).sort()).toEqual(
      [
        'expense:-10000:Rent',
        'receipt:4000:Butt',
        'transfer_in:3000:Drawers',
        'salary:-15000:Cleaner',
        'salary:-18000:Teacher T',
        'owner_draw:-80000:—',
      ].sort(),
    );
    const masked = bank.rows.find((r) => r.kind === 'owner_draw');
    expect([masked?.subkind, masked?.ref_id, masked?.ref_no]).toEqual([null, 'owner_draw', null]);
    expect(rs(bank.closing)).toBe(-116000);
  });
});

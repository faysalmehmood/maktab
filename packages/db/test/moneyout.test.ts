import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import {
  accountBalances,
  advanceRegister,
  approvePayslip,
  cashbook,
  closeSession,
  collect,
  createPayslip,
  defaultLines,
  expenseRegister,
  generatePayslips,
  incomeExpense,
  openSession,
  outstandingAdvance,
  paySalary,
  payslipDetail,
  payslips,
  recordAdvance,
  recordExpense,
  recordOpeningBalance,
  recordTransfer,
  reopenSession,
  sessionFor,
  setPayslipLines,
  suggestedRecovery,
  voidExpense,
  voidPayslip,
} from '../src/ledger';
import { createTestDb } from '../src/node';

// M4 money out on better-sqlite3 (the D1 path is apps/api/test/d1-money-out.test.ts). Every test
// that writes ends with ledger_consistency empty.

type Row = Record<string, unknown>;
const all = (db: AppDb, q: SQL) => db.all<Row>(q);
const run = (db: AppDb, ...qs: string[]) =>
  atomic(
    db,
    () => qs.map((q) => rawStatement(db, sql.raw(q))) as [ReturnType<typeof rawStatement>],
  );
const consistency = (db: AppDb) => all(db, sql`SELECT * FROM ledger_consistency`);
const RS = (n: number) => n * 100;
const TODAY = '2026-10-05';

async function expectFail(fn: () => Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected failure ${pattern}`).toBeDefined();
  const parts: string[] = [];
  for (let e: unknown = caught, d = 0; e && d < 5; d++) {
    parts.push(
      e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e),
    );
    e = e instanceof Error ? e.cause : undefined;
  }
  expect(parts.join(' | ')).toMatch(pattern);
}

/**
 * Owner O (also staff ST_O), admin A, accountant U2 (collector), teacher T (staff ST_T, Rs 30,000
 * + Rs 2,000 transport). Accounts: one shared drawer account and a bank. Family F1 with S1 billed
 * Rs 3,000 tuition for September and October.
 */
async function seed(db: AppDb) {
  await run(
    db,
    `INSERT INTO "user" (id, email, name, status) VALUES ('O', 'o@x.pk', 'Owner', 'active'),
       ('A', 'a@x.pk', 'Admin', 'active'), ('U2', 'acct@x.pk', 'Accountant', 'active'),
       ('T', 't@x.pk', 'Teacher', 'active')`,
    `INSERT INTO role (user_id, role) VALUES ('O', 'owner'), ('A', 'admin'), ('U2', 'accountant'), ('T', 'teacher')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at) VALUES ('SCH', 'Test School', 'R', '2026-04-01')`,
    `INSERT INTO staff (id, user_id, name, base_salary, allowances) VALUES
       ('ST_T', 'T', 'Teacher T', ${RS(30000)}, '[{"label":"Transport","amount":${RS(2000)}}]'),
       ('ST_O', 'O', 'Owner O', ${RS(80000)}, NULL),
       ('ST_X', NULL, 'Cleaner', ${RS(15000)}, NULL),
       ('ST_N', NULL, 'Volunteer', NULL, NULL)`,
    `INSERT INTO account (id, name, kind) VALUES ('CASH', 'Drawers', 'cash'), ('BANK', 'Bank', 'bank')`,
    `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI', 'Tuition', 'tuition', 'monthly')`,
    `INSERT INTO family (id, name) VALUES ('F1', 'Khan')`,
    `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S1', 'F1', '2026-0001', 'Ali', '2026-04-01'),
       ('S2', 'F1', '2026-0002', 'Sara', '2026-04-01')`,
    `INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind) VALUES
       ('C9', 'S1', 'TUI', '2026-09', 'family', 'F1', ${RS(3000)}, '2026-09-10', 'fee'),
       ('C10', 'S1', 'TUI', '2026-10', 'family', 'F1', ${RS(3000)}, '2026-10-10', 'fee')`,
  );
}

let db: AppDb;
beforeEach(async () => {
  db = createTestDb();
  await seed(db);
  // Paying out of a drawer needs the payer to have opened it (M4 fix pass: never auto-opened).
  await openSession(db, { collectorId: 'U2', businessDate: TODAY });
});

const cat = async (code: string) =>
  ((await all(db, sql`SELECT id FROM expense_category WHERE code = ${code}`))[0]?.id ??
    '') as string;
const expense = async (o: Partial<Parameters<typeof recordExpense>[1]> & { code?: string } = {}) =>
  recordExpense(db, {
    categoryId: await cat(o.code ?? 'stationery'),
    amount: RS(500),
    accountId: 'CASH',
    by: 'U2',
    today: TODAY,
    ...o,
  });
const pay = (amount: number, method: 'cash' | 'bank' = 'cash', date = TODAY) =>
  collect(db, {
    payerType: 'family',
    payerId: 'F1',
    amount,
    method,
    accountId: method === 'bank' ? 'BANK' : null,
    businessDate: date,
    today: date,
    collectorId: 'U2',
    idempotencyKey: newId(),
  });

describe('categories (migration seed)', () => {
  it('seeds the list with Urdu names; salaries is system-reserved', async () => {
    const rows = await all(
      db,
      sql`SELECT code, name_ur IS NOT NULL AS ur, system FROM expense_category ORDER BY sort`,
    );
    expect(rows.map((r) => r.code)).toEqual([
      'rent',
      'utilities',
      'salaries',
      'stationery',
      'maintenance',
      'transport',
      'exam',
      'misc',
    ]);
    expect(rows.every((r) => r.ur === 1)).toBe(true);
    expect(rows.filter((r) => r.system === 1).map((r) => r.code)).toEqual(['salaries']);
  });
});

describe('expenses', () => {
  it('numbers EXP-YYYY-NNNNN in-batch, opens the drawer for cash, audits', async () => {
    const a = await expense();
    const b = await expense({ accountId: 'BANK', date: '2026-10-01', code: 'rent' });
    expect(a.expense_no).toBe('EXP-2026-00001');
    expect(b.expense_no).toBe('EXP-2026-00002');
    const [row] = await all(
      db,
      sql`SELECT cash_session_id IS NOT NULL AS drawer FROM expense WHERE id = ${a.id}`,
    );
    expect(row?.drawer).toBe(1);
    const [bank] = await all(db, sql`SELECT cash_session_id FROM expense WHERE id = ${b.id}`);
    expect(bank?.cash_session_id).toBeNull();
    expect((await all(db, sql`SELECT action FROM audit WHERE entity = 'expense'`)).length).toBe(2);
    // A replay with the same id returns the same expense; nothing new numbered.
    const again = await expense({ id: a.id });
    expect(again).toEqual({ id: a.id, expense_no: 'EXP-2026-00001', replayed: true });
    expect(await consistency(db)).toEqual([]);
  });

  it('refuses a cash expense into a closed drawer, a backdated cash expense, no account, salaries', async () => {
    await expense();
    const s = await sessionFor(db, 'U2', TODAY);
    await closeSession(db, { sessionId: s?.id ?? '', counted: 0, by: 'U2' });
    await expectFail(() => expense(), /session_closed|cash session.*closed/i);
    await expectFail(() => expense({ date: '2026-10-04' }), /backdated/);
    await expectFail(() => expense({ accountId: null }), /account/i);
    await expectFail(() => expense({ code: 'salaries', accountId: 'BANK' }), /payslips/);
    await expectFail(() => expense({ accountId: 'BANK', date: '2026-10-06' }), /future/);
    // Bank money is not in a drawer: still fine with the drawer closed.
    await expense({ accountId: 'BANK' });
    // Raw insert with a typed number, or a cash expense with no session: the triggers refuse.
    await expectFail(
      () =>
        run(
          db,
          `INSERT INTO expense (id, expense_no, category_id, account_id, amount, date) VALUES ('x', 'EXP-2026-00099', 'expcat_misc', 'BANK', 1, '${TODAY}')`,
        ),
      /next number of the EXP series/,
    );
    await expectFail(
      () =>
        run(
          db,
          `UPDATE receipt_series SET next_no = next_no + 1 WHERE series = 'EXP'`,
          `INSERT INTO expense (id, expense_no, category_id, account_id, amount, date) VALUES ('x', 'EXP-2026-00003', 'expcat_misc', 'CASH', 1, '${TODAY}')`,
        ),
      /drawer expense needs a cash session/,
    );
    expect(await consistency(db)).toEqual([]);
  });

  it('voids with a reason only, once; a void leaves the register and the drawer', async () => {
    const a = await expense();
    await expectFail(() => voidExpense(db, { id: a.id, reason: '  ', by: 'A' }), /reason/);
    const v = await voidExpense(db, { id: a.id, reason: 'entered twice', by: 'A' });
    expect(v.void_reason).toBe('entered twice');
    await expectFail(() => voidExpense(db, { id: a.id, reason: 'again', by: 'A' }), /already/);
    await expectFail(
      () => run(db, `UPDATE expense SET amount = 1 WHERE id = '${a.id}'`),
      /never edited|already voided/,
    );
    expect(await expenseRegister(db, { from: '2026-10-01', to: '2026-10-31' })).toHaveLength(0);
    expect(
      await expenseRegister(db, { from: '2026-10-01', to: '2026-10-31', includeVoid: true }),
    ).toHaveLength(1);
    expect(await consistency(db)).toEqual([]);
  });
});

describe('payslips', () => {
  it('suggests recovery = min(outstanding, pct of pay) in whole rupees', () => {
    expect(suggestedRecovery(RS(10000), RS(32000), 25)).toBe(RS(8000));
    expect(suggestedRecovery(RS(3000), RS(32000), 25)).toBe(RS(3000));
    expect(suggestedRecovery(0, RS(32000), 25)).toBe(0);
    expect(suggestedRecovery(RS(5000), 333_333, 10)).toBe(RS(333));
    expect(
      defaultLines({
        baseSalary: RS(30000),
        allowances: [{ label: 'Transport', amount: RS(2000) }],
        outstanding: 0,
        pct: 25,
      }),
    ).toEqual([
      { kind: 'basic', amount: RS(30000) },
      { kind: 'allowance', amount: RS(2000), note: 'Transport' },
    ]);
  });

  it('generates drafts for active payroll staff in chunks; net from base + allowances − deductions − recovery', async () => {
    const first = await generatePayslips(db, { periodKey: '2026-10', by: 'U2', limit: 2 });
    expect(first).toEqual({ created: 2, skipped: 0, next: 'ST_T' });
    const second = await generatePayslips(db, {
      periodKey: '2026-10',
      by: 'U2',
      after: first.next,
      limit: 2,
    });
    expect(second).toEqual({ created: 1, skipped: 0, next: null });
    // Re-running creates nothing (one slip per staff and month).
    expect(await generatePayslips(db, { periodKey: '2026-10', by: 'U2' })).toEqual({
      created: 0,
      skipped: 3,
      next: null,
    });
    const rows = await payslips(db, { period: '2026-10' });
    expect(rows.map((r) => [r.staff_id, r.status, r.net])).toEqual([
      ['ST_X', 'draft', RS(15000)],
      ['ST_O', 'draft', RS(80000)],
      ['ST_T', 'draft', RS(32000)],
    ]);
    // The accountant scope hides the owner's slip.
    expect(
      (await payslips(db, { period: '2026-10', excludeOwners: true })).map((r) => r.staff_id),
    ).toEqual(['ST_X', 'ST_T']);
    const t = rows.find((r) => r.staff_id === 'ST_T');
    await setPayslipLines(db, {
      id: t?.id ?? '',
      lines: [
        { kind: 'basic', amount: RS(30000) },
        { kind: 'allowance', amount: RS(2000), note: 'Transport' },
        { kind: 'deduction', amount: RS(1000), note: '2 days unpaid leave' },
      ],
      by: 'U2',
    });
    const d = await payslipDetail(db, t?.id ?? '');
    expect([d?.earnings, d?.deductions, d?.pay, d?.net]).toEqual([
      RS(32000),
      RS(1000),
      RS(31000),
      RS(31000),
    ]);
    await expectFail(
      () => createPayslip(db, { staffId: 'ST_T', periodKey: '2026-10', by: 'U2' }),
      /already exists/,
    );
    await expectFail(
      () =>
        setPayslipLines(db, {
          id: t?.id ?? '',
          lines: [{ kind: 'deduction', amount: RS(5) }],
          by: 'U2',
        }),
      /exceed the pay/,
    );
  });

  it('approval: owner/admin, never your own slip (helper and trigger), recovery within the advance', async () => {
    const own = await createPayslip(db, { staffId: 'ST_O', periodKey: '2026-10', by: 'U2' });
    await expectFail(() => approvePayslip(db, { id: own.id, by: 'O' }), /own_payslip|Someone else/);
    await expectFail(
      () =>
        run(db, `UPDATE payslip SET status = 'approved', approved_by = 'O' WHERE id = '${own.id}'`),
      /own staff member/,
    );
    await approvePayslip(db, { id: own.id, by: 'A' });
    await expectFail(() => approvePayslip(db, { id: own.id, by: 'A' }), /not_draft|draft/);

    const lines = [
      { kind: 'basic' as const, amount: RS(30000) },
      { kind: 'advance_recovery' as const, amount: RS(1000) },
    ];
    // Recovery with no advance outstanding is refused when the lines are written (verify pass)…
    await expectFail(
      () => createPayslip(db, { staffId: 'ST_T', periodKey: '2026-10', lines, by: 'U2' }),
      /recovery_exceeds_advance/,
    );
    const t = await createPayslip(db, {
      staffId: 'ST_T',
      periodKey: '2026-10',
      lines: lines.slice(0, 1),
      by: 'U2',
    });
    await expectFail(() => setPayslipLines(db, { id: t.id, lines, by: 'U2' }), /recovery_exceeds/);
    // …and a line slipped in by hand is still caught at approval (helper, then trigger).
    await run(
      db,
      `INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('rl', '${t.id}', 'advance_recovery', ${RS(1000)})`,
    );
    await expectFail(() => approvePayslip(db, { id: t.id, by: 'A' }), /recovery/);
    await expectFail(
      () =>
        run(db, `UPDATE payslip SET status = 'approved', approved_by = 'A' WHERE id = '${t.id}'`),
      /advance recovery exceeds outstanding advance/,
    );
    expect(await consistency(db)).toEqual([]);
  });

  it('pays partially up to the net (helper, then trigger), becomes paid at the net; void only unpaid', async () => {
    await pay(RS(50000));
    const t = await createPayslip(db, { staffId: 'ST_T', periodKey: '2026-10', by: 'U2' });
    await expectFail(
      () =>
        paySalary(db, {
          payslipId: t.id,
          amount: RS(1),
          accountId: 'BANK',
          by: 'U2',
          today: TODAY,
        }),
      /Approve the payslip first/,
    );
    await approvePayslip(db, { id: t.id, by: 'A' });
    const p1 = await paySalary(db, {
      payslipId: t.id,
      amount: RS(20000),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
    });
    expect(p1.status).toBe('approved');
    await expectFail(
      () =>
        paySalary(db, {
          payslipId: t.id,
          amount: RS(12001),
          accountId: 'BANK',
          by: 'U2',
          today: TODAY,
        }),
      /exceeds_net|More than what is left/,
    );
    await expectFail(
      () =>
        run(
          db,
          `INSERT INTO salary_payment (id, payslip_id, amount, account_id, date) VALUES ('sp', '${t.id}', ${RS(12001)}, 'BANK', '${TODAY}')`,
        ),
      /salary payments exceed payslip net/,
    );
    await expectFail(
      () => voidPayslip(db, { id: t.id, reason: 'left', by: 'A' }),
      /cannot be voided/,
    );
    const p2 = await paySalary(db, {
      payslipId: t.id,
      amount: RS(12000),
      accountId: 'BANK',
      date: '2026-10-03',
      by: 'U2',
      today: TODAY,
    });
    expect(p2.status).toBe('paid');
    await expectFail(
      () =>
        paySalary(db, {
          payslipId: t.id,
          amount: RS(1),
          accountId: 'BANK',
          by: 'U2',
          today: TODAY,
        }),
      /fully paid/,
    );

    const x = await createPayslip(db, { staffId: 'ST_X', periodKey: '2026-10', by: 'U2' });
    await approvePayslip(db, { id: x.id, by: 'O' });
    await expectFail(() => voidPayslip(db, { id: x.id, reason: '', by: 'A' }), /reason/);
    await voidPayslip(db, { id: x.id, reason: 'left in September', by: 'A' });
    const [v] = await payslips(db, { ids: [x.id] });
    expect([v?.status, v?.void_reason]).toEqual(['void', 'left in September']);
    await expectFail(
      () =>
        paySalary(db, {
          payslipId: x.id,
          amount: RS(1),
          accountId: 'BANK',
          by: 'U2',
          today: TODAY,
        }),
      /void/,
    );
    expect(await consistency(db)).toEqual([]);
  });
});

describe('advances', () => {
  it('cash from the open drawer; recovered through approved slips; outstanding derived', async () => {
    await pay(RS(20000));
    await recordAdvance(db, {
      staffId: 'ST_T',
      amount: RS(10000),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
      note: 'wedding',
    });
    expect(await outstandingAdvance(db, 'ST_T')).toEqual({
      staff_id: 'ST_T',
      advanced: RS(10000),
      recovered: 0,
      outstanding: RS(10000),
    });
    // Suggested recovery: min(10,000, 25% of 32,000 = 8,000).
    const slip = await createPayslip(db, { staffId: 'ST_T', periodKey: '2026-10', by: 'U2' });
    const d = await payslipDetail(db, slip.id);
    expect(d?.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['basic', RS(30000)],
      ['allowance', RS(2000)],
      ['advance_recovery', RS(8000)],
    ]);
    expect(d?.net).toBe(RS(24000));
    // A draft does not recover yet; the next draft only suggests what is left.
    expect((await outstandingAdvance(db, 'ST_T')).outstanding).toBe(RS(10000));
    const nov = await createPayslip(db, { staffId: 'ST_T', periodKey: '2026-11', by: 'U2' });
    expect((await payslipDetail(db, nov.id))?.recovery).toBe(RS(2000));
    await approvePayslip(db, { id: slip.id, by: 'A' });
    expect(await outstandingAdvance(db, 'ST_T')).toMatchObject({
      recovered: RS(8000),
      outstanding: RS(2000),
    });
    const reg = await advanceRegister(db);
    expect(reg.balances).toEqual([
      expect.objectContaining({ staff_id: 'ST_T', outstanding: RS(2000) }),
    ]);
    expect(reg.advances).toHaveLength(1);
    await expectFail(
      () =>
        recordAdvance(db, {
          staffId: 'ST_T',
          amount: RS(1),
          accountId: 'CASH',
          date: '2026-10-04',
          by: 'U2',
          today: TODAY,
        }),
      /backdated/,
    );
    expect(await consistency(db)).toEqual([]);
  });
});

describe('cash session expected (closeSession)', () => {
  it('subtracts drawer expenses, salary and advances paid from that drawer; reopen keeps it frozen', async () => {
    await pay(RS(40000)); // drawer +40,000
    await expense({ amount: RS(1500) }); // −1,500
    await expense({ amount: RS(700), accountId: 'BANK' }); // bank, not the drawer
    const voided = await expense({ amount: RS(300) });
    await voidExpense(db, { id: voided.id, reason: 'mistake', by: 'A' }); // a void leaves the drawer
    const slip = await createPayslip(db, { staffId: 'ST_X', periodKey: '2026-10', by: 'U2' });
    await approvePayslip(db, { id: slip.id, by: 'A' });
    await paySalary(db, {
      payslipId: slip.id,
      amount: RS(10000),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
    }); // −10,000
    await recordAdvance(db, {
      staffId: 'ST_T',
      amount: RS(5000),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
    }); // −5,000
    await recordTransfer(db, {
      fromAccount: 'CASH',
      toAccount: 'BANK',
      amount: RS(20000),
      date: TODAY,
      by: 'U2',
    }); // −20,000
    const s = await sessionFor(db, 'U2', TODAY);
    const closed = await closeSession(db, { sessionId: s?.id ?? '', counted: RS(3400), by: 'U2' });
    expect(closed.expected).toBe(RS(40000 - 1500 - 10000 - 5000 - 20000));
    expect(closed.variance).toBe(RS(-100));
    await expectFail(
      () =>
        recordAdvance(db, {
          staffId: 'ST_T',
          amount: RS(1),
          accountId: 'CASH',
          by: 'U2',
          today: TODAY,
        }),
      /session_closed|closed/,
    );
    await expectFail(
      () =>
        run(
          db,
          `INSERT INTO staff_advance (id, staff_id, amount, account_id, cash_session_id, date) VALUES ('a9', 'ST_T', 100, 'CASH', '${s?.id}', '${TODAY}')`,
        ),
      /cash session is closed/,
    );
    await reopenSession(db, { sessionId: s?.id ?? '', reason: 'recount', by: 'A' });
    await paySalary(db, {
      payslipId: slip.id,
      amount: RS(100),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
    });
    const again = await closeSession(db, { sessionId: s?.id ?? '', counted: RS(3300), by: 'U2' });
    expect(again.expected).toBe(RS(3400));
    expect(await consistency(db)).toEqual([]);
  });
});

describe('reports', () => {
  /** Sept + Oct on known numbers: the P&L ties to account movements. */
  async function books() {
    await pay(RS(6000), 'bank', '2026-09-20'); // Sept: 3,000 to C9 + 3,000 to C10 (oldest first)
    await pay(RS(2000), 'cash', TODAY); // Oct: nothing due, 2,000 stays credit
    await recordOpeningBalance(db, {
      studentId: 'S2',
      amount: -RS(500),
      asOf: '2026-09-01',
      by: 'A',
    });
    await expense({ amount: RS(1500) });
    await expense({ amount: RS(10000), accountId: 'BANK', date: '2026-09-25', code: 'rent' });
    await recordAdvance(db, {
      staffId: 'ST_T',
      amount: RS(3000),
      accountId: 'BANK',
      date: '2026-09-28',
      by: 'U2',
      today: TODAY,
    });
    const slip = await createPayslip(db, {
      staffId: 'ST_X',
      periodKey: '2026-09',
      lines: [
        { kind: 'basic', amount: RS(15000) },
        { kind: 'deduction', amount: RS(500) },
      ],
      by: 'U2',
    });
    await approvePayslip(db, { id: slip.id, by: 'A' });
    await paySalary(db, {
      payslipId: slip.id,
      amount: RS(14500),
      accountId: 'BANK',
      date: '2026-10-01',
      by: 'U2',
      today: TODAY,
    });
    await createPayslip(db, { staffId: 'ST_T', periodKey: '2026-10', by: 'U2' }); // draft: not a salary yet
    await recordTransfer(db, {
      fromAccount: 'CASH',
      toAccount: 'BANK',
      amount: RS(500),
      date: TODAY,
      by: 'U2',
    });
  }

  it('income vs expense: by head, unallocated, categories, salaries (earned), net; excludes opening, transfers, advances', async () => {
    await books();
    const r = await incomeExpense(db, { from: '2026-09', to: '2026-10' });
    expect(r.income).toEqual({
      by_head: [{ fee_head_id: 'TUI', name: 'Tuition', name_ur: null, amount: RS(6000) }],
      unallocated: RS(2000),
      total: RS(8000),
    });
    expect(r.expenses.total).toBe(RS(11500));
    expect(r.expenses.by_category.map((c) => [c.code, c.amount])).toEqual([
      ['rent', RS(10000)],
      ['stationery', RS(1500)],
    ]);
    expect(r.salaries).toEqual({ pay: RS(14500), slips: 1, scope: 'all' });
    expect(r.net).toBe(RS(8000 - 11500 - 14500));
    expect(r.months).toEqual([
      {
        period: '2026-09',
        income: RS(6000),
        expenses: RS(10000),
        salaries: RS(14500),
        net: RS(-18500),
      },
      { period: '2026-10', income: RS(2000), expenses: RS(1500), salaries: 0, net: RS(500) },
    ]);
    expect(r.reconciliation).toMatchObject({
      salary_paid: RS(14500),
      advances_paid: RS(3000),
      expected_movement: RS(8000 - 11500 - 14500 - 3000),
      movement: RS(8000 - 11500 - 14500 - 3000),
      ties: true,
    });
    expect(await consistency(db)).toEqual([]);
  });

  it('cashbook per account ties to accountBalances; movements sum to the P&L reconciliation', async () => {
    await books();
    const balances = await accountBalances(db);
    const bank = await cashbook(db, { accountId: 'BANK', from: '2026-09-01', to: '2026-10-31' });
    const cash = await cashbook(db, { accountId: 'CASH', from: '2026-10-01', to: '2026-10-31' });
    expect(bank.opening).toBe(0);
    expect(bank.closing).toBe(balances.find((b) => b.account_id === 'BANK')?.balance);
    expect(cash.closing).toBe(balances.find((b) => b.account_id === 'CASH')?.balance);
    expect(cash.rows.map((x) => [x.kind, x.amount])).toEqual([
      ['receipt', RS(2000)],
      ['expense', -RS(1500)],
      ['transfer_out', -RS(500)],
    ]);
    expect(cash.closing).toBe(0);
    expect(bank.rows.map((x) => x.kind)).toEqual([
      'receipt',
      'expense',
      'advance',
      'salary',
      'transfer_in',
    ]);
    expect(bank.rows.find((x) => x.kind === 'transfer_in')?.party).toBe('Drawers');
    expect(bank.rows.find((x) => x.kind === 'receipt')?.party).toBe('Khan');
    // A cut in the middle: opening = the balance the day before.
    const oct = await cashbook(db, { accountId: 'BANK', from: '2026-10-01', to: '2026-10-31' });
    const sept = await accountBalances(db, { asOf: '2026-09-30' });
    expect(oct.opening).toBe(sept.find((b) => b.account_id === 'BANK')?.balance);
    const total = balances.reduce((a, b) => a + b.balance, 0);
    const r = await incomeExpense(db, { from: '2026-09', to: '2026-10' });
    expect(total).toBe(r.reconciliation.movement);
  });
});

describe('ledger_consistency (M4 flags)', () => {
  it('flags drawer cash with no session, mis-numbered receipts, overpaid payslips, negative advances', async () => {
    // Rows that only a bypassed trigger could write: drop the backstops on this throwaway db.
    await run(
      db,
      'DROP TRIGGER receipt_payment_shape',
      'DROP TRIGGER salary_payment_within_net',
      'DROP TRIGGER payslip_approve_rules',
      `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key)
         VALUES ('BAD1', 'R-2026-00001', 'payment', 'family', 'F1', 100, 'cash', 'U2', '${TODAY}', 'k1'),
                ('BAD2', 'HAND-7', 'payment', 'family', 'F1', 100, 'bank', 'U2', '${TODAY}', 'k2')`,
      `INSERT INTO payslip (id, staff_id, period_key) VALUES ('PS', 'ST_X', '2026-10')`,
      `INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('L1', 'PS', 'basic', 1000), ('L2', 'PS', 'advance_recovery', 10)`,
      `UPDATE payslip SET status = 'approved', approved_by = 'A' WHERE id = 'PS'`,
      `INSERT INTO salary_payment (id, payslip_id, amount, account_id, date) VALUES ('SP', 'PS', 1500, 'BANK', '${TODAY}')`,
    );
    const issues = (await consistency(db)).map((r) => [r.issue, r.receipt_id ?? r.payer_id]);
    expect(issues).toEqual(
      expect.arrayContaining([
        ['cash_receipt_no_session', 'BAD1'],
        ['receipt_no_format', 'BAD1'],
        ['receipt_no_format', 'BAD2'],
        ['payslip_overpaid', 'PS'],
        ['advance_negative', 'ST_X'],
      ]),
    );
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AppDb,
  accountBalances,
  approvePayslip,
  cashbook,
  closeSession,
  collect,
  generatePayslips,
  getDb,
  incomeExpense,
  outstandingAdvance,
  paySalary,
  payslips,
  recordAdvance,
  recordExpense,
  recordOpeningBalance,
  recordTransfer,
  sessionFor,
  voidExpense,
  voidPayslip,
} from '@maktab/db';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import { newId } from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';

/**
 * M4 on workerd's real D1 (PLAN §15: D1 behaviour is proven here, not on better-sqlite3 alone):
 * the EXP series bump in-batch, drawer sessions opened in the same batch as the money out, json_each
 * payslip generation, the paid-status update after the payment insert, trigger rollbacks of a whole
 * batch, and the views behind the reports.
 */
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
let db: AppDb;
const RS = (n: number) => n * 100;
const TODAY = '2026-10-05';
const consistency = () => db.all(sql`SELECT * FROM ledger_consistency`);
const one = async <T>(q: ReturnType<typeof sql>) => (await db.all<T>(q))[0] as T;

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
  db = getDb({ DB: proxy.env.DB });
  await proxy.env.DB.batch(
    [
      `INSERT INTO "user" (id, email, name, status) VALUES ('A', 'a@x.pk', 'Admin', 'active'), ('U2', 'c@x.pk', 'Acct', 'active'), ('T', 't@x.pk', 'T', 'active')`,
      `INSERT INTO school (id, name, receipt_prefix, setup_completed_at) VALUES ('SCH', 'T', 'R', '2026-01-01')`,
      `INSERT INTO account (id, name, kind) VALUES ('CASH', 'Drawers', 'cash'), ('BANK', 'Bank', 'bank')`,
      `INSERT INTO staff (id, user_id, name, base_salary, allowances) VALUES
         ${Array.from({ length: 60 }, (_, i) => `('ST${String(i).padStart(2, '0')}', ${i === 0 ? `'T'` : 'NULL'}, 'Staff ${i}', ${RS(10000 + i * 100)}, ${i === 0 ? `'[{"label":"Transport","amount":${RS(1000)}}]'` : 'NULL'})`).join(',')}`,
      `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI', 'Tuition', 'tuition', 'monthly')`,
      `INSERT INTO family (id, name) VALUES ('F1', 'Khan')`,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S1', 'F1', '1', 'Ali', '2026-01-01'), ('S2', 'F1', '2', 'Sara', '2026-01-01')`,
      `INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind)
         VALUES ('C1', 'S1', 'TUI', '2026-10', 'family', 'F1', ${RS(3000)}, '2026-10-10', 'fee')`,
    ].map((q) => proxy.env.DB.prepare(q)),
  );
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe('money out on D1', () => {
  it('expense → payslips (chunks) → approve → partial cash pay → advance → close drawer → reports tie out', async () => {
    await collect(db, {
      payerType: 'family',
      payerId: 'F1',
      amount: RS(50000),
      method: 'cash',
      businessDate: TODAY,
      today: TODAY,
      collectorId: 'U2',
      idempotencyKey: newId(),
    });
    await recordOpeningBalance(db, {
      studentId: 'S2',
      amount: -RS(800),
      asOf: '2026-09-01',
      by: 'A',
    });
    const e1 = await recordExpense(db, {
      categoryId: 'expcat_stationery',
      amount: RS(1200),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
    });
    const e2 = await recordExpense(db, {
      categoryId: 'expcat_rent',
      amount: RS(9000),
      accountId: 'BANK',
      date: '2026-10-01',
      by: 'U2',
      today: TODAY,
    });
    expect([e1.expense_no, e2.expense_no]).toEqual(['EXP-2026-00001', 'EXP-2026-00002']);
    const e3 = await recordExpense(db, {
      categoryId: 'expcat_misc',
      amount: RS(100),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
    });
    await voidExpense(db, { id: e3.id, reason: 'wrong', by: 'A' });

    // 60 payroll staff: two chunks of 50 / 10.
    const g1 = await generatePayslips(db, { periodKey: '2026-10', by: 'U2' });
    const g2 = await generatePayslips(db, { periodKey: '2026-10', by: 'U2', after: g1.next });
    expect([g1.created, g1.next, g2.created, g2.next]).toEqual([50, 'ST49', 10, null]);
    expect(await one(sql`SELECT count(*) AS n FROM payslip_line`)).toEqual({ n: 61 });

    await recordAdvance(db, {
      staffId: 'ST00',
      amount: RS(2000),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
    });
    const [s0] = await payslips(db, { staffId: 'ST00' });
    await expect(approvePayslip(db, { id: s0?.id ?? '', by: 'T' })).rejects.toThrow(/Someone else/);
    await approvePayslip(db, { id: s0?.id ?? '', by: 'A' });
    const p1 = await paySalary(db, {
      payslipId: s0?.id ?? '',
      amount: RS(5000),
      accountId: 'CASH',
      by: 'U2',
      today: TODAY,
    });
    expect(p1.status).toBe('approved');
    // Over the net: the trigger rolls back the whole batch (no payment row).
    await expect(
      proxy.env.DB.prepare(
        `INSERT INTO salary_payment (id, payslip_id, amount, account_id, date) VALUES ('x', '${s0?.id}', ${RS(99999)}, 'BANK', '${TODAY}')`,
      ).run(),
    ).rejects.toThrow(/exceed payslip net/);
    const p2 = await paySalary(db, {
      payslipId: s0?.id ?? '',
      amount: RS(6000),
      accountId: 'BANK',
      date: '2026-10-04',
      by: 'U2',
      today: TODAY,
    });
    expect(p2.status).toBe('paid');
    const [s1] = await payslips(db, { staffId: 'ST01' });
    await voidPayslip(db, { id: s1?.id ?? '', reason: 'left', by: 'A' });

    // Drawer: 50,000 − 1,200 − 5,000 (salary) − 2,000 (advance) − 10,000 (handover) = 31,800.
    await recordTransfer(db, {
      fromAccount: 'CASH',
      toAccount: 'BANK',
      amount: RS(10000),
      date: TODAY,
      by: 'U2',
    });
    const s = await sessionFor(db, 'U2', TODAY);
    const closed = await closeSession(db, { sessionId: s?.id ?? '', counted: RS(31800), by: 'U2' });
    expect([closed.expected, closed.variance]).toEqual([RS(31800), 0]);
    // Closed drawer: refused up front, and by the trigger as a batch (the EXP number is not used).
    await expect(
      recordExpense(db, {
        categoryId: 'expcat_misc',
        amount: RS(1),
        accountId: 'CASH',
        by: 'U2',
        today: TODAY,
      }),
    ).rejects.toThrow(/closed/);
    await expect(
      proxy.env.DB.batch([
        proxy.env.DB.prepare(
          `UPDATE receipt_series SET next_no = next_no + 1 WHERE series = 'EXP'`,
        ),
        proxy.env.DB.prepare(
          `INSERT INTO expense (id, expense_no, category_id, account_id, cash_session_id, amount, date) VALUES ('y', 'EXP-2026-00004', 'expcat_misc', 'CASH', '${s?.id}', 1, '${TODAY}')`,
        ),
      ]),
    ).rejects.toThrow(/cash session is closed/);
    expect(await one(sql`SELECT next_no FROM receipt_series WHERE series = 'EXP'`)).toEqual({
      next_no: 4,
    });

    // The advance came after the draft was generated: nothing recovered yet.
    expect(await outstandingAdvance(db, 'ST00')).toMatchObject({
      advanced: RS(2000),
      outstanding: RS(2000),
    });
    const r = await incomeExpense(db, { from: '2026-09', to: '2026-10' });
    // Opening credit (800) is not income; transfers and the advance are not expenses.
    expect(r.income.total).toBe(RS(50000));
    expect(r.income.unallocated).toBe(RS(47000));
    expect(r.expenses.total).toBe(RS(10200));
    // Salaries = pay of approved/paid slips (ST00: 10,000 + 1,000), not payments; void and drafts out.
    expect(r.salaries).toEqual({ pay: RS(11000), slips: 1 });
    expect(r.reconciliation.ties).toBe(true);
    const balances = await accountBalances(db);
    expect(balances.reduce((a, b) => a + b.balance, 0)).toBe(r.reconciliation.movement);
    const cashBook = await cashbook(db, {
      accountId: 'CASH',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(cashBook.closing).toBe(RS(31800));
    expect(cashBook.closing).toBe(balances.find((b) => b.account_id === 'CASH')?.balance);
    expect(await consistency()).toEqual([]);
  });
});

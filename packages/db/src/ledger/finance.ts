import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { addPeriods, assertPeriod, FeeError, periodEnd, periodStart } from './util';

/**
 * Money reports (PLAN §14.8, §14.11). Derived at query time, never stored.
 *
 * Income = Σ money receipts by business date (payments, reversals and refunds, signed), split by fee
 * head through their allocations; what is not allocated is shown as "unallocated credit". Opening
 * credit (receipt kind `opening`) is not money and never income. Transfers move money between
 * accounts and advances are a receivable: neither is income or expense.
 * Expense = Σ non-void expenses by date + salaries = Σ payslip pay (earnings − deductions) of approved
 * or paid slips, by the slip's month — what was earned, not what was paid.
 *
 * Account movements (cashbook, balances, the reconciliation) all read the `money_movement` view
 * (sql/60_money_out.sql), so they tie out by construction.
 */

export type MonthRange = { from: string; to: string };

function checkRange(r: MonthRange): void {
  assertPeriod(r.from);
  assertPeriod(r.to);
  if (r.from > r.to) throw new FeeError('invalid', 'from: after to', 400);
  if (addPeriods(r.from, 24) <= r.to) throw new FeeError('invalid', 'at most 24 months', 400);
}

export function periodsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let p = from; p <= to; p = addPeriods(p, 1)) out.push(p);
  return out;
}

export type IncomeHeadRow = {
  fee_head_id: string;
  name: string;
  name_ur: string | null;
  amount: number;
};
export type ExpenseCategoryRow = {
  category_id: string;
  code: string | null;
  name: string;
  name_ur: string | null;
  amount: number;
};
export type IncomeExpenseMonth = {
  period: string;
  income: number;
  expenses: number;
  salaries: number;
  net: number;
};
export type IncomeExpenseReport = {
  from: string;
  to: string;
  income: { by_head: IncomeHeadRow[]; unallocated: number; total: number };
  expenses: { by_category: ExpenseCategoryRow[]; total: number };
  salaries: { pay: number; slips: number };
  /** income − expenses − salaries */
  net: number;
  months: IncomeExpenseMonth[];
  /**
   * How the P&L meets the accounts over the same dates: income − expenses − salary paid − advances
   * paid = Σ account movements (transfers cancel out). `ties` is false only if the books are broken.
   */
  reconciliation: {
    income: number;
    expenses: number;
    salary_paid: number;
    advances_paid: number;
    expected_movement: number;
    movement: number;
    ties: boolean;
  };
};

export async function incomeExpense(db: AppDb, r: MonthRange): Promise<IncomeExpenseReport> {
  checkRange(r);
  const d0 = periodStart(r.from);
  const d1 = periodEnd(r.to);
  const receipts = await db.all<{ period: string; amount: number }>(
    sql`SELECT substr(business_date, 1, 7) AS period, coalesce(sum(amount), 0) AS amount FROM receipt
        WHERE kind <> 'opening' AND business_date BETWEEN ${d0} AND ${d1} GROUP BY period`,
  );
  const byHead = await db.all<IncomeHeadRow & { period: string }>(
    sql`SELECT c.fee_head_id, h.name, h.name_ur, substr(r.business_date, 1, 7) AS period,
          sum(a.amount) AS amount
        FROM receipt r JOIN receipt_allocation a ON a.receipt_id = r.id
        JOIN charge c ON c.id = a.charge_id JOIN fee_head h ON h.id = c.fee_head_id
        WHERE r.kind <> 'opening' AND r.business_date BETWEEN ${d0} AND ${d1}
        GROUP BY c.fee_head_id, period`,
  );
  const byCat = await db.all<ExpenseCategoryRow & { period: string }>(
    sql`SELECT e.category_id, c.code, c.name, c.name_ur, substr(e.date, 1, 7) AS period,
          sum(e.amount) AS amount
        FROM expense e JOIN expense_category c ON c.id = e.category_id
        WHERE e.voided_by IS NULL AND e.date BETWEEN ${d0} AND ${d1}
        GROUP BY e.category_id, period`,
  );
  const salaries = await db.all<{ period: string; pay: number; slips: number }>(
    sql`SELECT period_key AS period, coalesce(sum(pay), 0) AS pay, count(*) AS slips FROM payslip_net
        WHERE status IN ('approved', 'paid') AND period_key BETWEEN ${r.from} AND ${r.to}
        GROUP BY period_key`,
  );
  const [moves] = await db.all<{
    salary_paid: number;
    advances_paid: number;
    movement: number;
  }>(
    sql`SELECT coalesce(sum(CASE WHEN kind = 'salary' THEN -amount END), 0) AS salary_paid,
          coalesce(sum(CASE WHEN kind = 'advance' THEN -amount END), 0) AS advances_paid,
          coalesce(sum(amount), 0) AS movement
        FROM money_movement WHERE date BETWEEN ${d0} AND ${d1}`,
  );

  const heads = new Map<string, IncomeHeadRow>();
  for (const h of byHead) {
    const cur = heads.get(h.fee_head_id);
    if (cur) cur.amount += h.amount;
    else
      heads.set(h.fee_head_id, {
        fee_head_id: h.fee_head_id,
        name: h.name,
        name_ur: h.name_ur,
        amount: h.amount,
      });
  }
  const cats = new Map<string, ExpenseCategoryRow>();
  for (const c of byCat) {
    const cur = cats.get(c.category_id);
    if (cur) cur.amount += c.amount;
    else
      cats.set(c.category_id, {
        category_id: c.category_id,
        code: c.code,
        name: c.name,
        name_ur: c.name_ur,
        amount: c.amount,
      });
  }
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
  const incomeTotal = sum(receipts, (x) => x.amount);
  const allocated = sum(byHead, (x) => x.amount);
  const expenseTotal = sum(byCat, (x) => x.amount);
  const pay = sum(salaries, (x) => x.pay);
  const months = periodsBetween(r.from, r.to).map((period) => {
    const income = sum(
      receipts.filter((x) => x.period === period),
      (x) => x.amount,
    );
    const expenses = sum(
      byCat.filter((x) => x.period === period),
      (x) => x.amount,
    );
    const sal = sum(
      salaries.filter((x) => x.period === period),
      (x) => x.pay,
    );
    return { period, income, expenses, salaries: sal, net: income - expenses - sal };
  });
  const salaryPaid = moves?.salary_paid ?? 0;
  const advancesPaid = moves?.advances_paid ?? 0;
  const expected = incomeTotal - expenseTotal - salaryPaid - advancesPaid;
  const movement = moves?.movement ?? 0;
  return {
    from: r.from,
    to: r.to,
    income: {
      by_head: [...heads.values()].sort((a, b) => b.amount - a.amount),
      unallocated: incomeTotal - allocated,
      total: incomeTotal,
    },
    expenses: {
      by_category: [...cats.values()].sort((a, b) => b.amount - a.amount),
      total: expenseTotal,
    },
    salaries: { pay, slips: sum(salaries, (x) => x.slips) },
    net: incomeTotal - expenseTotal - pay,
    months,
    reconciliation: {
      income: incomeTotal,
      expenses: expenseTotal,
      salary_paid: salaryPaid,
      advances_paid: advancesPaid,
      expected_movement: expected,
      movement,
      ties: expected === movement,
    },
  };
}

// ---- Accounts ------------------------------------------------------------------------------------

export type AccountBalance = {
  account_id: string | null;
  name: string;
  kind: 'cash' | 'bank' | 'wallet' | null;
  balance: number;
};

/**
 * Every account's balance from its movements up to `asOf` (inclusive; default: all). A row with
 * `account_id` null collects drawer cash taken while no cash account existed.
 */
export async function accountBalances(
  db: AppDb,
  o: { asOf?: string | null } = {},
): Promise<AccountBalance[]> {
  const cut = o.asOf ? sql`AND m.date <= ${o.asOf}` : sql``;
  const rows = await db.all<AccountBalance>(
    sql`SELECT a.id AS account_id, a.name, a.kind,
          coalesce((SELECT sum(m.amount) FROM money_movement m WHERE m.account_id = a.id ${cut}), 0) AS balance
        FROM account a ORDER BY a.kind, a.name, a.id`,
  );
  const [orphan] = await db.all<{ n: number; c: number }>(
    sql`SELECT coalesce(sum(m.amount), 0) AS n, count(*) AS c FROM money_movement m
        WHERE m.account_id IS NULL ${cut}`,
  );
  if (orphan?.c)
    rows.push({
      account_id: null,
      name: 'Drawer (no cash account)',
      kind: 'cash',
      balance: orphan.n,
    });
  return rows;
}

export type CashbookRow = {
  date: string;
  kind: 'receipt' | 'expense' | 'salary' | 'advance' | 'transfer_in' | 'transfer_out';
  subkind: string | null;
  ref_id: string;
  ref_no: string | null;
  /** Who or what: payer, vendor/category, staff member, the other account. */
  party: string | null;
  amount: number;
  balance: number;
  cash_session_id: string | null;
};

export type Cashbook = {
  account: { id: string; name: string; kind: string };
  from: string;
  to: string;
  opening: number;
  rows: CashbookRow[];
  in: number;
  out: number;
  closing: number;
};

const partySql: SQL = sql`CASE m.kind
  WHEN 'receipt' THEN coalesce((SELECT f.name FROM receipt r JOIN family f ON f.id = r.payer_id
                                WHERE r.id = m.ref_id AND r.payer_type = 'family'),
                               (SELECT s.name FROM receipt r JOIN sponsor s ON s.id = r.payer_id
                                WHERE r.id = m.ref_id AND r.payer_type = 'sponsor'))
  WHEN 'expense' THEN (SELECT coalesce(e.vendor, c.name) FROM expense e
                       JOIN expense_category c ON c.id = e.category_id WHERE e.id = m.ref_id)
  WHEN 'salary' THEN (SELECT st.name FROM salary_payment sp JOIN payslip p ON p.id = sp.payslip_id
                      JOIN staff st ON st.id = p.staff_id WHERE sp.id = m.ref_id)
  WHEN 'advance' THEN (SELECT st.name FROM staff_advance a JOIN staff st ON st.id = a.staff_id
                       WHERE a.id = m.ref_id)
  ELSE (SELECT name FROM account WHERE id = m.ref_no) END`;

/** One account between two dates: opening balance, every movement with a running balance, closing. */
export async function cashbook(
  db: AppDb,
  o: { accountId: string; from: string; to: string },
): Promise<Cashbook> {
  if (o.from > o.to) throw new FeeError('invalid', 'from: after to', 400);
  const [account] = await db.all<{ id: string; name: string; kind: string }>(
    sql`SELECT id, name, kind FROM account WHERE id = ${o.accountId}`,
  );
  if (!account) throw new FeeError('not_found', 'Account not found', 404);
  const [open] = await db.all<{ n: number }>(
    sql`SELECT coalesce(sum(amount), 0) AS n FROM money_movement
        WHERE account_id = ${o.accountId} AND date < ${o.from}`,
  );
  const raw = await db.all<Omit<CashbookRow, 'balance'>>(
    sql`SELECT m.date, m.kind, m.subkind, m.ref_id,
          CASE WHEN m.kind IN ('receipt', 'expense') THEN m.ref_no END AS ref_no,
          ${partySql} AS party, m.amount, m.cash_session_id
        FROM money_movement m
        WHERE m.account_id = ${o.accountId} AND m.date BETWEEN ${o.from} AND ${o.to}
        ORDER BY m.date, m.created_at, m.ref_id, m.kind
        LIMIT 5000`,
  );
  const opening = open?.n ?? 0;
  let bal = opening;
  let inflow = 0;
  let outflow = 0;
  const rows = raw.map((x) => {
    bal += x.amount;
    if (x.amount > 0) inflow += x.amount;
    else outflow -= x.amount;
    return { ...x, balance: bal };
  });
  return {
    account,
    from: o.from,
    to: o.to,
    opening,
    rows,
    in: inflow,
    out: outflow,
    closing: bal,
  };
}

// ---- Registers -----------------------------------------------------------------------------------

export type ExpenseRegisterRow = {
  id: string;
  expense_no: string;
  date: string;
  category_id: string;
  category_code: string | null;
  category_name: string;
  category_name_ur: string | null;
  account_id: string;
  account_name: string;
  account_kind: string;
  amount: number;
  vendor: string | null;
  note: string | null;
  has_photo: number;
  voided: number;
  void_reason: string | null;
  created_by_name: string | null;
};

export async function expenseRegister(
  db: AppDb,
  o: {
    from: string;
    to: string;
    categoryId?: string | null;
    accountId?: string | null;
    includeVoid?: boolean;
    q?: string | null;
    limit?: number;
  },
): Promise<ExpenseRegisterRow[]> {
  const like = o.q ? `%${o.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  return db.all<ExpenseRegisterRow>(
    sql`SELECT e.id, e.expense_no, e.date, e.category_id, c.code AS category_code,
          c.name AS category_name, c.name_ur AS category_name_ur, e.account_id, a.name AS account_name,
          a.kind AS account_kind, e.amount, e.vendor, e.note, (e.receipt_key IS NOT NULL) AS has_photo,
          (e.voided_by IS NOT NULL) AS voided, e.void_reason,
          (SELECT name FROM "user" WHERE id = e.created_by) AS created_by_name
        FROM expense e JOIN expense_category c ON c.id = e.category_id JOIN account a ON a.id = e.account_id
        WHERE e.date BETWEEN ${o.from} AND ${o.to}
          ${o.categoryId ? sql`AND e.category_id = ${o.categoryId}` : sql``}
          ${o.accountId ? sql`AND e.account_id = ${o.accountId}` : sql``}
          ${o.includeVoid ? sql`` : sql`AND e.voided_by IS NULL`}
          ${like ? sql`AND (e.vendor LIKE ${like} ESCAPE '\\' OR e.note LIKE ${like} ESCAPE '\\' OR e.expense_no LIKE ${like} ESCAPE '\\')` : sql``}
        ORDER BY e.date DESC, e.expense_no DESC LIMIT ${Math.min(o.limit ?? 1000, 5000)}`,
  );
}

export type PayslipRow = {
  id: string;
  staff_id: string;
  staff_name: string;
  staff_role: string | null;
  staff_user_id: string | null;
  period_key: string;
  status: 'draft' | 'approved' | 'paid' | 'void';
  earnings: number;
  deductions: number;
  recovery: number;
  pay: number;
  net: number;
  paid: number;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  void_reason: string | null;
};

/**
 * Payslips (salary register). `excludeOwners` hides owners' slips (accountant scope, PLAN §5.4);
 * `staffId` narrows to one staff member (the teacher's "my payslips").
 */
export async function payslips(
  db: AppDb,
  o: {
    period?: string | null;
    from?: string | null;
    to?: string | null;
    staffId?: string | null;
    status?: string | null;
    excludeOwners?: boolean;
    ids?: string[];
  },
): Promise<PayslipRow[]> {
  return db.all<PayslipRow>(
    sql`SELECT n.id, n.staff_id, st.name AS staff_name, st.role AS staff_role, st.user_id AS staff_user_id,
          n.period_key, n.status, n.earnings, n.deductions, n.recovery, n.pay, n.net, n.paid,
          p.approved_by, (SELECT name FROM "user" WHERE id = p.approved_by) AS approved_by_name,
          p.approved_at, p.void_reason
        FROM payslip_net n JOIN payslip p ON p.id = n.id JOIN staff st ON st.id = n.staff_id
        WHERE 1
          ${o.period ? sql`AND n.period_key = ${o.period}` : sql``}
          ${o.from ? sql`AND n.period_key >= ${o.from}` : sql``}
          ${o.to ? sql`AND n.period_key <= ${o.to}` : sql``}
          ${o.staffId ? sql`AND n.staff_id = ${o.staffId}` : sql``}
          ${o.status ? sql`AND n.status = ${o.status}` : sql``}
          ${o.ids ? sql`AND n.id IN (SELECT value FROM json_each(${JSON.stringify(o.ids)}))` : sql``}
          ${o.excludeOwners ? excludeOwnersSql(sql`st.user_id`) : sql``}
        ORDER BY n.period_key DESC, st.name, n.id LIMIT 2000`,
  );
}

/** Staff whose user holds the owner role are hidden from the accountant's payroll (PLAN §5.4). */
export const excludeOwnersSql = (userCol: SQL): SQL =>
  sql`AND NOT EXISTS (SELECT 1 FROM role ro WHERE ro.user_id = ${userCol} AND ro.role = 'owner')`;

export type PayslipDetail = PayslipRow & {
  lines: { id: string; kind: string; amount: number; note: string | null }[];
  payments: {
    id: string;
    amount: number;
    account_id: string;
    account_name: string;
    date: string;
    note: string | null;
    cash_session_id: string | null;
  }[];
  advance: { advanced: number; recovered: number; outstanding: number };
};

export async function payslipDetail(db: AppDb, id: string): Promise<PayslipDetail | null> {
  const [row] = await payslips(db, { ids: [id] });
  if (!row) return null;
  const lines = await db.all<PayslipDetail['lines'][number]>(
    sql`SELECT id, kind, amount, note FROM payslip_line WHERE payslip_id = ${id}
        ORDER BY CASE kind WHEN 'basic' THEN 0 WHEN 'allowance' THEN 1 WHEN 'deduction' THEN 2 ELSE 3 END,
                 created_at, id`,
  );
  const payments = await db.all<PayslipDetail['payments'][number]>(
    sql`SELECT sp.id, sp.amount, sp.account_id, a.name AS account_name, sp.date, sp.note, sp.cash_session_id
        FROM salary_payment sp JOIN account a ON a.id = sp.account_id
        WHERE sp.payslip_id = ${id} ORDER BY sp.date, sp.created_at`,
  );
  const [adv] = await db.all<PayslipDetail['advance']>(
    sql`SELECT advanced, recovered, outstanding FROM advance_balance WHERE staff_id = ${row.staff_id}`,
  );
  return {
    ...row,
    lines,
    payments,
    advance: adv ?? { advanced: 0, recovered: 0, outstanding: 0 },
  };
}

export type AdvanceRegisterRow = {
  staff_id: string;
  staff_name: string;
  advanced: number;
  recovered: number;
  outstanding: number;
  last_advance: string | null;
};

export type AdvanceRow = {
  id: string;
  staff_id: string;
  staff_name: string;
  amount: number;
  account_id: string;
  account_name: string;
  date: string;
  note: string | null;
};

export async function advanceRegister(
  db: AppDb,
  o: { staffId?: string | null; excludeOwners?: boolean } = {},
): Promise<{ balances: AdvanceRegisterRow[]; advances: AdvanceRow[] }> {
  const balances = await db.all<AdvanceRegisterRow>(
    sql`SELECT b.staff_id, st.name AS staff_name, b.advanced, b.recovered, b.outstanding,
          (SELECT max(date) FROM staff_advance WHERE staff_id = b.staff_id) AS last_advance
        FROM advance_balance b JOIN staff st ON st.id = b.staff_id
        WHERE b.advanced > 0
          ${o.staffId ? sql`AND b.staff_id = ${o.staffId}` : sql``}
          ${o.excludeOwners ? excludeOwnersSql(sql`st.user_id`) : sql``}
        ORDER BY b.outstanding DESC, st.name`,
  );
  const advances = await db.all<AdvanceRow>(
    sql`SELECT a.id, a.staff_id, st.name AS staff_name, a.amount, a.account_id, ac.name AS account_name,
          a.date, a.note
        FROM staff_advance a JOIN staff st ON st.id = a.staff_id JOIN account ac ON ac.id = a.account_id
        WHERE 1
          ${o.staffId ? sql`AND a.staff_id = ${o.staffId}` : sql``}
          ${o.excludeOwners ? excludeOwnersSql(sql`st.user_id`) : sql``}
        ORDER BY a.date DESC, a.created_at DESC LIMIT 1000`,
  );
  return { balances, advances };
}

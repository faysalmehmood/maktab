import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import type { PAYSLIP_LINE_KINDS } from '../schema';
import { assertSessionOpen, ensureSessionStatement, sessionIdFor } from './cash';
import { seriesFor } from './collect';
import { bumpSeries, ensureSeries } from './index';
import { assertPeriod, auditStatement, DATE_RE, FeeError, karachiToday, runBatch } from './util';

/**
 * Money out (PLAN §14.6, §14.8): expenses, payslips, salary payments and staff advances. Each user
 * action is ONE batch; sql/60_money_out.sql (and 20_append_only.sql) refuse anything else.
 *
 * Paid from a drawer (an account of kind `cash`): today only, out of the payer's own cash session for
 * today (opened if there is none; refused if it is closed), so the drawer's expected cash at closing
 * subtracts it. Paid from a bank or wallet: the account is named and no session is touched; the date
 * may be earlier (the bill was paid by transfer last week) but never in the future.
 */

export const EXPENSE_SERIES = 'EXP';

export type PayslipLineKind = (typeof PAYSLIP_LINE_KINDS)[number];
export type PayslipLineInput = { kind: PayslipLineKind; amount: number; note?: string | null };

const LINE_KINDS: readonly string[] = ['basic', 'allowance', 'deduction', 'advance_recovery'];

function assertMoney(amount: number, field = 'amount'): void {
  if (!Number.isInteger(amount) || amount <= 0)
    throw new FeeError('invalid', `${field}: paisa > 0`, 400);
}

type AccountRow = { id: string; kind: 'cash' | 'bank' | 'wallet'; name: string };

async function accountFor(db: AppDb, accountId: string | null | undefined): Promise<AccountRow> {
  if (!accountId)
    throw new FeeError('account_required', 'Choose the account (or drawer) the money left', 400);
  const [a] = await db.all<AccountRow>(
    sql`SELECT id, kind, name FROM account WHERE id = ${accountId}`,
  );
  if (!a) throw new FeeError('invalid', 'Unknown account', 400);
  return a;
}

/**
 * The date rule and the drawer prelude for money paid out. Returns the statements that open the
 * payer's session (cash only) and the SQL resolving its id inside the batch.
 */
async function moneyOut(
  db: AppDb,
  o: { account: AccountRow; date: string; today: string; by: string },
): Promise<{ prelude: SQL[]; sessionId: SQL | null }> {
  if (!DATE_RE.test(o.date)) throw new FeeError('bad_business_date', 'date: YYYY-MM-DD', 400);
  if (o.date > o.today) throw new FeeError('bad_business_date', 'date: in the future', 400);
  if (o.account.kind !== 'cash') return { prelude: [], sessionId: null };
  if (o.date !== o.today)
    throw new FeeError(
      'bad_business_date',
      'Cash cannot be backdated: it leaves today’s drawer',
      400,
    );
  await assertSessionOpen(db, o.by, o.today);
  return {
    prelude: [ensureSessionStatement(o.by, o.today)],
    sessionId: sessionIdFor(o.by, o.today),
  };
}

// ---- Expenses ----------------------------------------------------------------------------------

export type RecordExpenseInput = {
  id?: string;
  categoryId: string;
  amount: number;
  accountId: string | null | undefined;
  /** Default today. */
  date?: string;
  vendor?: string | null;
  note?: string | null;
  receiptKey?: string | null;
  by: string;
  today?: string;
};

export type ExpenseRow = {
  id: string;
  expense_no: string;
  category_id: string;
  category_code: string | null;
  category_name: string;
  category_name_ur: string | null;
  account_id: string;
  account_name: string;
  account_kind: string;
  cash_session_id: string | null;
  amount: number;
  vendor: string | null;
  date: string;
  note: string | null;
  receipt_key: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: string;
};

const expenseSelect = sql`SELECT e.id, e.expense_no, e.category_id, c.code AS category_code,
  c.name AS category_name, c.name_ur AS category_name_ur, e.account_id, a.name AS account_name,
  a.kind AS account_kind, e.cash_session_id, e.amount, e.vendor, e.date, e.note, e.receipt_key,
  e.voided_by, e.void_reason, e.created_by, e.created_at
  FROM expense e JOIN expense_category c ON c.id = e.category_id JOIN account a ON a.id = e.account_id`;

export async function expenseById(db: AppDb, id: string): Promise<ExpenseRow | null> {
  const [row] = await db.all<ExpenseRow>(sql`${expenseSelect} WHERE e.id = ${id}`);
  return row ?? null;
}

/**
 * One batch: EXP series row (first use) → drawer session (cash) → series bump → numbered expense
 * (`EXP-YYYY-NNNNN`) → audit with the number read back. A retried request with the same id returns
 * the expense it created.
 */
export async function recordExpense(
  db: AppDb,
  input: RecordExpenseInput,
): Promise<{ id: string; expense_no: string; replayed: boolean }> {
  assertMoney(input.amount);
  const id = input.id ?? newId();
  const prior = await expenseById(db, id);
  if (prior) {
    if (prior.created_by !== input.by || prior.amount !== input.amount)
      throw new FeeError('idempotency_conflict', 'This id was already used for another expense');
    return { id, expense_no: prior.expense_no, replayed: true };
  }
  const [cat] = await db.all<{ system: number; deleted_at: string | null }>(
    sql`SELECT system, deleted_at FROM expense_category WHERE id = ${input.categoryId}`,
  );
  if (!cat || cat.deleted_at) throw new FeeError('invalid', 'Unknown expense category', 400);
  if (cat.system)
    throw new FeeError('category_reserved', 'Salaries are recorded as payslips, not expenses', 400);
  const account = await accountFor(db, input.accountId);
  const today = input.today ?? karachiToday();
  const date = input.date ?? today;
  const { prelude, sessionId } = await moneyOut(db, { account, date, today, by: input.by });
  const series = seriesFor(EXPENSE_SERIES, date, today);
  await runBatch(db, [
    ensureSeries(series),
    ...prelude,
    bumpSeries(series),
    sql`INSERT INTO expense (id, expense_no, category_id, account_id, cash_session_id, amount, vendor,
          date, note, receipt_key, created_by)
        VALUES (${id},
          (SELECT series || '-' || year || '-' || printf('%05d', next_no - 1) FROM receipt_series
           WHERE series = ${series.series} AND year = ${series.year}),
          ${input.categoryId}, ${account.id}, ${sessionId}, ${input.amount}, ${input.vendor ?? null},
          ${date}, ${input.note ?? null}, ${input.receiptKey ?? null}, ${input.by})`,
    sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
        SELECT ${newId()}, ${input.by}, 'expense', id, 'create',
               json_object('before', NULL, 'after', json_object('expense_no', expense_no,
                 'category_id', category_id, 'account_id', account_id, 'cash_session_id', cash_session_id,
                 'amount', amount, 'vendor', vendor, 'date', date, 'note', note))
        FROM expense WHERE id = ${id}`,
  ]);
  const row = await expenseById(db, id);
  if (!row) throw new Error('expense not written');
  return { id, expense_no: row.expense_no, replayed: false };
}

/** Void with a reason (never edited, never deleted; triggers). */
export async function voidExpense(
  db: AppDb,
  input: { id: string; reason: string; by: string },
): Promise<ExpenseRow> {
  const reason = input.reason.trim().replace(/\s+/g, ' ');
  if (!reason) throw new FeeError('invalid', 'reason: required', 400);
  const e = await expenseById(db, input.id);
  if (!e) throw new FeeError('not_found', 'Expense not found', 404);
  if (e.voided_by) throw new FeeError('already_void', 'This expense is already void');
  await runBatch(db, [
    sql`UPDATE expense SET voided_by = ${input.by}, void_reason = ${reason}
        WHERE id = ${input.id} AND voided_by IS NULL`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'expense',
      entityId: input.id,
      action: 'void',
      diff: {
        before: { voided_by: null, void_reason: null },
        after: { voided_by: input.by, void_reason: reason, expense_no: e.expense_no },
      },
    }),
  ]);
  const after = await expenseById(db, input.id);
  if (!after) throw new FeeError('not_found', 'Expense not found', 404);
  return after;
}

/** Attach (or replace) the bill photo key; the photo is not money, so this is an ordinary update. */
export async function setExpensePhoto(
  db: AppDb,
  input: { id: string; key: string; by: string },
): Promise<string | null> {
  const e = await expenseById(db, input.id);
  if (!e) throw new FeeError('not_found', 'Expense not found', 404);
  await runBatch(db, [
    sql`UPDATE expense SET receipt_key = ${input.key} WHERE id = ${input.id}`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'expense',
      entityId: input.id,
      action: 'photo',
      diff: { before: { receipt_key: e.receipt_key }, after: { receipt_key: input.key } },
    }),
  ]);
  return e.receipt_key;
}

// ---- Advances ----------------------------------------------------------------------------------

export type AdvanceBalance = {
  staff_id: string;
  advanced: number;
  recovered: number;
  outstanding: number;
};

/** Advanced − recovered through approved/paid payslips (derived; never stored). */
export async function outstandingAdvance(db: AppDb, staffId: string): Promise<AdvanceBalance> {
  const [row] = await db.all<AdvanceBalance>(
    sql`SELECT staff_id, advanced, recovered, outstanding FROM advance_balance WHERE staff_id = ${staffId}`,
  );
  return row ?? { staff_id: staffId, advanced: 0, recovered: 0, outstanding: 0 };
}

export async function recordAdvance(
  db: AppDb,
  input: {
    id?: string;
    staffId: string;
    amount: number;
    accountId: string | null | undefined;
    date?: string;
    note?: string | null;
    by: string;
    today?: string;
  },
): Promise<{ id: string; replayed: boolean }> {
  assertMoney(input.amount);
  const id = input.id ?? newId();
  const [prior] = await db.all<{ amount: number; created_by: string | null; staff_id: string }>(
    sql`SELECT amount, created_by, staff_id FROM staff_advance WHERE id = ${id}`,
  );
  if (prior) {
    if (
      prior.created_by !== input.by ||
      prior.amount !== input.amount ||
      prior.staff_id !== input.staffId
    )
      throw new FeeError('idempotency_conflict', 'This id was already used for another advance');
    return { id, replayed: true };
  }
  const [st] = await db.all<{ id: string }>(sql`SELECT id FROM staff WHERE id = ${input.staffId}`);
  if (!st) throw new FeeError('not_found', 'Staff member not found', 404);
  const account = await accountFor(db, input.accountId);
  const today = input.today ?? karachiToday();
  const date = input.date ?? today;
  const { prelude, sessionId } = await moneyOut(db, { account, date, today, by: input.by });
  await runBatch(db, [
    ...prelude,
    sql`INSERT INTO staff_advance (id, staff_id, amount, account_id, cash_session_id, date, note, created_by)
        VALUES (${id}, ${input.staffId}, ${input.amount}, ${account.id}, ${sessionId}, ${date},
                ${input.note ?? null}, ${input.by})`,
    sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
        SELECT ${newId()}, ${input.by}, 'staff_advance', id, 'create',
               json_object('before', NULL, 'after', json_object('staff_id', staff_id, 'amount', amount,
                 'account_id', account_id, 'cash_session_id', cash_session_id, 'date', date, 'note', note))
        FROM staff_advance WHERE id = ${id}`,
  ]);
  return { id, replayed: false };
}

// ---- Payslips ----------------------------------------------------------------------------------

export type Allowance = { label: string; amount: number };

/** staff.allowances JSON → valid rows only (label + paisa > 0). */
export function parseAllowances(raw: unknown): Allowance[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (a): a is Allowance =>
        !!a &&
        typeof a.label === 'string' &&
        a.label.trim() !== '' &&
        Number.isInteger(a.amount) &&
        a.amount > 0,
    )
    .map((a) => ({ label: a.label.trim(), amount: a.amount }));
}

export type PayslipTotals = {
  earnings: number;
  deductions: number;
  recovery: number;
  /** earnings − deductions: the salary expense. */
  pay: number;
  /** pay − advance recovery: what is paid out. */
  net: number;
};

export function payslipTotals(lines: readonly { kind: string; amount: number }[]): PayslipTotals {
  let earnings = 0;
  let deductions = 0;
  let recovery = 0;
  for (const l of lines) {
    if (l.kind === 'basic' || l.kind === 'allowance') earnings += l.amount;
    else if (l.kind === 'deduction') deductions += l.amount;
    else if (l.kind === 'advance_recovery') recovery += l.amount;
  }
  return {
    earnings,
    deductions,
    recovery,
    pay: earnings - deductions,
    net: earnings - deductions - recovery,
  };
}

/**
 * Suggested recovery = min(outstanding advance, pct of the slip's pay), in whole rupees, never more
 * than the pay itself.
 */
export function suggestedRecovery(outstanding: number, pay: number, pct: number): number {
  if (outstanding <= 0 || pay <= 0 || pct <= 0) return 0;
  const cap = Math.floor((pay * Math.min(pct, 100)) / 100 / 100) * 100;
  return Math.max(0, Math.min(outstanding, cap, pay));
}

/** The lines a new payslip starts with: basic, each allowance, and the suggested recovery. */
export function defaultLines(o: {
  baseSalary: number | null;
  allowances: Allowance[];
  outstanding: number;
  pct: number;
}): PayslipLineInput[] {
  const lines: PayslipLineInput[] = [];
  if (o.baseSalary && o.baseSalary > 0) lines.push({ kind: 'basic', amount: o.baseSalary });
  for (const a of o.allowances) lines.push({ kind: 'allowance', amount: a.amount, note: a.label });
  const pay = payslipTotals(lines).pay;
  const rec = suggestedRecovery(o.outstanding, pay, o.pct);
  if (rec > 0) lines.push({ kind: 'advance_recovery', amount: rec, note: null });
  return lines;
}

function checkLines(lines: readonly PayslipLineInput[]): void {
  for (const l of lines) {
    if (!LINE_KINDS.includes(l.kind)) throw new FeeError('invalid', 'line kind', 400);
    assertMoney(l.amount, 'line amount');
  }
  if (payslipTotals(lines).net < 0)
    throw new FeeError('negative_net', 'Deductions and recovery exceed the pay', 400);
}

async function recoveryPct(db: AppDb): Promise<number> {
  const [row] = await db.all<{ pct: number }>(
    sql`SELECT advance_recovery_pct AS pct FROM school ORDER BY created_at LIMIT 1`,
  );
  return row?.pct ?? 25;
}

/** Outstanding advance per staff member, less recovery already planned on their other drafts. */
async function availableAdvance(
  db: AppDb,
  staffIds: readonly string[],
): Promise<Map<string, number>> {
  if (!staffIds.length) return new Map();
  const rows = await db.all<{ staff_id: string; n: number }>(
    sql`SELECT b.staff_id, b.outstanding - coalesce((SELECT sum(l.amount) FROM payslip_line l
          JOIN payslip p ON p.id = l.payslip_id
          WHERE p.staff_id = b.staff_id AND p.status = 'draft' AND l.kind = 'advance_recovery'), 0) AS n
        FROM advance_balance b
        WHERE b.staff_id IN (SELECT value FROM json_each(${JSON.stringify(staffIds)}))`,
  );
  return new Map(rows.map((r) => [r.staff_id, Math.max(0, r.n)]));
}

const lineRows = (payslipId: string, lines: readonly PayslipLineInput[]) =>
  lines.map((l) => ({
    id: newId(),
    payslip_id: payslipId,
    kind: l.kind,
    amount: l.amount,
    note: l.note ?? null,
  }));

const insertLinesSql = (rows: ReturnType<typeof lineRows>, by: string): SQL =>
  sql`INSERT INTO payslip_line (id, payslip_id, kind, amount, note, created_by)
      SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.payslip_id'), json_extract(j.value, '$.kind'), json_extract(j.value, '$.amount'),
             json_extract(j.value, '$.note'), ${by}
      FROM json_each(${JSON.stringify(rows)}) j`;

type StaffPayRow = {
  id: string;
  name: string;
  user_id: string | null;
  base_salary: number | null;
  allowances: string | null;
};

/**
 * A draft payslip for one staff member and period. Without `lines`, it starts from the staff
 * record (basic + allowances) and the suggested advance recovery.
 */
export async function createPayslip(
  db: AppDb,
  input: {
    id?: string;
    staffId: string;
    periodKey: string;
    lines?: PayslipLineInput[];
    by: string;
  },
): Promise<{ id: string }> {
  assertPeriod(input.periodKey);
  const [st] = await db.all<StaffPayRow>(
    sql`SELECT id, name, user_id, base_salary, allowances FROM staff WHERE id = ${input.staffId}`,
  );
  if (!st) throw new FeeError('not_found', 'Staff member not found', 404);
  const [dup] = await db.all<{ id: string }>(
    sql`SELECT id FROM payslip WHERE staff_id = ${input.staffId} AND period_key = ${input.periodKey}`,
  );
  if (dup) throw new FeeError('already_exists', 'A payslip for this month already exists');
  let lines = input.lines;
  if (!lines) {
    const avail = (await availableAdvance(db, [st.id])).get(st.id) ?? 0;
    lines = defaultLines({
      baseSalary: st.base_salary,
      allowances: parseAllowances(st.allowances),
      outstanding: avail,
      pct: await recoveryPct(db),
    });
  }
  checkLines(lines);
  const id = input.id ?? newId();
  await runBatch(db, [
    sql`INSERT INTO payslip (id, staff_id, period_key, status, created_by)
        VALUES (${id}, ${input.staffId}, ${input.periodKey}, 'draft', ${input.by})`,
    ...(lines.length ? [insertLinesSql(lineRows(id, lines), input.by)] : []),
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'payslip',
      entityId: id,
      action: 'create',
      diff: {
        before: null,
        after: { staff_id: input.staffId, period_key: input.periodKey, lines },
      },
    }),
  ]);
  return { id };
}

export const PAYSLIP_CHUNK = 50;

/**
 * Drafts for every active staff member on the payroll (base salary set) with no slip for the period,
 * at most PAYSLIP_CHUNK per call (the client loops on `next`, PLAN §15 budget). Two statements
 * through json_each, whatever the chunk size.
 */
export async function generatePayslips(
  db: AppDb,
  input: {
    periodKey: string;
    by: string;
    after?: string | null;
    limit?: number;
    /** Accountant scope: never prepare an owner's slip (PLAN §5.4). */
    excludeOwners?: boolean;
  },
): Promise<{ created: number; skipped: number; next: string | null }> {
  assertPeriod(input.periodKey);
  const limit = Math.min(Math.max(1, input.limit ?? PAYSLIP_CHUNK), PAYSLIP_CHUNK);
  const staff = await db.all<StaffPayRow & { has_slip: number }>(
    sql`SELECT s.id, s.name, s.user_id, s.base_salary, s.allowances,
          EXISTS (SELECT 1 FROM payslip p WHERE p.staff_id = s.id AND p.period_key = ${input.periodKey}) AS has_slip
        FROM staff s
        WHERE s.status = 'active' AND s.base_salary IS NOT NULL AND s.base_salary > 0
          AND s.id > ${input.after ?? ''}
          ${input.excludeOwners ? sql`AND NOT EXISTS (SELECT 1 FROM role ro WHERE ro.user_id = s.user_id AND ro.role = 'owner')` : sql``}
        ORDER BY s.id LIMIT ${limit + 1}`,
  );
  const page = staff.slice(0, limit);
  const next = staff.length > limit ? (page.at(-1)?.id ?? null) : null;
  const todo = page.filter((s) => !s.has_slip);
  if (!todo.length) return { created: 0, skipped: page.length, next };
  const avail = await availableAdvance(
    db,
    todo.map((s) => s.id),
  );
  const pct = await recoveryPct(db);
  const slips = todo.map((s) => ({ id: newId(), staff_id: s.id }));
  const lines = todo.flatMap((s, i) =>
    lineRows(
      slips[i]?.id ?? '',
      defaultLines({
        baseSalary: s.base_salary,
        allowances: parseAllowances(s.allowances),
        outstanding: avail.get(s.id) ?? 0,
        pct,
      }),
    ),
  );
  await runBatch(db, [
    // A slip created meanwhile (another tab) is skipped here; its lines' payslip is then missing, so
    // the line insert below only takes lines whose slip this statement created.
    sql`INSERT INTO payslip (id, staff_id, period_key, status, created_by)
        SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.staff_id'), ${input.periodKey}, 'draft', ${input.by}
        FROM json_each(${JSON.stringify(slips)}) j
        WHERE NOT EXISTS (SELECT 1 FROM payslip p WHERE p.staff_id = json_extract(j.value, '$.staff_id')
                          AND p.period_key = ${input.periodKey})`,
    sql`INSERT INTO payslip_line (id, payslip_id, kind, amount, note, created_by)
        SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.payslip_id'), json_extract(j.value, '$.kind'), json_extract(j.value, '$.amount'),
               json_extract(j.value, '$.note'), ${input.by}
        FROM json_each(${JSON.stringify(lines)}) j
        WHERE EXISTS (SELECT 1 FROM payslip p WHERE p.id = json_extract(j.value, '$.payslip_id'))`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'payslip_run',
      entityId: input.periodKey,
      action: 'generate',
      diff: { before: null, after: { period_key: input.periodKey, slips } },
    }),
  ]);
  const [made] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM payslip WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(${JSON.stringify(slips)}))`,
  );
  const created = made?.n ?? 0;
  return { created, skipped: page.length - created, next };
}

type SlipState = {
  id: string;
  staff_id: string;
  staff_user_id: string | null;
  period_key: string;
  status: 'draft' | 'approved' | 'paid' | 'void';
  net: number;
  paid: number;
  recovery: number;
};

async function slipState(db: AppDb, id: string): Promise<SlipState> {
  const [s] = await db.all<SlipState>(
    sql`SELECT n.id, n.staff_id, st.user_id AS staff_user_id, n.period_key, n.status, n.net, n.paid,
          n.recovery
        FROM payslip_net n JOIN staff st ON st.id = n.staff_id WHERE n.id = ${id}`,
  );
  if (!s) throw new FeeError('not_found', 'Payslip not found', 404);
  return s;
}

/** Replaces a draft's lines (deductions, a changed recovery). Lines freeze at approval (trigger). */
export async function setPayslipLines(
  db: AppDb,
  input: { id: string; lines: PayslipLineInput[]; by: string },
): Promise<void> {
  const s = await slipState(db, input.id);
  if (s.status !== 'draft') throw new FeeError('not_draft', 'Only a draft payslip can be changed');
  checkLines(input.lines);
  const before = await db.all<{ kind: string; amount: number; note: string | null }>(
    sql`SELECT kind, amount, note FROM payslip_line WHERE payslip_id = ${input.id} ORDER BY created_at, id`,
  );
  await runBatch(db, [
    sql`DELETE FROM payslip_line WHERE payslip_id = ${input.id}`,
    ...(input.lines.length ? [insertLinesSql(lineRows(input.id, input.lines), input.by)] : []),
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'payslip',
      entityId: input.id,
      action: 'lines',
      diff: { before: { lines: before }, after: { lines: input.lines } },
    }),
  ]);
}

/**
 * Owner/admin approval (maker-checker). Never by the staff member themself; recovery within the
 * outstanding advance; net ≥ 0 (triggers are the backstop for each).
 */
export async function approvePayslip(
  db: AppDb,
  input: { id: string; by: string; now?: string },
): Promise<void> {
  const s = await slipState(db, input.id);
  if (s.status !== 'draft') throw new FeeError('not_draft', 'Only a draft payslip can be approved');
  if (s.staff_user_id && s.staff_user_id === input.by)
    throw new FeeError('own_payslip', 'Someone else must approve your own payslip', 403);
  if (s.net < 0) throw new FeeError('negative_net', 'Deductions and recovery exceed the pay');
  const bal = await outstandingAdvance(db, s.staff_id);
  if (s.recovery > bal.outstanding)
    throw new FeeError(
      'recovery_exceeds_advance',
      'Advance recovery is more than the advance still outstanding',
    );
  const now = input.now ?? new Date().toISOString();
  await runBatch(db, [
    sql`UPDATE payslip SET status = 'approved', approved_by = ${input.by}, approved_at = ${now}
        WHERE id = ${input.id} AND status = 'draft'`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'payslip',
      entityId: input.id,
      action: 'approve',
      diff: { before: { status: 'draft' }, after: { status: 'approved', net: s.net } },
    }),
  ]);
}

/**
 * Pays (part of) an approved slip. Several payments are allowed up to the net (trigger); the slip
 * becomes `paid` in the same batch once the net is reached.
 */
export async function paySalary(
  db: AppDb,
  input: {
    id?: string;
    payslipId: string;
    amount: number;
    accountId: string | null | undefined;
    date?: string;
    note?: string | null;
    by: string;
    today?: string;
  },
): Promise<{ id: string; replayed: boolean; status: string }> {
  assertMoney(input.amount);
  const id = input.id ?? newId();
  const [prior] = await db.all<{ amount: number; created_by: string | null; payslip_id: string }>(
    sql`SELECT amount, created_by, payslip_id FROM salary_payment WHERE id = ${id}`,
  );
  if (prior) {
    if (
      prior.created_by !== input.by ||
      prior.amount !== input.amount ||
      prior.payslip_id !== input.payslipId
    )
      throw new FeeError('idempotency_conflict', 'This id was already used for another payment');
    const s = await slipState(db, input.payslipId);
    return { id, replayed: true, status: s.status };
  }
  const s = await slipState(db, input.payslipId);
  if (s.status === 'draft') throw new FeeError('not_approved', 'Approve the payslip first');
  if (s.status === 'void') throw new FeeError('not_payable', 'This payslip is void');
  if (s.status === 'paid') throw new FeeError('already_paid', 'This payslip is fully paid');
  if (input.amount > s.net - s.paid)
    throw new FeeError('exceeds_net', 'More than what is left to pay on this payslip');
  const account = await accountFor(db, input.accountId);
  const today = input.today ?? karachiToday();
  const date = input.date ?? today;
  const { prelude, sessionId } = await moneyOut(db, { account, date, today, by: input.by });
  await runBatch(db, [
    ...prelude,
    sql`INSERT INTO salary_payment (id, payslip_id, amount, account_id, cash_session_id, date, note, created_by)
        VALUES (${id}, ${input.payslipId}, ${input.amount}, ${account.id}, ${sessionId}, ${date},
                ${input.note ?? null}, ${input.by})`,
    sql`UPDATE payslip SET status = 'paid'
        WHERE id = ${input.payslipId} AND status = 'approved'
          AND (SELECT paid FROM payslip_net WHERE id = ${input.payslipId})
            >= (SELECT net FROM payslip_net WHERE id = ${input.payslipId})`,
    sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
        SELECT ${newId()}, ${input.by}, 'payslip', ${input.payslipId}, 'pay',
               json_object('before', NULL, 'after', json_object('payment_id', sp.id, 'amount', sp.amount,
                 'account_id', sp.account_id, 'cash_session_id', sp.cash_session_id, 'date', sp.date))
        FROM salary_payment sp WHERE sp.id = ${id}`,
  ]);
  const after = await slipState(db, input.payslipId);
  return { id, replayed: false, status: after.status };
}

/** A slip that will never be paid: draft or approved, nothing paid yet; reason required. */
export async function voidPayslip(
  db: AppDb,
  input: { id: string; reason: string; by: string },
): Promise<void> {
  const reason = input.reason.trim().replace(/\s+/g, ' ');
  if (!reason) throw new FeeError('invalid', 'reason: required', 400);
  const s = await slipState(db, input.id);
  if (s.status === 'void') throw new FeeError('already_void', 'This payslip is already void');
  if (s.status === 'paid' || s.paid > 0)
    throw new FeeError('not_voidable', 'A payslip with salary paid cannot be voided');
  await runBatch(db, [
    sql`UPDATE payslip SET status = 'void', voided_by = ${input.by}, void_reason = ${reason}
        WHERE id = ${input.id} AND status IN ('draft', 'approved')`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'payslip',
      entityId: input.id,
      action: 'void',
      diff: { before: { status: s.status }, after: { status: 'void', reason } },
    }),
  ]);
}

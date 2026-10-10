import {
  type AppDb,
  accountBalances,
  advanceRegister,
  approvePayslip,
  cashbook,
  createPayslip,
  defaulters,
  type ExpenseRegisterRow,
  excludeOwnersSql,
  expenseById,
  expenseRegister,
  generatePayslips,
  incomeExpense,
  type PayslipRow,
  parseAllowances,
  paySalary,
  payslipDetail,
  payslips,
  periodEnd,
  periodStart,
  recordAdvance,
  recordExpense,
  setExpensePhoto,
  setPayslipLines,
  voidExpense,
  voidPayslip,
} from '@maktab/db';
import {
  type AccountBalanceDto,
  type AdvanceListDto,
  type AuditListDto,
  type AuditRowDto,
  advanceInputSchema,
  auditQuerySchema,
  balancesQuerySchema,
  type CashbookDto,
  cashbookQuerySchema,
  dashboardMonthQuerySchema,
  type ExpenseCategoryDto,
  type ExpenseDto,
  type ExpenseListDto,
  expenseInputSchema,
  expenseQuerySchema,
  type GeneratePayslipsDto,
  type IncomeExpenseDto,
  MAX_PHOTO_BYTES,
  type MonthDashboardDto,
  monthRangeQuerySchema,
  newId,
  type PayrollStaffDto,
  type PayslipDetailDto,
  type PayslipDto,
  type PayslipListDto,
  payslipCreateSchema,
  payslipGenerateSchema,
  payslipLinesSchema,
  payslipQuerySchema,
  salaryPaymentSchema,
  staffPaySchema,
  toCsvLine,
  voidReasonSchema,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { principalRoles } from '../auth/principal';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { bucket, deleteReplaced, readImageUpload, serveObject } from '../lib/files';
import { idParam, jsonBody, notFoundError, queryParams, todayPk, userId } from '../lib/http';
import { auditSql, changed, tx } from '../lib/tx';
import { decide } from '../perm/matrix';
import { defineRoute, type RouteTable, requires } from '../perm/routes';

/**
 * Milestone 4 (PLAN §14.8, §14.11): expenses, payroll (payslips, salary payments, advances), the
 * money reports, the audit trail and the month dashboard. Writes go through the ledger helpers in
 * @maktab/db (one batch each); this file validates, scopes and shapes.
 *
 * Payroll scope (PLAN §5.4) comes from the caller's `payslip.read` grant, whatever route they are on:
 *   all               every slip
 *   all_except_owner  (accountant) never a slip, advance or salary of a staff member who is an owner
 *   own_only          (teacher) their own approved/paid slips, via GET /api/payslips/mine only
 */

const rupees = (paisa: number) => paisa / 100;

function csv(c: Context<AppEnv>, name: string, head: string[], rows: (string | number | null)[][]) {
  const lines = [toCsvLine(head), ...rows.map((r) => toCsvLine(r))];
  return c.body(`﻿${lines.join('\r\n')}\r\n`, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${name.replace(/[^\w.-]+/g, '_')}"`,
  });
}

type PayrollScope = { kind: 'all' } | { kind: 'no_owner' } | { kind: 'own'; userId: string };

function payrollScope(c: Context<AppEnv>): PayrollScope {
  const p = c.get('principal');
  if (!p) throw new ApiError(401, 'unauthenticated', 'Sign in first');
  const grant = decide(principalRoles(p), { resource: 'payslip', action: 'read' });
  if (grant === 'all') return { kind: 'all' };
  if (grant === 'all_except_owner') return { kind: 'no_owner' };
  if (grant === 'own_only') return { kind: 'own', userId: p.user.id };
  throw new ApiError(403, 'forbidden', 'You do not have access to this');
}

/** The office payroll lists: an own-only grant (teacher) uses /api/payslips/mine instead. */
function officeScope(c: Context<AppEnv>): { excludeOwners: boolean } {
  const s = payrollScope(c);
  if (s.kind === 'own') throw new ApiError(403, 'forbidden', 'You can see only your own payslips');
  return { excludeOwners: s.kind === 'no_owner' };
}

/** 404 (not 403: existence is not leaked) when the slip's staff member is outside the caller's scope. */
async function staffInScope(c: Context<AppEnv>, staffId: string): Promise<void> {
  const s = payrollScope(c);
  if (s.kind === 'all') return;
  const db = c.get('db');
  const [row] = await db.all<{ user_id: string | null; owner: number }>(
    sql`SELECT st.user_id, EXISTS (SELECT 1 FROM role r WHERE r.user_id = st.user_id AND r.role = 'owner') AS owner
        FROM staff st WHERE st.id = ${staffId}`,
  );
  if (!row) throw notFoundError('Staff member');
  if (s.kind === 'no_owner' && row.owner) throw notFoundError('Payslip');
  if (s.kind === 'own' && row.user_id !== s.userId) throw notFoundError('Payslip');
}

const slipDto = (r: PayslipRow): PayslipDto => ({
  id: r.id,
  staff_id: r.staff_id,
  staff_name: r.staff_name,
  staff_role: r.staff_role,
  period_key: r.period_key,
  status: r.status,
  earnings: r.earnings,
  deductions: r.deductions,
  recovery: r.recovery,
  pay: r.pay,
  net: r.net,
  paid: r.paid,
  approved_by_name: r.approved_by_name,
  approved_at: r.approved_at,
  void_reason: r.void_reason,
});

async function schoolHeader(db: AppDb): Promise<PayslipDetailDto['school']> {
  const [s] = await db.all<PayslipDetailDto['school']>(
    sql`SELECT name, name_ur, address, phone FROM school ORDER BY created_at LIMIT 1`,
  );
  return s ?? { name: '', name_ur: null, address: null, phone: null };
}

async function slipDetailDto(c: Context<AppEnv>, id: string): Promise<PayslipDetailDto> {
  const db = c.get('db');
  const d = await payslipDetail(db, id);
  if (!d) throw notFoundError('Payslip');
  const p = c.get('principal');
  const roles = p ? principalRoles(p) : [];
  return {
    ...slipDto(d),
    lines: d.lines as PayslipDetailDto['lines'],
    payments: d.payments.map(({ cash_session_id: _s, ...x }) => x),
    advance: d.advance,
    can_approve:
      d.status === 'draft' &&
      decide(roles, { resource: 'payslip', action: 'approve' }) !== false &&
      d.staff_user_id !== p?.user.id,
    school: await schoolHeader(db),
  };
}

const expenseDto = (r: ExpenseRegisterRow): ExpenseDto => ({
  id: r.id,
  expense_no: r.expense_no,
  date: r.date,
  category_id: r.category_id,
  category_code: r.category_code,
  category_name: r.category_name,
  category_name_ur: r.category_name_ur,
  account_id: r.account_id,
  account_name: r.account_name,
  account_kind: r.account_kind,
  amount: r.amount,
  vendor: r.vendor,
  note: r.note,
  has_photo: !!r.has_photo,
  voided: !!r.voided,
  void_reason: r.void_reason,
  created_by_name: r.created_by_name,
});

async function oneExpense(db: AppDb, id: string): Promise<ExpenseDto> {
  const e = await expenseById(db, id);
  if (!e) throw notFoundError('Expense');
  const [row] = await expenseRegister(db, {
    from: e.date,
    to: e.date,
    includeVoid: true,
    q: e.expense_no,
  });
  if (!row) throw notFoundError('Expense');
  return expenseDto(row);
}

/** Month range for "this month" defaults. */
const thisMonth = () => todayPk().slice(0, 7);

export function moneyRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  // ---- expenses ----------------------------------------------------------------------------------

  defineRoute(
    app,
    table,
    {
      method: 'GET',
      path: '/api/expenses/categories',
      access: requires('expense', 'read'),
    },
    async (c) => {
      const rows = await c.get('db').all<Omit<ExpenseCategoryDto, 'system'> & { system: number }>(
        sql`SELECT id, code, name, name_ur, system FROM expense_category
            WHERE deleted_at IS NULL ORDER BY sort, name`,
      );
      return c.json({ categories: rows.map((r) => ({ ...r, system: !!r.system })) });
    },
  );

  const listExpenses = async (c: Context<AppEnv>) => {
    const q = queryParams(c, expenseQuerySchema);
    const to = q.to ?? todayPk();
    const from = q.from ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw new ApiError(400, 'invalid', 'from: after to');
    const rows = await expenseRegister(c.get('db'), {
      from,
      to,
      categoryId: q.category_id ?? null,
      accountId: q.account_id ?? null,
      includeVoid: q.include_void ?? false,
      q: q.q || null,
    });
    const expenses = rows.map(expenseDto);
    if (q.format === 'csv')
      return csv(
        c,
        `expenses-${from}-${to}.csv`,
        ['No', 'Date', 'Category', 'Paid from', 'Vendor', 'Note', 'Amount', 'Void reason'],
        expenses.map((e) => [
          e.expense_no,
          e.date,
          e.category_name,
          e.account_name,
          e.vendor,
          e.note,
          rupees(e.amount),
          e.voided ? e.void_reason : null,
        ]),
      );
    const body: ExpenseListDto = {
      expenses,
      total: expenses.filter((e) => !e.voided).reduce((a, e) => a + e.amount, 0),
      from,
      to,
    };
    return c.json(body);
  };

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/expenses', access: requires('expense', 'read') },
    listExpenses,
  );
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/reports/expenses', access: requires('expense', 'read') },
    listExpenses,
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/expenses', access: requires('expense', 'create') },
    async (c) => {
      const input = await jsonBody(c, expenseInputSchema);
      const db = c.get('db');
      const r = await recordExpense(db, {
        id: input.id ?? newId(),
        categoryId: input.category_id,
        amount: input.amount,
        accountId: input.account_id,
        date: input.date,
        vendor: input.vendor ?? null,
        note: input.note ?? null,
        by: userId(c),
        today: todayPk(),
      });
      return c.json(
        { expense: await oneExpense(db, r.id), replayed: r.replayed },
        r.replayed ? 200 : 201,
      );
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/expenses/:id/void', access: requires('expense', 'void') },
    async (c) => {
      const input = await jsonBody(c, voidReasonSchema);
      const db = c.get('db');
      const id = idParam(c);
      await voidExpense(db, { id, reason: input.reason, by: userId(c) });
      return c.json({ expense: await oneExpense(db, id) });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/expenses/:id/photo', access: requires('expense', 'create') },
    async (c) => {
      const files = bucket(c);
      const db = c.get('db');
      const id = idParam(c);
      const e = await expenseById(db, id);
      if (!e) throw notFoundError('Expense');
      const { bytes, type } = await readImageUpload(c, MAX_PHOTO_BYTES);
      const key = `expenses/${id}/${newId()}`;
      await files.put(key, bytes, { httpMetadata: { contentType: type } });
      const old = await setExpensePhoto(db, { id, key, by: userId(c) });
      await deleteReplaced(files, old, key);
      return c.json({ has_photo: true });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/expenses/:id/photo', access: requires('expense', 'read') },
    async (c) => {
      const e = await expenseById(c.get('db'), idParam(c));
      if (!e) throw notFoundError('Expense');
      return serveObject(c, e.receipt_key);
    },
  );

  // ---- payroll staff (base salary, allowances) ----------------------------------------------------

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/payroll/staff', access: requires('payslip', 'prepare') },
    async (c) => {
      const { excludeOwners } = officeScope(c);
      const rows = await c.get('db').all<{
        id: string;
        name: string;
        role: string | null;
        status: string;
        joined: string | null;
        base_salary: number | null;
        allowances: string | null;
        outstanding: number | null;
      }>(sql`SELECT st.id, st.name, st.role, st.status, st.joined, st.base_salary, st.allowances,
               (SELECT outstanding FROM advance_balance WHERE staff_id = st.id) AS outstanding
             FROM staff st WHERE 1 ${excludeOwners ? excludeOwnersSql(sql`st.user_id`) : sql``}
             ORDER BY st.status, st.name`);
      const staff: PayrollStaffDto[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        role: r.role,
        status: r.status,
        joined: r.joined,
        base_salary: r.base_salary,
        allowances: parseAllowances(r.allowances),
        outstanding_advance: r.outstanding ?? 0,
      }));
      return c.json({ staff });
    },
  );

  /** Setting pay is an owner/admin decision (same roles that approve payslips). */
  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/payroll/staff/:id', access: requires('payslip', 'approve') },
    async (c) => {
      const input = await jsonBody(c, staffPaySchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.all<{
        base_salary: number | null;
        allowances: string | null;
        joined: string | null;
      }>(sql`SELECT base_salary, allowances, joined FROM staff WHERE id = ${id}`);
      if (!before) throw notFoundError('Staff member');
      const after = {
        base_salary: input.base_salary,
        allowances: JSON.stringify(input.allowances),
        joined: input.joined === undefined ? before.joined : input.joined,
      };
      const diff = changed(before, after);
      if (diff)
        await tx(db, [
          sql`UPDATE staff SET base_salary = ${after.base_salary}, allowances = ${after.allowances},
                joined = ${after.joined} WHERE id = ${id}`,
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'staff',
            entityId: id,
            action: 'pay',
            ...diff,
          }),
        ]);
      return c.json({ ok: true });
    },
  );

  // ---- payslips ----------------------------------------------------------------------------------

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/payslips/generate', access: requires('payslip', 'prepare') },
    async (c) => {
      const input = await jsonBody(c, payslipGenerateSchema);
      const { excludeOwners } = officeScope(c);
      const r: GeneratePayslipsDto = await generatePayslips(c.get('db'), {
        periodKey: input.period,
        excludeOwners,
        after: input.after ?? null,
        by: userId(c),
      });
      return c.json(r);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/payslips', access: requires('payslip', 'prepare') },
    async (c) => {
      const input = await jsonBody(c, payslipCreateSchema);
      await staffInScope(c, input.staff_id);
      const r = await createPayslip(c.get('db'), {
        id: input.id ?? newId(),
        staffId: input.staff_id,
        periodKey: input.period,
        lines: input.lines?.map((l) => ({ ...l, note: l.note ?? null })),
        by: userId(c),
      });
      return c.json({ payslip: await slipDetailDto(c, r.id) }, 201);
    },
  );

  const listSlips = async (c: Context<AppEnv>) => {
    const q = queryParams(c, payslipQuerySchema);
    const { excludeOwners } = officeScope(c);
    const period = q.period ?? (q.from || q.to ? null : thisMonth());
    const rows = (
      await payslips(c.get('db'), {
        period,
        from: q.from ?? null,
        to: q.to ?? null,
        staffId: q.staff_id ?? null,
        status: q.status ?? null,
        excludeOwners,
      })
    ).map(slipDto);
    if (q.format === 'csv')
      return csv(
        c,
        `salaries-${period ?? `${q.from ?? ''}-${q.to ?? ''}`}.csv`,
        [
          'Month',
          'Staff',
          'Role',
          'Earnings',
          'Deductions',
          'Pay',
          'Advance recovery',
          'Net',
          'Paid',
          'Status',
        ],
        rows.map((r) => [
          r.period_key,
          r.staff_name,
          r.staff_role,
          rupees(r.earnings),
          rupees(r.deductions),
          rupees(r.pay),
          rupees(r.recovery),
          rupees(r.net),
          rupees(r.paid),
          r.status,
        ]),
      );
    const live = rows.filter((r) => r.status !== 'void');
    const body: PayslipListDto = {
      payslips: rows,
      totals: {
        pay: live.reduce((a, r) => a + r.pay, 0),
        net: live.reduce((a, r) => a + r.net, 0),
        paid: live.reduce((a, r) => a + r.paid, 0),
      },
    };
    return c.json(body);
  };

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/payslips', access: requires('payslip', 'read') },
    listSlips,
  );
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/reports/salaries', access: requires('payslip', 'read') },
    listSlips,
  );

  /** A staff member's own payslips (approved or paid; drafts are not final), with their lines. */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/payslips/mine', access: requires('payslip', 'read') },
    async (c) => {
      const db = c.get('db');
      const me = userId(c);
      const rows = await db.all<{ id: string }>(
        sql`SELECT p.id FROM payslip p JOIN staff st ON st.id = p.staff_id
            WHERE st.user_id = ${me} AND p.status IN ('approved', 'paid')
            ORDER BY p.period_key DESC LIMIT 36`,
      );
      const out: PayslipDetailDto[] = [];
      for (const r of rows) out.push(await slipDetailDto(c, r.id));
      return c.json({ payslips: out });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/payslips/:id', access: requires('payslip', 'read') },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [p] = await db.all<{ staff_id: string; status: string }>(
        sql`SELECT staff_id, status FROM payslip WHERE id = ${id}`,
      );
      if (!p) throw notFoundError('Payslip');
      await staffInScope(c, p.staff_id);
      if (payrollScope(c).kind === 'own' && !['approved', 'paid'].includes(p.status))
        throw notFoundError('Payslip');
      return c.json({ payslip: await slipDetailDto(c, id) });
    },
  );

  const slipStaff = async (c: Context<AppEnv>, id: string): Promise<string> => {
    const [p] = await c
      .get('db')
      .all<{ staff_id: string }>(sql`SELECT staff_id FROM payslip WHERE id = ${id}`);
    if (!p) throw notFoundError('Payslip');
    await staffInScope(c, p.staff_id);
    return p.staff_id;
  };

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/payslips/:id/lines', access: requires('payslip', 'prepare') },
    async (c) => {
      const input = await jsonBody(c, payslipLinesSchema);
      const id = idParam(c);
      await slipStaff(c, id);
      await setPayslipLines(c.get('db'), {
        id,
        lines: input.lines.map((l) => ({ ...l, note: l.note ?? null })),
        by: userId(c),
      });
      return c.json({ payslip: await slipDetailDto(c, id) });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/payslips/:id/approve', access: requires('payslip', 'approve') },
    async (c) => {
      const id = idParam(c);
      await slipStaff(c, id);
      await approvePayslip(c.get('db'), { id, by: userId(c) });
      return c.json({ payslip: await slipDetailDto(c, id) });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/payslips/:id/pay', access: requires('payslip', 'pay') },
    async (c) => {
      const input = await jsonBody(c, salaryPaymentSchema);
      const id = idParam(c);
      await slipStaff(c, id);
      const r = await paySalary(c.get('db'), {
        id: input.id ?? newId(),
        payslipId: id,
        amount: input.amount,
        accountId: input.account_id,
        date: input.date,
        note: input.note ?? null,
        by: userId(c),
        today: todayPk(),
      });
      return c.json(
        { payslip: await slipDetailDto(c, id), payment_id: r.id, replayed: r.replayed },
        r.replayed ? 200 : 201,
      );
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/payslips/:id/void', access: requires('payslip', 'approve') },
    async (c) => {
      const input = await jsonBody(c, voidReasonSchema);
      const id = idParam(c);
      await slipStaff(c, id);
      await voidPayslip(c.get('db'), { id, reason: input.reason, by: userId(c) });
      return c.json({ payslip: await slipDetailDto(c, id) });
    },
  );

  // ---- advances ----------------------------------------------------------------------------------

  const listAdvances = async (c: Context<AppEnv>) => {
    const { excludeOwners } = officeScope(c);
    const staffId = c.req.query('staff_id') || null;
    const reg = await advanceRegister(c.get('db'), { staffId, excludeOwners });
    if (c.req.query('format') === 'csv')
      return csv(
        c,
        'advances.csv',
        ['Staff', 'Advanced', 'Recovered', 'Outstanding', 'Last advance'],
        reg.balances.map((b) => [
          b.staff_name,
          rupees(b.advanced),
          rupees(b.recovered),
          rupees(b.outstanding),
          b.last_advance,
        ]),
      );
    const body: AdvanceListDto = reg;
    return c.json(body);
  };

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/advances', access: requires('payslip', 'read') },
    listAdvances,
  );
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/reports/advances', access: requires('payslip', 'read') },
    listAdvances,
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/advances', access: requires('payslip', 'pay') },
    async (c) => {
      const input = await jsonBody(c, advanceInputSchema);
      await staffInScope(c, input.staff_id);
      const r = await recordAdvance(c.get('db'), {
        id: input.id ?? newId(),
        staffId: input.staff_id,
        amount: input.amount,
        accountId: input.account_id,
        date: input.date,
        note: input.note ?? null,
        by: userId(c),
        today: todayPk(),
      });
      return c.json({ id: r.id, replayed: r.replayed }, r.replayed ? 200 : 201);
    },
  );

  // ---- reports -----------------------------------------------------------------------------------

  const money = requires('receipt', 'read');

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/reports/income-expense', access: money },
    async (c) => {
      const q = queryParams(c, monthRangeQuerySchema);
      const r: IncomeExpenseDto = await incomeExpense(c.get('db'), { from: q.from, to: q.to });
      if (q.format === 'csv') {
        const rows: (string | number | null)[][] = [
          ...r.months.map((m) => [
            m.period,
            rupees(m.income),
            rupees(m.expenses),
            rupees(m.salaries),
            rupees(m.net),
          ]),
          [
            'Total',
            rupees(r.income.total),
            rupees(r.expenses.total),
            rupees(r.salaries.pay),
            rupees(r.net),
          ],
          [],
          ['Income by fee head'],
          ...r.income.by_head.map((h) => [h.name, rupees(h.amount)]),
          ['Unallocated credit', rupees(r.income.unallocated)],
          [],
          ['Expenses by category'],
          ...r.expenses.by_category.map((x) => [x.name, rupees(x.amount)]),
          ['Salaries', rupees(r.salaries.pay)],
        ];
        return csv(
          c,
          `income-expense-${q.from}-${q.to}.csv`,
          ['Month', 'Income', 'Expenses', 'Salaries', 'Net'],
          rows,
        );
      }
      return c.json(r);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/reports/cashbook', access: money },
    async (c) => {
      const q = queryParams(c, cashbookQuerySchema);
      const r = await cashbook(c.get('db'), { accountId: q.account_id, from: q.from, to: q.to });
      const body: CashbookDto = {
        ...r,
        rows: r.rows.map(({ cash_session_id: _s, ...x }) => x),
      };
      if (q.format === 'csv')
        return csv(
          c,
          `cashbook-${r.account.name}-${q.from}-${q.to}.csv`,
          ['Date', 'Type', 'Ref', 'Party', 'In', 'Out', 'Balance'],
          [
            [q.from, 'Opening balance', null, null, null, null, rupees(r.opening)],
            ...body.rows.map((x) => [
              x.date,
              x.kind,
              x.ref_no,
              x.party,
              x.amount > 0 ? rupees(x.amount) : null,
              x.amount < 0 ? rupees(-x.amount) : null,
              rupees(x.balance),
            ]),
            [q.to, 'Closing balance', null, null, rupees(r.in), rupees(r.out), rupees(r.closing)],
          ],
        );
      return c.json(body);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/reports/accounts', access: money },
    async (c) => {
      const q = queryParams(c, balancesQuerySchema);
      const rows: AccountBalanceDto[] = await accountBalances(c.get('db'), {
        asOf: q.as_of ?? null,
      });
      if (q.format === 'csv')
        return csv(
          c,
          `accounts-${q.as_of ?? todayPk()}.csv`,
          ['Account', 'Kind', 'Balance'],
          rows.map((r) => [r.name, r.kind, rupees(r.balance)]),
        );
      return c.json({
        as_of: q.as_of ?? null,
        accounts: rows,
        total: rows.reduce((a, r) => a + r.balance, 0),
      });
    },
  );

  // ---- audit trail (owner) -----------------------------------------------------------------------

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/audit', access: requires('audit', 'read') },
    async (c) => {
      const q = queryParams(c, auditQuerySchema);
      const limit = 100;
      // `at` is UTC; the filter is on the school day (UTC+5).
      const day = sql`date(a.at, '+5 hours')`;
      const rows = await c.get('db').all<AuditRowDto & { diff: string | null }>(
        sql`SELECT a.id, a.at, a.user_id, u.name AS user_name, a.entity, a.entity_id, a.action, a.diff
            FROM audit a LEFT JOIN "user" u ON u.id = a.user_id
            WHERE 1
              ${q.entity ? sql`AND a.entity = ${q.entity}` : sql``}
              ${q.entity_id ? sql`AND a.entity_id = ${q.entity_id}` : sql``}
              ${q.user_id ? sql`AND a.user_id = ${q.user_id}` : sql``}
              ${q.from ? sql`AND ${day} >= ${q.from}` : sql``}
              ${q.to ? sql`AND ${day} <= ${q.to}` : sql``}
              ${q.before ? sql`AND (a.at, a.id) < (SELECT at, id FROM audit WHERE id = ${q.before})` : sql``}
            ORDER BY a.at DESC, a.id DESC LIMIT ${limit + 1}`,
      );
      const page = rows.slice(0, limit).map((r) => {
        let diff: unknown = r.diff;
        try {
          diff = r.diff ? JSON.parse(r.diff) : null;
        } catch {
          // Keep the raw text.
        }
        return { ...r, diff };
      });
      const body: AuditListDto = {
        rows: page,
        next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      };
      return c.json(body);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/audit/entities', access: requires('audit', 'read') },
    async (c) => {
      const rows = await c
        .get('db')
        .all<{ entity: string; n: number }>(
          sql`SELECT entity, count(*) AS n FROM audit GROUP BY entity ORDER BY entity`,
        );
      return c.json({ entities: rows });
    },
  );

  // ---- month dashboard ---------------------------------------------------------------------------

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/dashboard/month', access: money },
    async (c) => {
      const q = queryParams(c, dashboardMonthQuerySchema);
      const db = c.get('db');
      const period = q.period ?? thisMonth();
      const today = todayPk();
      const r = await incomeExpense(db, { from: period, to: period });
      const [dues] = await db.all<{ n: number }>(
        sql`SELECT coalesce(sum(max(0, d.due - coalesce(pc.credit, 0))), 0) AS n
            FROM (SELECT payer_id, sum(due) AS due FROM charge_status
                  WHERE payer_type = 'family' AND due > 0 GROUP BY payer_id) d
            LEFT JOIN payer_credit pc ON pc.payer_type = 'family' AND pc.payer_id = d.payer_id`,
      );
      const [people] = await db.all<{ admissions: number; left: number }>(
        sql`SELECT
              (SELECT count(*) FROM student WHERE admission_date BETWEEN ${periodStart(period)} AND ${periodEnd(period)}) AS admissions,
              (SELECT count(*) FROM student WHERE left_date BETWEEN ${periodStart(period)} AND ${periodEnd(period)}) AS "left"`,
      );
      const late = await defaulters(db, { today, limit: 5000 });
      const body: MonthDashboardDto = {
        period,
        income: r.income.total,
        expenses: r.expenses.total,
        salaries: r.salaries.pay,
        net: r.net,
        dues_outstanding: Number(dues?.n ?? 0),
        defaulters: late.length,
        admissions: people?.admissions ?? 0,
        left: people?.left ?? 0,
      };
      return c.json(body);
    },
  );
}

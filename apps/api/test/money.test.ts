import {
  type AdvanceListDto,
  type AuditListDto,
  type CashbookDto,
  type CashSessionDto,
  type ExpenseCategoryDto,
  type ExpenseDto,
  type ExpenseListDto,
  type GeneratePayslipsDto,
  type IncomeExpenseDto,
  type MonthDashboardDto,
  newId,
  type PayrollStaffDto,
  type PayslipDetailDto,
  type PayslipListDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { todayPk } from '../src/lib/http';
import { fakeR2, signedInAs, testApp } from './helpers';

// M4 over HTTP: expenses (drawer and bank, void, photo, CSV), payroll (pay settings, generate in
// chunks, lines, approve with separation of duties, partial pay, void), advances, the reports
// tying out, the audit trail and the month dashboard; payroll scope per role (PLAN §5.4).

type Res<T> = { status: number; body: T; text: string };
function client(request: ReturnType<typeof testApp>['request'], cookie: string) {
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed as T, text };
  };
}

const RS = (n: number) => n * 100;
const today = todayPk();
const period = today.slice(0, 7);

async function setup() {
  const r2 = fakeR2();
  const t = testApp({ env: { FILES: r2.bucket } });
  const owner = await signedInAs(t.db, ['owner']);
  const admin = await signedInAs(t.db, ['admin']);
  const acct = await signedInAs(t.db, ['accountant']);
  const teacher = await signedInAs(t.db, ['teacher']);
  const teacher2 = await signedInAs(t.db, ['teacher']);
  const api = client(t.request, owner.cookie);
  const as = {
    owner: api,
    admin: client(t.request, admin.cookie),
    acct: client(t.request, acct.cookie),
    teacher: client(t.request, teacher.cookie),
    teacher2: client(t.request, teacher2.cookie),
  };
  await api('PUT', '/api/school', { name: 'Al-Noor', mode: 'school', receipt_prefix: 'AN' });
  const cash = (
    await api<{ account: { id: string } }>('POST', '/api/accounts', {
      name: 'Drawers',
      kind: 'cash',
    })
  ).body.account.id;
  const bank = (
    await api<{ account: { id: string } }>('POST', '/api/accounts', { name: 'HBL', kind: 'bank' })
  ).body.account.id;
  await t.db.run(sql`INSERT INTO staff (id, user_id, name, role) VALUES
    ('ST_OWN', ${owner.userId}, 'Owner', 'principal'),
    ('ST_T', ${teacher.userId}, 'Teacher One', 'teacher'),
    ('ST_T2', ${teacher2.userId}, 'Teacher Two', 'teacher'),
    ('ST_ACC', ${acct.userId}, 'Accountant', 'accountant')`);
  await t.db.run(sql`INSERT INTO family (id, name) VALUES ('01JFAM0000000000000000000A', 'Khan')`);
  await t.db.run(sql`INSERT INTO student (id, family_id, admission_no, name, admission_date)
    VALUES ('S1', '01JFAM0000000000000000000A', '2026-0001', 'Ali', ${today})`);
  await t.db.run(
    sql`INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI', 'Tuition', 'tuition', 'monthly')`,
  );
  await t.db.run(sql`INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind)
    VALUES ('C1', 'S1', 'TUI', ${period}, 'family', '01JFAM0000000000000000000A', ${RS(3000)}, ${today}, 'fee')`);
  return { ...t, r2, as, users: { owner, admin, acct, teacher, teacher2 }, cash, bank };
}

describe('expenses over HTTP', () => {
  it('categories, drawer + bank expenses, void by admin only, photo, list + CSV', async () => {
    const s = await setup();
    const cats = await s.as.acct<{ categories: ExpenseCategoryDto[] }>(
      'GET',
      '/api/expenses/categories',
    );
    expect(cats.body.categories.find((c) => c.code === 'salaries')?.system).toBe(true);
    const rent = cats.body.categories.find((c) => c.code === 'rent')?.id as string;
    const salaries = cats.body.categories.find((c) => c.code === 'salaries')?.id as string;

    // Paying out of a drawer never opens it behind the payer's back (verify pass): 409 until the
    // accountant opens their drawer with the float they hold.
    const closedDrawer = await s.as.acct<{ error: { code: string } }>('POST', '/api/expenses', {
      category_id: rent,
      amount: RS(1200),
      account_id: s.cash,
    });
    expect([closedDrawer.status, closedDrawer.body.error.code]).toEqual([409, 'no_open_session']);
    expect((await s.as.acct('POST', '/api/cash/sessions', { opening: RS(2000) })).status).toBe(201);
    const twice = await s.as.acct<{ error: { code: string } }>('POST', '/api/cash/sessions', {
      opening: RS(500),
    });
    expect([twice.status, twice.body.error.code]).toEqual([409, 'already_open']);
    expect((await s.as.acct('POST', '/api/cash/sessions', { opening: RS(2000) })).status).toBe(201);

    const id = newId();
    const a = await s.as.acct<{ expense: ExpenseDto }>('POST', '/api/expenses', {
      id,
      category_id: rent,
      amount: RS(1200),
      account_id: s.cash,
      vendor: '=HYPERLINK("x")',
    });
    expect(a.status).toBe(201);
    expect(a.body.expense.expense_no).toBe(`EXP-${today.slice(0, 4)}-00001`);
    const replay = await s.as.acct<{ replayed: boolean }>('POST', '/api/expenses', {
      id,
      category_id: rent,
      amount: RS(1200),
      account_id: s.cash,
    });
    expect([replay.status, replay.body.replayed]).toEqual([200, true]);
    const bad = await s.as.acct<{ error: { code: string } }>('POST', '/api/expenses', {
      category_id: salaries,
      amount: RS(1),
      account_id: s.bank,
    });
    expect([bad.status, bad.body.error.code]).toEqual([400, 'category_reserved']);
    const noAcc = await s.as.acct('POST', '/api/expenses', { category_id: rent, amount: RS(1) });
    expect(noAcc.status).toBe(400);

    expect((await s.as.acct('POST', `/api/expenses/${id}/void`, { reason: 'dup' })).status).toBe(
      403,
    );
    const v = await s.as.admin<{ expense: ExpenseDto }>('POST', `/api/expenses/${id}/void`, {
      reason: 'entered twice',
    });
    expect([v.status, v.body.expense.voided, v.body.expense.void_reason]).toEqual([
      200,
      true,
      'entered twice',
    ]);
    const again = await s.as.admin<{ error: { code: string } }>(
      'POST',
      `/api/expenses/${id}/void`,
      {
        reason: 'x',
      },
    );
    expect([again.status, again.body.error.code]).toEqual([409, 'already_void']);

    const b = await s.as.acct<{ expense: ExpenseDto }>('POST', '/api/expenses', {
      category_id: rent,
      amount: RS(500),
      account_id: s.bank,
      vendor: 'Landlord',
    });
    // Bill photo (PNG magic bytes), then read back.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const form = new FormData();
    form.set('file', new File([png], 'bill.png', { type: 'image/png' }));
    const body = new Request('http://x', { method: 'POST', body: form });
    const bytes = await body.arrayBuffer();
    const up = await s.request(`/api/expenses/${b.body.expense.id}/photo`, {
      method: 'POST',
      headers: {
        cookie: s.users.acct.cookie,
        'content-type': body.headers.get('content-type') ?? '',
        'content-length': String(bytes.byteLength),
      },
      body: bytes,
    });
    expect(up.status).toBe(200);
    const photo = await s.request(`/api/expenses/${b.body.expense.id}/photo`, {
      headers: { cookie: s.users.acct.cookie },
    });
    expect([photo.status, photo.headers.get('content-type')]).toEqual([200, 'image/png']);

    const list = await s.as.acct<ExpenseListDto>('GET', '/api/expenses?include_void=1');
    expect(list.body.expenses).toHaveLength(2);
    expect(list.body.total).toBe(RS(500));
    expect(list.body.expenses.find((e) => e.id === b.body.expense.id)?.has_photo).toBe(true);
    const csv = await s.as.acct('GET', '/api/reports/expenses?include_void=1&format=csv');
    expect(csv.text).toContain("'=HYPERLINK"); // formula-safe writer
    expect((await s.as.teacher('GET', '/api/expenses')).status).toBe(403);
  });
});

describe('payroll over HTTP', () => {
  it('pay settings → generate → lines → approve (not your own) → partial pay → paid; void; teacher sees own only', async () => {
    const s = await setup();
    // Pay settings are owner/admin; an accountant cannot set salaries.
    expect(
      (
        await s.as.acct('PUT', '/api/payroll/staff/ST_T', {
          base_salary: RS(30000),
          allowances: [],
        })
      ).status,
    ).toBe(403);
    for (const [id, base] of [
      ['ST_OWN', RS(90000)],
      ['ST_T', RS(30000)],
      ['ST_T2', RS(28000)],
      ['ST_ACC', RS(25000)],
    ] as const)
      expect(
        (
          await s.as.admin('PUT', `/api/payroll/staff/${id}`, {
            base_salary: base,
            allowances: id === 'ST_T' ? [{ label: 'Transport', amount: RS(2000) }] : [],
          })
        ).status,
      ).toBe(200);
    // The accountant's payroll never shows the owner.
    const staff = await s.as.acct<{ staff: PayrollStaffDto[] }>('GET', '/api/payroll/staff');
    expect(staff.body.staff.map((x) => x.id).sort()).toEqual(['ST_ACC', 'ST_T', 'ST_T2']);

    // Advance to T before the slips: recovery is suggested on the draft.
    const adv = await s.as.acct('POST', '/api/advances', {
      staff_id: 'ST_T',
      amount: RS(4000),
      account_id: s.bank,
      note: 'medical',
    });
    expect(adv.status).toBe(201);
    expect(
      (
        await s.as.acct('POST', '/api/advances', {
          staff_id: 'ST_OWN',
          amount: RS(1),
          account_id: s.bank,
        })
      ).status,
    ).toBe(404);

    const gen = await s.as.acct<GeneratePayslipsDto>('POST', '/api/payslips/generate', { period });
    // The accountant never prepares the owner's slip; the owner's own run does.
    expect(gen.body).toEqual({ created: 3, skipped: 0, next: null });
    expect(
      (await s.as.owner<GeneratePayslipsDto>('POST', '/api/payslips/generate', { period })).body
        .created,
    ).toBe(1);
    const list = await s.as.acct<PayslipListDto>('GET', `/api/payslips?period=${period}`);
    expect(list.body.payslips.map((p) => p.staff_id).sort()).toEqual(['ST_ACC', 'ST_T', 'ST_T2']);
    const own = await s.as.owner<PayslipListDto>('GET', `/api/payslips?period=${period}`);
    const ownerSlip = own.body.payslips.find((p) => p.staff_id === 'ST_OWN')?.id as string;
    expect((await s.as.acct('GET', `/api/payslips/${ownerSlip}`)).status).toBe(404);
    expect(
      (await s.as.acct('POST', `/api/payslips/${ownerSlip}/pay`, { amount: 1, account_id: s.bank }))
        .status,
    ).toBe(404);

    const tSlip = list.body.payslips.find((p) => p.staff_id === 'ST_T');
    expect([tSlip?.pay, tSlip?.recovery, tSlip?.net]).toEqual([RS(32000), RS(4000), RS(28000)]);
    const tId = tSlip?.id as string;
    const lines = await s.as.acct<{ payslip: PayslipDetailDto }>(
      'PUT',
      `/api/payslips/${tId}/lines`,
      {
        lines: [
          { kind: 'basic', amount: RS(30000) },
          { kind: 'allowance', amount: RS(2000), note: 'Transport' },
          { kind: 'deduction', amount: RS(1000), note: 'leave' },
          { kind: 'advance_recovery', amount: RS(4000) },
        ],
      },
    );
    expect(lines.body.payslip.net).toBe(RS(27000));
    expect((await s.as.acct('POST', `/api/payslips/${tId}/approve`)).status).toBe(403);

    // Separation of duties: the owner's slip cannot be approved by the owner.
    const self = await s.as.owner<{ error: { code: string } }>(
      'POST',
      `/api/payslips/${ownerSlip}/approve`,
    );
    expect([self.status, self.body.error.code]).toEqual([403, 'own_payslip']);
    const ownDetail = await s.as.owner<{ payslip: PayslipDetailDto }>(
      'GET',
      `/api/payslips/${ownerSlip}`,
    );
    expect(ownDetail.body.payslip.can_approve).toBe(false);
    expect((await s.as.admin('POST', `/api/payslips/${ownerSlip}/approve`)).status).toBe(200);

    expect(
      (await s.as.acct('POST', `/api/payslips/${tId}/pay`, { amount: RS(1), account_id: s.bank }))
        .status,
    ).toBe(409);
    const ap = await s.as.owner<{ payslip: PayslipDetailDto }>(
      'POST',
      `/api/payslips/${tId}/approve`,
    );
    expect(ap.body.payslip.status).toBe('approved');
    expect(ap.body.payslip.advance.outstanding).toBe(0);
    expect((await s.as.acct('POST', '/api/cash/sessions', { opening: RS(25000) })).status).toBe(
      201,
    );
    const p1 = await s.as.acct<{ payslip: PayslipDetailDto }>('POST', `/api/payslips/${tId}/pay`, {
      amount: RS(20000),
      account_id: s.cash,
    });
    expect([
      p1.status,
      p1.body.payslip.paid,
      p1.body.payslip.status,
      p1.body.payslip.paid_partial,
    ]).toEqual([201, RS(20000), 'approved', true]);
    const over = await s.as.acct<{ error: { code: string } }>('POST', `/api/payslips/${tId}/pay`, {
      amount: RS(7001),
      account_id: s.bank,
    });
    expect([over.status, over.body.error.code]).toEqual([409, 'exceeds_net']);
    const vPaid = await s.as.admin<{ error: { code: string } }>(
      'POST',
      `/api/payslips/${tId}/void`,
      {
        reason: 'x',
      },
    );
    expect([vPaid.status, vPaid.body.error.code]).toEqual([409, 'not_voidable']);
    const p2 = await s.as.acct<{ payslip: PayslipDetailDto }>('POST', `/api/payslips/${tId}/pay`, {
      amount: RS(7000),
      account_id: s.bank,
    });
    expect([p2.body.payslip.status, p2.body.payslip.paid_partial]).toEqual(['paid', false]);

    const t2 = list.body.payslips.find((p) => p.staff_id === 'ST_T2')?.id as string;
    const vd = await s.as.admin<{ payslip: PayslipDetailDto }>('POST', `/api/payslips/${t2}/void`, {
      reason: 'left the school',
    });
    expect(vd.body.payslip.status).toBe('void');

    // Teacher: own approved/paid slips only, never the office list or someone else's slip.
    const mine = await s.as.teacher<{ payslips: PayslipDetailDto[] }>('GET', '/api/payslips/mine');
    expect(mine.body.payslips.map((p) => [p.staff_id, p.net, p.lines.length])).toEqual([
      ['ST_T', RS(27000), 4],
    ]);
    expect((await s.as.teacher('GET', `/api/payslips/${tId}`)).status).toBe(200);
    expect((await s.as.teacher2('GET', `/api/payslips/${tId}`)).status).toBe(404);
    expect(
      (await s.as.teacher2<{ payslips: unknown[] }>('GET', '/api/payslips/mine')).body.payslips,
    ).toEqual([]);
    expect((await s.as.teacher('GET', '/api/payslips')).status).toBe(403);
    expect((await s.as.teacher('GET', '/api/advances')).status).toBe(403);

    const advances = await s.as.acct<AdvanceListDto>('GET', '/api/advances');
    expect(advances.body.balances).toEqual([
      expect.objectContaining({
        staff_id: 'ST_T',
        advanced: RS(4000),
        recovered: RS(4000),
        outstanding: 0,
      }),
    ]);
    const reg = await s.as.acct('GET', `/api/reports/salaries?period=${period}&format=csv`);
    expect(reg.text).toContain('Teacher One');
    expect(reg.text).not.toContain('Owner');
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });
});

describe('reports, drawer, audit, dashboard over HTTP', () => {
  it('drawer expected includes money out; income vs expense ties to account balances; audit for owner only', async () => {
    const s = await setup();
    const rcpt = await s.as.acct('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: '01JFAM0000000000000000000A',
      amount: RS(5000),
      method: 'cash',
    });
    expect(rcpt.status).toBe(201);
    const cats = await s.as.acct<{ categories: ExpenseCategoryDto[] }>(
      'GET',
      '/api/expenses/categories',
    );
    const misc = cats.body.categories.find((c) => c.code === 'misc')?.id as string;
    await s.as.acct('POST', '/api/expenses', {
      category_id: misc,
      amount: RS(300),
      account_id: s.cash,
    });
    await s.as.acct('POST', '/api/advances', {
      staff_id: 'ST_T',
      amount: RS(700),
      account_id: s.cash,
    });
    const sessions = await s.as.acct<{ sessions: CashSessionDto[] }>(
      'GET',
      `/api/cash/sessions?date=${today}`,
    );
    const drawer = sessions.body.sessions[0];
    expect(drawer?.expected).toBe(RS(5000 - 300 - 700));
    expect(drawer?.paid_out).toEqual({
      expenses: RS(300),
      salaries: 0,
      advances: RS(700),
      transfers: 0,
    });

    const ie = await s.as.acct<IncomeExpenseDto>(
      'GET',
      `/api/reports/income-expense?from=${period}&to=${period}`,
    );
    expect([ie.body.income.total, ie.body.expenses.total, ie.body.net]).toEqual([
      RS(5000),
      RS(300),
      RS(4700),
    ]);
    expect(ie.body.reconciliation.ties).toBe(true);
    const balances = await s.as.acct<{
      accounts: { account_id: string; balance: number }[];
      total: number;
    }>('GET', '/api/reports/accounts');
    // The accountant sees only whether the books tie (F1); the owner sees the movement itself.
    expect(Object.keys(ie.body.reconciliation)).toEqual(['ties']);
    const ieOwner = await s.as.owner<IncomeExpenseDto>(
      'GET',
      `/api/reports/income-expense?from=${period}&to=${period}`,
    );
    expect(balances.body.total).toBe(ieOwner.body.reconciliation.movement);
    const book = await s.as.acct<CashbookDto>(
      'GET',
      `/api/reports/cashbook?account_id=${s.cash}&from=${period}-01&to=${today}`,
    );
    expect(book.body.closing).toBe(
      balances.body.accounts.find((a) => a.account_id === s.cash)?.balance,
    );
    expect(book.body.rows.map((r) => r.kind)).toEqual(['receipt', 'expense', 'advance']);
    const csv = await s.as.acct(
      'GET',
      `/api/reports/income-expense?from=${period}&to=${period}&format=csv`,
    );
    expect(csv.text).toContain('Unallocated credit');

    const month = await s.as.acct<MonthDashboardDto>('GET', '/api/dashboard/month');
    expect(month.body).toMatchObject({
      period,
      income: RS(5000),
      expenses: RS(300),
      admissions: 1,
    });
    // The strip compares with the month before (nothing booked then in this test).
    expect(month.body.previous.period < period).toBe(true);
    expect(month.body.previous).toMatchObject({ income: 0, spending: 0, net: 0 });

    expect((await s.as.admin('GET', '/api/audit')).status).toBe(403);
    const audit = await s.as.owner<AuditListDto>('GET', '/api/audit?entity=expense');
    expect(audit.body.rows.map((r) => r.action)).toEqual(['create']);
    expect(audit.body.rows[0]?.diff).toMatchObject({ after: { amount: RS(300) } });
    const all = await s.as.owner<AuditListDto>(`GET`, `/api/audit?from=${today}&to=${today}`);
    expect(all.body.rows.length).toBeGreaterThan(2);
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });
});

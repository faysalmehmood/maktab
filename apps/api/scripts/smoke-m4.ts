/**
 * Milestone 4 definition of done, over HTTP against `wrangler dev --local`:
 * a family pays cash → a cash expense out of the same drawer → the owner sets a teacher's pay →
 * payslip drafts for the month (chunked) → owner approves → the accountant pays part in cash →
 * a cash advance → the accountant closes the drawer and expected cash includes all of it → the
 * income/expense report moves by exactly these numbers and ties to the account movements → the
 * cashbook closing equals the account balance → ledger_consistency is empty.
 * Prints PASS/FAIL per step; exit 1 on failure.
 *
 *   npm run db:migrate:local && npm run dev -w @maktab/api   # terminal 1
 *   npm run smoke:m4 -w @maktab/api                          # terminal 2
 *
 * Self-contained (its own family, accountant, teacher and accounts, with a random suffix): a fresh
 * accountant means a fresh drawer, so it runs after the other smokes and again. The teacher leaves
 * the payroll at the end (status `left`), so later runs do not prepare slips for them.
 */
import { createRequire } from 'node:module';
import type {
  AccountBalanceDto,
  CashbookDto,
  CashSessionDto,
  ExpenseCategoryDto,
  ExpenseDto,
  GeneratePayslipsDto,
  IncomeExpenseDto,
  PayslipDetailDto,
  PayslipListDto,
  SchoolResponse,
  SessionDto,
  StaffRowDto,
} from '@maktab/shared';
import { newId } from '@maktab/shared';
import { localD1File, mintDevSession } from './dev-session';
import { always, EMAIL, expectOk, finish, makeApi, runId as run, step } from './smoke-lib';

let ownerCookie = '';
let acctCookie = '';
const api = makeApi(() => ownerCookie);
const acct = makeApi(() => acctCookie);

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const period = today.slice(0, 7);
const RS = (n: number) => n * 100;

function localQuery<T>(q: string): T[] {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(localD1File(), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(q).all() as T[];
  } finally {
    db.close();
  }
}

const report = async () =>
  (await api<IncomeExpenseDto>('GET', `/api/reports/income-expense?from=${period}&to=${period}`))
    .body;

async function main() {
  let family = '';
  let bank = '';
  let teacher = '';
  let slip = '';
  let before: IncomeExpenseDto | null = null;

  await step('API reachable (GET /api/health)', async () => {
    const r = await api<{ status: string }>('GET', '/api/health');
    expectOk(r.status === 200 && r.body.status === 'ok', r);
  });

  await step(`owner session for ${EMAIL}; school and session ready`, async () => {
    ownerCookie = (await mintDevSession(EMAIL)).cookie;
    const s = await api<SchoolResponse>('GET', '/api/school');
    if (!s.body.school) {
      const r = await api('PUT', '/api/school', { name: 'Smoke Test School', mode: 'both' });
      expectOk(r.status === 200, r);
    }
    const sessions = await api<{ items: SessionDto[] }>('GET', '/api/sessions');
    if (!sessions.body.items.some((x) => x.is_current)) {
      const y = Number(today.slice(0, 4));
      const r = await api('POST', '/api/sessions', {
        name: `${y}-${y + 1}`,
        start_date: `${y - 1}-04-01`,
        end_date: `${y + 1}-03-31`,
      });
      expectOk(r.status === 201, r);
    }
    const after = await api<SchoolResponse>('GET', '/api/school');
    if (!after.body.school?.setup_completed_at) {
      const r = await api('POST', '/api/school/complete-setup');
      expectOk(r.status === 200, r);
    }
  });

  await step(
    'accounts (a drawer account exists, a bank account), family, accountant, teacher',
    async () => {
      const accounts = await api<{ accounts: { id: string; kind: string }[] }>(
        'GET',
        '/api/accounts',
      );
      if (!accounts.body.accounts.some((a) => a.kind === 'cash')) {
        const r = await api('POST', '/api/accounts', { name: 'Drawers', kind: 'cash' });
        expectOk(r.status === 201, r);
      }
      const b = await api<{ account: { id: string } }>('POST', '/api/accounts', {
        name: `Bank ${run}`,
        kind: 'bank',
      });
      expectOk(b.status === 201, b);
      bank = b.body.account.id;
      const f = await api<{ id: string }>('POST', '/api/families', { name: `M4 family ${run}` });
      expectOk(f.status === 201, f);
      family = f.body.id;
      const email = `m4-acct-${run}@example.com`;
      const inv = await api<StaffRowDto>('POST', '/api/staff/invite', {
        email,
        role: 'accountant',
        name: `Acct ${run}`,
      });
      expectOk(inv.status === 201, inv);
      acctCookie = (await mintDevSession(email, { activate: true })).cookie;
      const tch = await api<StaffRowDto>('POST', '/api/staff', { name: `Teacher ${run}` });
      expectOk(tch.status === 201 && tch.body.staff_id, tch);
      teacher = tch.body.staff_id ?? '';
      before = await report();
      expectOk(before.reconciliation.ties, before.reconciliation);
    },
  );

  /** The drawer account cash lands in: what money_movement resolves for this accountant. */
  const drawerAccount = () =>
    localQuery<{ account_id: string }>(
      `SELECT d.account_id FROM drawer_account d JOIN "user" u ON u.id = d.user_id WHERE u.email = 'm4-acct-${run}@example.com'`,
    )[0]?.account_id ?? '';

  await step('the accountant takes Rs 30,000 cash from the family (credit, no dues)', async () => {
    const r = await acct('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: family,
      amount: RS(30000),
      method: 'cash',
    });
    expectOk(r.status === 201, r);
  });

  await step('a cash expense of Rs 1,500 out of the same drawer (EXP number)', async () => {
    const cats = await acct<{ categories: ExpenseCategoryDto[] }>(
      'GET',
      '/api/expenses/categories',
    );
    const stationery = cats.body.categories.find((c) => c.code === 'stationery');
    expectOk(stationery, cats);
    const e = await acct<{ expense: ExpenseDto }>('POST', '/api/expenses', {
      category_id: stationery?.id,
      amount: RS(1500),
      account_id: drawerAccount(),
      vendor: `Bookshop ${run}`,
    });
    expectOk(e.status === 201 && /^EXP-\d{4}-\d{5}$/.test(e.body.expense.expense_no), e);
    return e.body.expense.expense_no;
  });

  await step('owner sets the teacher’s pay; drafts for the month (chunked loop)', async () => {
    const p = await api('PUT', `/api/payroll/staff/${teacher}`, {
      base_salary: RS(20000),
      allowances: [{ label: 'Transport', amount: RS(1000) }],
    });
    expectOk(p.status === 200, p);
    let after: string | null = null;
    let created = 0;
    for (let i = 0; i < 50; i++) {
      const g: { status: number; body: GeneratePayslipsDto } = await acct<GeneratePayslipsDto>(
        'POST',
        '/api/payslips/generate',
        { period, after },
      );
      expectOk(g.status === 200, g);
      created += g.body.created;
      after = g.body.next;
      if (!after) break;
    }
    const list = await acct<PayslipListDto>('GET', `/api/payslips?period=${period}`);
    const mine = list.body.payslips.find((x) => x.staff_id === teacher);
    expectOk(mine?.status === 'draft' && mine.net === RS(21000), list.body);
    slip = mine?.id ?? '';
    return `${created} created`;
  });

  await step('owner approves; the accountant cannot', async () => {
    const no = await acct('POST', `/api/payslips/${slip}/approve`);
    expectOk(no.status === 403, no);
    const r = await api<{ payslip: PayslipDetailDto }>('POST', `/api/payslips/${slip}/approve`);
    expectOk(r.status === 200 && r.body.payslip.status === 'approved', r);
  });

  await step(
    'the accountant pays Rs 12,000 of Rs 21,000 in cash; over-paying is refused',
    async () => {
      const r = await acct<{ payslip: PayslipDetailDto }>('POST', `/api/payslips/${slip}/pay`, {
        id: newId(),
        amount: RS(12000),
        account_id: drawerAccount(),
      });
      expectOk(r.status === 201 && r.body.payslip.paid === RS(12000), r);
      const over = await acct<{ error: { code: string } }>('POST', `/api/payslips/${slip}/pay`, {
        amount: RS(9001),
        account_id: bank,
      });
      expectOk(over.status === 409 && over.body.error.code === 'exceeds_net', over);
    },
  );

  await step('a Rs 2,000 cash advance to the teacher', async () => {
    const r = await acct('POST', '/api/advances', {
      staff_id: teacher,
      amount: RS(2000),
      account_id: drawerAccount(),
      note: 'smoke',
    });
    expectOk(r.status === 201, r);
  });

  await step('close the drawer: expected = 30,000 − 1,500 − 12,000 − 2,000 = 14,500', async () => {
    const s = await acct<{ sessions: CashSessionDto[] }>('GET', `/api/cash/sessions?date=${today}`);
    const drawer = s.body.sessions[0];
    expectOk(drawer && drawer.expected === RS(14500), s.body);
    expectOk(
      drawer?.paid_out.expenses === RS(1500) &&
        drawer.paid_out.salaries === RS(12000) &&
        drawer.paid_out.advances === RS(2000),
      drawer,
    );
    const c = await acct<{ session: CashSessionDto }>(
      'POST',
      `/api/cash/sessions/${drawer?.id}/close`,
      { counted: RS(14500) },
    );
    expectOk(c.status === 200 && c.body.session.variance === 0, c);
  });

  await step(
    'income vs expense moved by exactly these numbers and ties to the accounts',
    async () => {
      const after = await report();
      const b = before as IncomeExpenseDto;
      const d = {
        income: after.income.total - b.income.total,
        unallocated: after.income.unallocated - b.income.unallocated,
        expenses: after.expenses.total - b.expenses.total,
        salaries: after.salaries.pay - b.salaries.pay,
        salaryPaid: (after.reconciliation.salary_paid ?? 0) - (b.reconciliation.salary_paid ?? 0),
        advances: (after.reconciliation.advances_paid ?? 0) - (b.reconciliation.advances_paid ?? 0),
        movement: (after.reconciliation.movement ?? 0) - (b.reconciliation.movement ?? 0),
      };
      expectOk(
        d.income === RS(30000) &&
          d.unallocated === RS(30000) &&
          d.expenses === RS(1500) &&
          d.salaries === RS(21000) &&
          d.salaryPaid === RS(12000) &&
          d.advances === RS(2000) &&
          d.movement === RS(30000 - 1500 - 12000 - 2000),
        d,
      );
      expectOk(after.reconciliation.ties, after.reconciliation);
      const accounts = await api<{ accounts: AccountBalanceDto[] }>('GET', '/api/reports/accounts');
      const cash = drawerAccount();
      const book = await api<CashbookDto>(
        'GET',
        `/api/reports/cashbook?account_id=${cash}&from=${period}-01&to=${today}`,
      );
      const bal = accounts.body.accounts.find((a) => a.account_id === cash)?.balance;
      expectOk(book.status === 200 && book.body.closing === bal, {
        closing: book.body.closing,
        bal,
      });
      const csv = await api(
        'GET',
        `/api/reports/income-expense?from=${period}&to=${period}&format=csv`,
      );
      expectOk(
        csv.status === 200 && csv.text.includes('Unallocated credit'),
        csv.text.slice(0, 200),
      );
    },
  );

  await step('ledger_consistency is empty (local D1 file)', async () => {
    const rows = localQuery('SELECT * FROM ledger_consistency');
    expectOk(rows.length === 0, rows);
  });

  await always('cleanup: the smoke teacher leaves the payroll', async () => {
    if (!teacher) return 'nothing to clean';
    const r = await api('PATCH', `/api/staff/${teacher}`, { status: 'left' });
    expectOk(r.status === 200, r);
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

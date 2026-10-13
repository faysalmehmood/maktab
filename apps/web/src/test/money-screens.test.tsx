import type {
  AuditListDto,
  CashbookDto,
  ExpenseDto,
  IncomeExpenseDto,
  MonthDashboardDto,
  StaffRole,
} from '@maktab/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MONEY_ROUTES } from '@/App';
import { MonthTiles } from '@/components/money/MonthTiles';
import { RequireGrant } from '@/components/RequireGrant';
import { toast } from '@/components/ui/sonner';
import { initI18n, setLanguage } from '@/i18n';
import { karachiToday } from '@/lib/fees';
import { AdvancesPage } from '@/pages/money/Advances';
import { AuditPage, diffRows } from '@/pages/money/Audit';
import { ExpensesPage, validateExpense } from '@/pages/money/Expenses';
import {
  AccountsPage,
  AdvanceRegisterPage,
  CashbookPage,
  ExpenseRegisterPage,
  IncomeExpensePage,
  ReportsHub,
} from '@/pages/money/Reports';
import { meAs, mockApi, renderAt } from './api-mock';

const RS = (n: number) => n * 100;
const today = karachiToday();
const CASH = '01JAAAAAAAAAAAAAAAAAAAAAC1';
const BANK = '01JAAAAAAAAAAAAAAAAAAAAAB1';

const accounts = {
  accounts: [
    { id: CASH, name: 'Drawers', kind: 'cash', holder_staff_id: null },
    { id: BANK, name: 'HBL current', kind: 'bank', holder_staff_id: null },
    // Someone else's drawer: never offered for paying out (F3).
    {
      id: '01JACC00000000000000OTHER0',
      name: 'Other drawer',
      kind: 'cash',
      holder_staff_id: 'ST9',
    },
  ],
  my_drawer: CASH,
};
const categories = {
  categories: [
    { id: 'expcat_rent', code: 'rent', name: 'Rent', name_ur: 'کرایہ', system: false },
    {
      id: 'expcat_salaries',
      code: 'salaries',
      name: 'Salaries',
      name_ur: 'تنخواہیں',
      system: true,
    },
  ],
};
const expense = (o: Partial<ExpenseDto> = {}): ExpenseDto => ({
  id: 'E1',
  expense_no: 'EXP-2026-00001',
  date: today,
  category_id: 'expcat_rent',
  category_code: 'rent',
  category_name: 'Rent',
  category_name_ur: 'کرایہ',
  account_id: CASH,
  account_name: 'Drawers',
  account_kind: 'cash',
  amount: RS(1200),
  vendor: 'Landlord',
  note: null,
  has_photo: true,
  voided: false,
  void_reason: null,
  created_by_name: 'O',
  ...o,
});
const ie: IncomeExpenseDto = {
  from: '2026-09',
  to: '2026-10',
  income: {
    by_head: [{ fee_head_id: 'H', name: 'Tuition', name_ur: 'ٹیوشن', amount: RS(6000) }],
    unallocated: RS(2000),
    total: RS(8000),
  },
  expenses: {
    by_category: [
      {
        category_id: 'expcat_rent',
        code: 'rent',
        name: 'Rent',
        name_ur: 'کرایہ',
        amount: RS(1000),
      },
    ],
    total: RS(1000),
  },
  salaries: { pay: RS(3000), slips: 1, scope: 'all' },
  net: RS(4000),
  months: [
    { period: '2026-09', income: RS(5000), expenses: RS(1000), salaries: RS(3000), net: RS(1000) },
    { period: '2026-10', income: RS(3000), expenses: 0, salaries: 0, net: RS(3000) },
  ],
  reconciliation: {
    income: RS(8000),
    expenses: RS(1000),
    salary_paid: RS(3000),
    advances_paid: RS(500),
    expected_movement: RS(3500),
    movement: RS(3500),
    ties: true,
  },
};
const cashbook: CashbookDto = {
  account: { id: CASH, name: 'Drawers', kind: 'cash' },
  from: `${today.slice(0, 7)}-01`,
  to: today,
  opening: RS(100),
  rows: [
    {
      date: today,
      kind: 'receipt',
      subkind: 'payment',
      ref_id: 'R1',
      ref_no: 'AN-2026-00001',
      party: 'Khan',
      amount: RS(2000),
      balance: RS(2100),
    },
    {
      date: today,
      kind: 'expense',
      subkind: 'rent',
      ref_id: 'E1',
      ref_no: 'EXP-2026-00001',
      party: 'Landlord',
      amount: -RS(1200),
      balance: RS(900),
    },
  ],
  in: RS(2000),
  out: RS(1200),
  closing: RS(900),
};
const audit: AuditListDto = {
  rows: [
    {
      id: 'A1',
      at: '2026-10-10T05:00:00.000Z',
      user_id: 'U',
      user_name: 'Owner',
      entity: 'expense',
      entity_id: 'E1',
      action: 'void',
      diff: { before: { voided_by: null }, after: { voided_by: 'U', void_reason: 'twice' } },
    },
  ],
  next: null,
};
const month: MonthDashboardDto = {
  period: today.slice(0, 7),
  income: RS(8000),
  expenses: RS(1000),
  salaries: RS(3000),
  salaries_scope: 'all',
  net: RS(4000),
  dues_outstanding: RS(500),
  defaulters: 2,
  admissions: 3,
  left: 1,
};
const API = {
  'GET /api/accounts': accounts,
  'GET /api/expenses/categories': categories,
  'GET /api/expenses': {
    expenses: [
      expense(),
      expense({ id: 'E2', expense_no: 'EXP-2026-00002', voided: true, void_reason: 'twice' }),
    ],
    total: RS(1200),
    from: today,
    to: today,
  },
  'GET /api/reports/expenses': { expenses: [expense()], total: RS(1200), from: today, to: today },
  'GET /api/advances': {
    balances: [
      {
        staff_id: 'ST',
        staff_name: 'Bilal',
        advanced: RS(4000),
        recovered: RS(1000),
        outstanding: RS(3000),
        last_advance: today,
      },
    ],
    advances: [
      {
        id: 'AD',
        staff_id: 'ST',
        staff_name: 'Bilal',
        amount: RS(4000),
        account_id: BANK,
        account_name: 'HBL current',
        date: today,
        note: null,
      },
    ],
  },
  'GET /api/reports/advances': { balances: [], advances: [] },
  'GET /api/payroll/staff': {
    staff: [
      {
        id: 'ST',
        name: 'Bilal',
        role: 'teacher',
        status: 'active',
        joined: null,
        base_salary: RS(30000),
        allowances: [],
        outstanding_advance: RS(3000),
      },
    ],
  },
  'GET /api/reports/income-expense': ie,
  'GET /api/reports/cashbook': cashbook,
  'GET /api/reports/accounts': {
    as_of: today,
    accounts: [{ account_id: CASH, name: 'Drawers', kind: 'cash', balance: RS(900) }],
    total: RS(900),
  },
  'GET /api/audit': audit,
  'GET /api/audit/entities': { entities: [{ entity: 'expense', n: 1 }] },
  'GET /api/dashboard/month': month,
};

const byId = (id: string) =>
  waitFor(() => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  });
const posts = (calls: { method: string; path: string; body: unknown }[], path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await act(() => setLanguage('en'));
});

describe('expenses', () => {
  it('validation: required fields, no future date, a drawer expense is today only', () => {
    const d = {
      category: '',
      amount: '',
      account: '',
      date: today,
      vendor: '',
      note: '',
      photo: null,
    };
    expect(validateExpense(d, { today, cashAccount: false })).toEqual({
      category: 'required',
      amount: 'required',
      account: 'account_required',
    });
    const ok = { ...d, category: 'c', amount: '1,200', account: 'a' };
    expect(validateExpense({ ...ok, amount: '12.345' }, { today, cashAccount: false }).amount).toBe(
      'amount_invalid',
    );
    expect(validateExpense({ ...ok, date: '2999-01-01' }, { today, cashAccount: false }).date).toBe(
      'invalid',
    );
    expect(validateExpense({ ...ok, date: '2020-01-01' }, { today, cashAccount: true }).date).toBe(
      'invalid',
    );
    expect(validateExpense({ ...ok, date: '2020-01-01' }, { today, cashAccount: false })).toEqual(
      {},
    );
  });

  it('add dialog: empty save posts nothing; salaries not offered; a drawer expense posts today with an id', async () => {
    const api = mockApi({ ...API, 'POST /api/expenses': { expense: expense(), replayed: false } });
    renderAt('/expenses', '/expenses', <ExpensesPage />, ['accountant']);
    fireEvent.click(await byId('expense-add'));
    fireEvent.click(await byId('expense-save'));
    await screen.findAllByRole('alert');
    expect(posts(api.calls, '/api/expenses')).toEqual([]);
    const cat = (await byId('expense-category')) as HTMLSelectElement;
    await waitFor(() => expect(cat.options.length).toBe(2));
    expect([...cat.options].map((o) => o.value)).toEqual(['', 'expcat_rent']);
    fireEvent.change(cat, { target: { value: 'expcat_rent' } });
    fireEvent.change(await byId('expense-amount'), { target: { value: '1200' } });
    const acc = (await byId('expense-account')) as HTMLSelectElement;
    await waitFor(() => expect(acc.options.length).toBe(3));
    fireEvent.change(acc, { target: { value: CASH } });
    expect(((await byId('expense-date')) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(await byId('expense-save'));
    await waitFor(() => expect(posts(api.calls, '/api/expenses')).toHaveLength(1));
    const body = posts(api.calls, '/api/expenses')[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      category_id: 'expcat_rent',
      amount: RS(1200),
      account_id: CASH,
      date: today,
    });
    expect(typeof body.id).toBe('string');
  });

  it('void: admin with a reason; an accountant sees no void button', async () => {
    const api = mockApi({
      ...API,
      'POST /api/expenses/E1/void': { expense: expense({ voided: true }) },
    });
    renderAt('/expenses', '/expenses', <ExpensesPage />, ['admin']);
    fireEvent.click(await byId('expense-void-E1'));
    expect(document.getElementById('expense-void-E2')).toBeNull(); // already void
    fireEvent.click(await byId('expense-void-confirm'));
    await screen.findByText('Required');
    expect(posts(api.calls, '/api/expenses/E1/void')).toEqual([]);
    fireEvent.change(await byId('expense-void-reason'), { target: { value: 'entered twice' } });
    fireEvent.click(await byId('expense-void-confirm'));
    await waitFor(() =>
      expect(posts(api.calls, '/api/expenses/E1/void')).toEqual([{ reason: 'entered twice' }]),
    );
  });

  it('Void is never the only row action: a row without a bill offers "Add bill photo" first', async () => {
    mockApi({
      ...API,
      'GET /api/expenses': {
        expenses: [expense({ id: 'E3', has_photo: false })],
        total: RS(1200),
        from: today,
        to: today,
      },
    });
    renderAt('/expenses', '/expenses', <ExpensesPage />, ['admin']);
    const voidBtn = await byId('expense-void-E3');
    const row = voidBtn.closest('[data-expense]') as HTMLElement;
    const actions = [...row.querySelectorAll('a, button, label')].map((b) => b.textContent);
    expect(actions).toEqual(['Add bill photo', 'Void']);
    // Void is the secondary (ghost) action at the far end.
    expect(voidBtn.getAttribute('data-variant') ?? voidBtn.className).toMatch(/ghost|ms-auto/);
    expect(row.querySelector('input[type="file"]')?.getAttribute('capture')).toBe('environment');
  });

  it('an accountant gets no void', async () => {
    mockApi(API);
    renderAt('/expenses', '/expenses', <ExpensesPage />, ['accountant']);
    await screen.findAllByText('Landlord');
    expect(document.getElementById('expense-void-E1')).toBeNull();
  });
});

describe('advances', () => {
  it('lists outstanding and posts a new advance', async () => {
    const api = mockApi({ ...API, 'POST /api/advances': { id: 'X', replayed: false } });
    renderAt('/advances', '/advances', <AdvancesPage />, ['accountant']);
    await screen.findAllByText('Bilal');
    fireEvent.click(await byId('advance-add'));
    fireEvent.click(await byId('advance-save'));
    expect(posts(api.calls, '/api/advances')).toEqual([]);
    const staff = (await byId('advance-staff')) as HTMLSelectElement;
    await waitFor(() => expect(staff.options.length).toBe(2));
    fireEvent.change(staff, { target: { value: 'ST' } });
    fireEvent.change(await byId('advance-amount'), { target: { value: '2000' } });
    const acc = (await byId('advance-account')) as HTMLSelectElement;
    await waitFor(() => expect(acc.options.length).toBe(3));
    fireEvent.change(acc, { target: { value: BANK } });
    fireEvent.click(await byId('advance-save'));
    await waitFor(() => expect(posts(api.calls, '/api/advances')).toHaveLength(1));
    expect(posts(api.calls, '/api/advances')[0]).toMatchObject({
      staff_id: 'ST',
      amount: RS(2000),
      account_id: BANK,
    });
  });
});

describe('reports', () => {
  it('income vs expense: SVG bars per month, by head with unallocated credit, reconciliation', async () => {
    mockApi(API);
    renderAt('/reports/income-expense', '/reports/income-expense', <IncomeExpensePage />);
    const chart = await byId('income-expense-chart');
    expect(chart.querySelectorAll('g[data-period]')).toHaveLength(2);
    expect(chart.querySelector('svg')?.getAttribute('role')).toBe('img');
    expect((await byId('ie-unallocated')).textContent).toContain('PKR 2,000');
    expect((await byId('ie-reconciliation')).textContent).toContain('The books tie out.');
  });

  it('cashbook: opening, rows with running balance, closing', async () => {
    mockApi(API);
    renderAt('/reports/cashbook', '/reports/cashbook', <CashbookPage />);
    expect((await byId('cashbook-opening')).textContent).toContain('PKR 100');
    expect((await byId('cashbook-closing')).textContent).toContain('PKR 900');
    expect(document.querySelectorAll('[data-kind]')).toHaveLength(2);
  });

  it('hub shows only the reports a role can open', async () => {
    renderAt('/reports', '/reports', <ReportsHub />, ['accountant']);
    expect(screen.getByText('Salary register')).toBeTruthy();
    renderAt('/reports', '/reports', <ReportsHub />, ['teacher']);
    expect(screen.getAllByText('Income vs expense')).toHaveLength(1);
  });
});

describe('audit', () => {
  it('diffRows compares before/after key by key and keeps other shapes', () => {
    expect(diffRows({ before: { a: 1 }, after: { a: 2, b: 'x' } })).toEqual([
      { field: 'a', before: 1, after: 2 },
      { field: 'b', before: undefined, after: 'x' },
    ]);
    expect(diffRows({ reason: 'r' })).toEqual([{ field: 'reason', before: undefined, after: 'r' }]);
    expect(diffRows(null)).toEqual([]);
  });

  it('expands a row into the before/after table; filters go to the API', async () => {
    const api = mockApi(API);
    renderAt('/audit', '/audit', <AuditPage />);
    fireEvent.click(await byId('audit-toggle-A1'));
    const table = await byId('audit-diff-A1');
    expect(table.textContent).toContain('void_reason');
    expect(table.textContent).toContain('twice');
    const entity = (await byId('audit-entity')) as HTMLSelectElement;
    await waitFor(() => expect(entity.options.length).toBe(2));
    fireEvent.change(entity, { target: { value: 'expense' } });
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/api/audit?entity=expense')).toBe(true),
    );
  });
});

describe('dashboard month tiles', () => {
  it('income, spending, net, dues, defaulters, admissions, left', async () => {
    mockApi(API);
    renderAt('/', '/', <MonthTiles />);
    expect((await byId('tile-month-spending')).textContent).toContain('PKR 4,000');
    expect((await byId('tile-month-admissions')).textContent).toContain('3');
    expect((await byId('tile-month-left')).textContent).toContain('1');
  });
});

/** Who may open each money route by URL (PLAN §5.4); everyone else is sent home with a toast. */
const ALLOWED: Record<string, readonly StaffRole[]> = {
  expenses: ['owner', 'admin', 'accountant'],
  salary: ['owner', 'admin', 'accountant'],
  'salary/:id': ['owner', 'admin', 'accountant'],
  'payslips/:id/print': ['owner', 'admin', 'accountant', 'teacher'],
  'my/payslips': ['owner', 'admin', 'accountant', 'teacher'],
  advances: ['owner', 'admin', 'accountant'],
  reports: ['owner', 'admin', 'accountant'],
  'reports/income-expense': ['owner', 'admin', 'accountant'],
  'reports/cashbook': ['owner', 'admin', 'accountant'],
  'reports/accounts': ['owner', 'admin', 'accountant'],
  'reports/expenses': ['owner', 'admin', 'accountant'],
  'reports/salaries': ['owner', 'admin', 'accountant'],
  'reports/advances': ['owner', 'admin', 'accountant'],
  audit: ['owner'],
};

function open(path: string, grant: (typeof MONEY_ROUTES)[number][2], role: StaffRole) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['me'], meAs([role]));
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/${path.replace(/:id/g, 'X1')}`]}>
        <Routes>
          <Route path="/" element={<p>home</p>} />
          <Route
            path={`/${path}`}
            element={
              <RequireGrant grant={grant}>
                <p>page</p>
              </RequireGrant>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('money routes are guarded by the shared MATRIX', () => {
  it('every money route has an expectation', () => {
    expect(MONEY_ROUTES.map(([p]) => p).sort()).toEqual(Object.keys(ALLOWED).sort());
  });
  const cases = MONEY_ROUTES.flatMap(([path, , grant]) =>
    (['owner', 'admin', 'accountant', 'teacher'] as StaffRole[]).map(
      (role) => [path, role, grant] as const,
    ),
  );
  it.each(cases)('%s as %s', (path, role, grant) => {
    const err = vi.spyOn(toast, 'error');
    open(path, grant, role);
    if (ALLOWED[path]?.includes(role)) expect(screen.getByText('page')).toBeTruthy();
    else {
      expect(screen.getByText('home')).toBeTruthy();
      expect(err).toHaveBeenCalled();
    }
  });
});

/** Visible text that is not data (same rule as fees-rtl.test.tsx). */
function uiText(root: Element): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out.push(n.textContent ?? '');
      return;
    }
    if (!(n instanceof Element)) return;
    if (['BDI', 'OPTION', 'SCRIPT', 'STYLE', 'title'].includes(n.tagName)) return;
    if (n.classList.contains('num') || n.getAttribute('lang') === 'en') return;
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out.join(' ');
}

const PAGES: [string, string, string, ReactNode][] = [
  ['expenses', '/expenses', '/expenses', <ExpensesPage key="e" />],
  ['advances', '/advances', '/advances', <AdvancesPage key="a" />],
  ['reports hub', '/reports', '/reports', <ReportsHub key="h" />],
  ['income vs expense', '/r', '/r', <IncomeExpensePage key="ie" />],
  ['cashbook', '/r', '/r', <CashbookPage key="cb" />],
  ['accounts', '/r', '/r', <AccountsPage key="ac" />],
  ['expense register', '/r', '/r', <ExpenseRegisterPage key="er" />],
  ['advance register', '/r', '/r', <AdvanceRegisterPage key="ar" />],
  ['audit', '/audit', '/audit', <AuditPage key="au" />],
  ['month tiles', '/', '/', <MonthTiles key="mt" />],
];

describe('RTL smoke: every money page in Urdu', () => {
  it.each(PAGES)(
    '%s: dir=rtl and no English outside isolated data',
    async (_n, path, pattern, el) => {
      await act(() => setLanguage('ur'));
      mockApi(API);
      const { container } = renderAt(path, pattern, el);
      expect(document.documentElement.dir).toBe('rtl');
      await waitFor(() => {
        const text = container.textContent ?? '';
        if (!text.trim() || text.includes('لوڈ ہو رہا ہے')) throw new Error('still loading');
      });
      await new Promise((r) => setTimeout(r, 50));
      const latin = uiText(container).match(/[A-Za-z]{2,}/g) ?? [];
      expect(latin, `untranslated: ${latin.join(', ')}`).toEqual([]);
    },
  );
});

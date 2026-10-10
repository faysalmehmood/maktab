import type { AuditListDto, IncomeExpenseDto, MonthDashboardDto, PayslipDto } from '@maktab/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FeeSetup } from '@/components/fees/setup';
import { PayslipStatusBadge, payOutAccounts } from '@/components/money/common';
import { MonthTiles } from '@/components/money/MonthTiles';
import { initI18n, setLanguage } from '@/i18n';
import { karachiToday } from '@/lib/fees';
import { AuditPage } from '@/pages/money/Audit';
import { ExpensesPage } from '@/pages/money/Expenses';
import { IncomeExpensePage } from '@/pages/money/Reports';
import { mockApi, renderAt } from './api-mock';
import { feeSettings } from './fee-fixtures';

// M4 fix pass on the web: owner-pay labels (F1, F8), "Partly paid", own-drawer pickers (F3), the
// opening balance form, translated audit labels and the expenses checkbox's 44 px target.

const RS = (n: number) => n * 100;
const today = karachiToday();
const period = today.slice(0, 7);
const byId = (id: string) =>
  waitFor(() => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  });

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

const ieAcct: IncomeExpenseDto = {
  from: period,
  to: period,
  income: { by_head: [], unallocated: 0, total: RS(5000) },
  expenses: { by_category: [], total: 0 },
  salaries: { pay: RS(55000), slips: 2, scope: 'excluding_owners' },
  net: RS(5000) - RS(55000),
  months: [{ period, income: RS(5000), expenses: 0, salaries: RS(55000), net: -RS(50000) }],
  reconciliation: { ties: true },
};

describe('F1/F8: salaries without management', () => {
  it('income vs expense says "Salaries (excluding management)" (en/ur), tooltip explains; no reconciliation lines', async () => {
    mockApi({ 'GET /api/reports/income-expense': ieAcct });
    renderAt('/reports/income-expense', '/reports/income-expense', <IncomeExpensePage />, [
      'accountant',
    ]);
    await byId('ie-totals');
    const labels = document.querySelectorAll('.salaries-label');
    expect(labels.length).toBe(3);
    for (const l of labels) {
      expect(l.textContent).toBe('Salaries (excluding management)');
      expect(l.getAttribute('title')).toMatch(/earnings less deductions/);
    }
    expect(document.getElementById('ie-rec-lines')).toBeNull();
    expect((await byId('ie-reconciliation')).textContent).toContain('The books tie out.');
    await act(() => setLanguage('ur'));
    await waitFor(() =>
      expect(document.querySelector('.salaries-label')?.textContent).toBe(
        'تنخواہیں (انتظامیہ کے علاوہ)',
      ),
    );
    expect(document.querySelector('.salaries-label')?.getAttribute('title')).toMatch(/کٹوتیاں/);
  });

  it('the owner sees "Salaries" and the reconciliation lines', async () => {
    mockApi({
      'GET /api/reports/income-expense': {
        ...ieAcct,
        salaries: { pay: RS(145000), slips: 3, scope: 'all' },
        reconciliation: {
          income: RS(5000),
          expenses: 0,
          salary_paid: RS(145000),
          advances_paid: 0,
          expected_movement: -RS(140000),
          movement: -RS(140000),
          ties: true,
        },
      },
    });
    renderAt('/reports/income-expense', '/reports/income-expense', <IncomeExpensePage />);
    await byId('ie-rec-lines');
    expect(document.querySelector('.salaries-label')?.textContent).toBe('Salaries');
  });

  it('the month tile says so too', async () => {
    const month: MonthDashboardDto = {
      period,
      income: RS(5000),
      expenses: 0,
      salaries: RS(55000),
      salaries_scope: 'excluding_owners',
      net: -RS(50000),
      dues_outstanding: 0,
      defaulters: 0,
      admissions: 0,
      left: 0,
    };
    mockApi({ 'GET /api/dashboard/month': month });
    renderAt('/', '/', <MonthTiles />, ['accountant']);
    expect((await byId('tile-month-spending')).textContent).toContain(
      'Expenses + salaries (excluding management)',
    );
  });
});

describe('payslip status and pickers', () => {
  it('"Partly paid" for an approved slip with something paid', () => {
    render(<PayslipStatusBadge status="approved" partial />);
    expect(screen.getByText('Partly paid')).toBeTruthy();
    const slip = { status: 'paid', paid_partial: false } as PayslipDto;
    render(<PayslipStatusBadge status={slip.status} partial={slip.paid_partial} />);
    expect(screen.getByText('Paid')).toBeTruthy();
  });

  it('pay-out pickers offer my drawer and the bank, never another drawer', () => {
    const list = [
      { id: 'D1', name: 'Mine', kind: 'cash', holder_staff_id: null },
      { id: 'D2', name: 'Theirs', kind: 'cash', holder_staff_id: 'S2' },
      { id: 'B', name: 'Bank', kind: 'bank', holder_staff_id: null },
    ] as const;
    expect(payOutAccounts(list, 'D1').map((a) => a.id)).toEqual(['D1', 'B']);
    expect(payOutAccounts(list, null).map((a) => a.id)).toEqual(['B']);
  });
});

describe('Settings → Fees → Accounts: opening balance', () => {
  const api = (calls?: unknown) => ({
    'GET /api/school/fees': feeSettings,
    'GET /api/fees/heads': { heads: [] },
    'GET /api/fees/rates': { rates: [] },
    'GET /api/programmes': { items: [] },
    'GET /api/groups': { items: [] },
    'GET /api/staff': { items: [] },
    'GET /api/accounts': {
      accounts: [
        {
          id: 'B',
          name: 'HBL',
          kind: 'bank',
          holder_staff_id: null,
          opening_balance: 0,
          opening_as_of: null,
          has_movements: false,
        },
        {
          id: 'D',
          name: 'Drawers',
          kind: 'cash',
          holder_staff_id: null,
          opening_balance: RS(3000),
          opening_as_of: '2026-09-30',
          has_movements: true,
        },
      ],
      my_drawer: 'D',
    },
    'POST /api/accounts/B/opening': calls ?? { account: null },
  });

  it('the owner sets it once (rupees → paisa); a set one is shown, not editable', async () => {
    const { calls } = mockApi(api());
    renderAt('/settings', '/settings', <FeeSetup />, ['owner']);
    await byId('opening-form-B');
    expect(document.getElementById('opening-form-D')).toBeNull();
    expect(document.querySelector('[data-opening="D"]')?.textContent).toContain('2026-09-30');
    fireEvent.change(await byId('opening-amount-B'), { target: { value: '2,500' } });
    fireEvent.change(await byId('opening-date-B'), { target: { value: '2026-09-30' } });
    fireEvent.submit(await byId('opening-form-B'));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
        ['/api/accounts/B/opening', { amount: RS(2500), as_of: '2026-09-30' }],
      ]),
    );
  });

  it('an admin sees no opening form', async () => {
    mockApi(api());
    renderAt('/settings', '/settings', <FeeSetup />, ['admin']);
    await waitFor(() => expect(document.getElementById('accounts-list')?.children.length).toBe(2));
    expect(document.getElementById('opening-form-B')).toBeNull();
  });
});

describe('audit labels (en/ur)', () => {
  const audit: AuditListDto = {
    rows: [
      {
        id: 'A1',
        at: `${today}T10:00:00.000Z`,
        user_id: 'U',
        user_name: 'Owner',
        entity: 'staff_advance',
        entity_id: 'X',
        action: 'create',
        diff: null,
      },
      {
        id: 'A2',
        at: `${today}T10:01:00.000Z`,
        user_id: 'U',
        user_name: 'Owner',
        entity: 'mystery_thing',
        entity_id: 'Y',
        action: 'zap',
        diff: null,
      },
    ],
    next: null,
  };
  it('words for record type and action, the raw code as tooltip; unknown codes as they are', async () => {
    mockApi({
      'GET /api/audit': audit,
      'GET /api/audit/entities': { entities: [{ entity: 'staff_advance', n: 1 }] },
    });
    renderAt('/audit', '/audit', <AuditPage />);
    await waitFor(() => expect(screen.getByText('Staff advance')).toBeTruthy());
    expect(screen.getByText('Staff advance').getAttribute('title')).toBe('staff_advance');
    expect(screen.getByText('Created').getAttribute('title')).toBe('create');
    expect(screen.getByText('mystery_thing')).toBeTruthy();
    expect(screen.getByText('zap')).toBeTruthy();
    await act(() => setLanguage('ur'));
    await waitFor(() => expect(screen.getByText('عملے کا ایڈوانس')).toBeTruthy());
    expect(screen.getByText('بنایا').getAttribute('title')).toBe('create');
    await waitFor(() =>
      expect(
        [...document.querySelectorAll('#audit-entity option')].map((o) => o.textContent),
      ).toContain('عملے کا ایڈوانس (1)'),
    );
  });
});

describe('44 px targets', () => {
  it('the expenses "show voided" checkbox sits in a 44 px row label', async () => {
    mockApi({
      'GET /api/accounts': { accounts: [], my_drawer: null },
      'GET /api/expenses/categories': { categories: [] },
      'GET /api/expenses': { expenses: [], total: 0, from: today, to: today },
    });
    renderAt('/expenses', '/expenses', <ExpensesPage />, ['owner']);
    const box = await byId('exp-include-void');
    const label = box.closest('label');
    expect(label?.className).toMatch(/\bmin-h-11\b/);
    expect(label?.textContent).toContain('Show voided');
  });
});

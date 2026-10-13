import type { PayslipDetailDto, PayslipDto } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { karachiToday } from '@/lib/fees';
import {
  MyPayslipsPage,
  PayslipPage,
  PayslipPrintPage,
  SalaryPage,
  SalaryRegisterPage,
} from '@/pages/money/Salary';
import { mockApi, renderAt } from './api-mock';

const RS = (n: number) => n * 100;
const SLIP = '01JSLIP00000000000000000001';
const period = karachiToday().slice(0, 7);

const slipRow = (o: Partial<PayslipDto> = {}): PayslipDto => ({
  id: SLIP,
  staff_id: 'ST1',
  staff_name: 'Ayesha Bibi',
  staff_role: 'teacher',
  period_key: period,
  status: 'draft',
  earnings: RS(32000),
  deductions: 0,
  recovery: RS(2000),
  pay: RS(32000),
  net: RS(30000),
  paid: 0,
  paid_partial: false,
  approved_by_name: null,
  approved_at: null,
  void_reason: null,
  ...o,
});

const slip = (o: Partial<PayslipDetailDto> = {}): PayslipDetailDto => ({
  ...slipRow(),
  lines: [
    { id: 'L1', kind: 'basic', amount: RS(30000), note: null },
    { id: 'L2', kind: 'allowance', amount: RS(2000), note: 'Transport' },
    { id: 'L3', kind: 'advance_recovery', amount: RS(2000), note: null },
  ],
  payments: [],
  advance: { advanced: RS(5000), recovered: 0, outstanding: RS(5000) },
  can_approve: true,
  school: { name: 'Al-Noor School', name_ur: 'النور سکول', address: null, phone: '0300-1234567' },
  ...o,
});

const accounts = {
  accounts: [
    { id: 'ACC-CASH', name: 'Drawers', kind: 'cash', holder_staff_id: null },
    { id: 'ACC-BANK', name: 'HBL', kind: 'bank', holder_staff_id: null },
    // Someone else's drawer: never offered for paying out (F3).
    { id: 'ACC-OTHER', name: 'Other drawer', kind: 'cash', holder_staff_id: 'ST9' },
  ],
  my_drawer: 'ACC-CASH',
};

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

const byId = (id: string) =>
  waitFor(() => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  });
const calls = (
  api: { calls: { method: string; path: string; body: unknown }[] },
  m: string,
  p: string,
) => api.calls.filter((c) => c.method === m && c.path.split('?')[0] === p).map((c) => c.body);

describe('salary page', () => {
  it('Prepare payslips loops on `next` until the last chunk', async () => {
    let n = 0;
    const api = mockApi({
      'GET /api/payslips': { payslips: [], totals: { pay: 0, net: 0, paid: 0 } },
      'GET /api/payroll/staff': { staff: [] },
      'POST /api/payslips/generate': () =>
        ++n === 1
          ? { created: 50, skipped: 0, next: 'ST50' }
          : { created: 7, skipped: 1, next: null },
    });
    renderAt('/salary', '/salary', <SalaryPage />, ['accountant']);
    fireEvent.click(await byId('salary-generate'));
    await waitFor(() =>
      expect(calls(api, 'POST', '/api/payslips/generate')).toEqual([
        { period, after: null },
        { period, after: 'ST50' },
      ]),
    );
    // Pay settings are for owner/admin only.
    expect(document.querySelector('[id^="pay-edit-"]')).toBeNull();
  });

  it('lists slips with links and totals', async () => {
    mockApi({
      'GET /api/payslips': {
        payslips: [slipRow({ status: 'approved', paid: RS(10000) })],
        totals: { pay: RS(32000), net: RS(30000), paid: RS(10000) },
      },
      'GET /api/payroll/staff': { staff: [] },
    });
    renderAt('/salary', '/salary', <SalaryPage />, ['owner']);
    expect((await byId(`slip-link-${SLIP}`)).getAttribute('href')).toBe(`/salary/${SLIP}`);
    expect((await byId('slips-totals')).textContent).toContain('PKR 20,000');
  });
});

describe('payslip page', () => {
  const open = (s: PayslipDetailDto, roles: Parameters<typeof renderAt>[3], extra = {}) => {
    const api = mockApi({
      [`GET /api/payslips/${SLIP}`]: { payslip: s },
      'GET /api/accounts': accounts,
      ...extra,
    });
    renderAt(`/salary/${SLIP}`, '/salary/:id', <PayslipPage />, roles);
    return api;
  };

  it('lines editor refuses an empty set and a negative net, then saves', async () => {
    const api = open(slip(), ['accountant'], {
      [`PUT /api/payslips/${SLIP}/lines`]: { payslip: slip() },
    });
    await byId('lines-save');
    for (const _ of [0, 1, 2]) fireEvent.click(await byId('line-remove-0'));
    fireEvent.click(await byId('lines-save'));
    expect((await byId('lines-error')).textContent).toMatch(/at least one line/);
    fireEvent.click(await byId('lines-add'));
    fireEvent.change(await byId('line-amount-0'), { target: { value: '500' } });
    fireEvent.click(await byId('lines-save'));
    expect((await byId('lines-error')).textContent).toMatch(/more than the pay/);
    fireEvent.change(await byId('line-kind-0'), { target: { value: 'basic' } });
    fireEvent.click(await byId('lines-save'));
    await waitFor(() =>
      expect(calls(api, 'PUT', `/api/payslips/${SLIP}/lines`)).toEqual([
        { lines: [{ kind: 'basic', amount: RS(500), note: null }] },
      ]),
    );
    // An accountant neither approves nor voids: no row menu at all.
    expect(document.getElementById('slip-void')).toBeNull();
    expect(document.getElementById('slip-more')).toBeNull();
  });

  it('own slip: no Approve, the own-slip note instead', async () => {
    open(slip({ can_approve: false }), ['owner']);
    await byId('slip-own');
    expect(document.getElementById('slip-approve')).toBeNull();
  });

  it('approve posts after confirming', async () => {
    const api = open(slip(), ['admin'], {
      [`POST /api/payslips/${SLIP}/approve`]: {
        payslip: slip({ status: 'approved', can_approve: false }),
      },
    });
    fireEvent.click(await byId('slip-approve'));
    fireEvent.click(await byId('approve-confirm'));
    await waitFor(() =>
      expect(calls(api, 'POST', `/api/payslips/${SLIP}/approve`)).toHaveLength(1),
    );
  });

  it('pay: more than left refused; cash fixes the date to today; body has id, amount, account', async () => {
    const s = slip({ status: 'approved', can_approve: false, paid: RS(10000) });
    const api = open(s, ['accountant'], {
      [`POST /api/payslips/${SLIP}/pay`]: { payslip: { ...s, paid: RS(15000) } },
    });
    fireEvent.click(await byId('slip-pay'));
    const amount = (await byId('pay-amount')) as HTMLInputElement;
    expect(amount.value).toBe('20000');
    fireEvent.change(amount, { target: { value: '20001' } });
    fireEvent.change(await byId('pay-account'), { target: { value: 'ACC-CASH' } });
    fireEvent.click(await byId('pay-confirm'));
    await byId('pay-over');
    expect(calls(api, 'POST', `/api/payslips/${SLIP}/pay`)).toEqual([]);
    const date = (await byId('pay-date')) as HTMLInputElement;
    expect([date.value, date.disabled]).toEqual([karachiToday(), true]);
    fireEvent.change(amount, { target: { value: '5000' } });
    fireEvent.click(await byId('pay-confirm'));
    await waitFor(() => expect(calls(api, 'POST', `/api/payslips/${SLIP}/pay`)).toHaveLength(1));
    const body = calls(api, 'POST', `/api/payslips/${SLIP}/pay`)[0] as Record<string, unknown>;
    expect(body).toMatchObject({ amount: RS(5000), account_id: 'ACC-CASH', date: karachiToday() });
    expect(typeof body.id).toBe('string');
  });

  it('void needs a reason', async () => {
    const api = open(slip(), ['admin'], {
      [`POST /api/payslips/${SLIP}/void`]: { payslip: slip({ status: 'void' }) },
    });
    // Void is the destructive item of the payslip's row menu (M7b-2), still behind its reason.
    fireEvent.keyDown(await byId('slip-more'), { key: 'Enter' });
    const item = within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Void' });
    expect(item.dataset.destructive).toBe('true');
    fireEvent.click(item);
    fireEvent.click(await byId('slip-void-confirm'));
    expect(calls(api, 'POST', `/api/payslips/${SLIP}/void`)).toEqual([]);
    fireEvent.change(await byId('slip-void-reason'), { target: { value: 'left school' } });
    fireEvent.click(await byId('slip-void-confirm'));
    await waitFor(() =>
      expect(calls(api, 'POST', `/api/payslips/${SLIP}/void`)).toEqual([{ reason: 'left school' }]),
    );
  });
});

describe('my payslips (teacher)', () => {
  it('renders own slips with lines on demand and a print link', async () => {
    mockApi({
      'GET /api/payslips/mine': { payslips: [slip({ status: 'paid', paid: RS(30000) })] },
    });
    renderAt('/my/payslips', '/my/payslips', <MyPayslipsPage />, ['teacher']);
    fireEvent.click(await byId(`mine-toggle-${SLIP}`));
    expect(await screen.findByText('Transport')).toBeTruthy();
    expect(screen.getByRole('link', { name: /print slip/i }).getAttribute('href')).toBe(
      `/payslips/${SLIP}/print`,
    );
  });

  it('empty state', async () => {
    mockApi({ 'GET /api/payslips/mine': { payslips: [] } });
    renderAt('/my/payslips', '/my/payslips', <MyPayslipsPage />, ['teacher']);
    await byId('mine-empty');
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
    if (['BDI', 'OPTION', 'SCRIPT', 'STYLE'].includes(n.tagName)) return;
    if (n.classList.contains('num') || n.getAttribute('lang') === 'en') return;
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out.join(' ');
}

const RTL_API = {
  'GET /api/payslips': {
    payslips: [slipRow({ status: 'approved' })],
    totals: { pay: RS(32000), net: RS(30000), paid: 0 },
  },
  'GET /api/reports/salaries': {
    payslips: [slipRow({ status: 'paid', paid: RS(30000) })],
    totals: { pay: RS(32000), net: RS(30000), paid: RS(30000) },
  },
  'GET /api/payroll/staff': {
    staff: [
      {
        id: 'ST1',
        name: 'Ayesha Bibi',
        role: 'teacher',
        status: 'active',
        joined: null,
        base_salary: RS(30000),
        allowances: [],
        outstanding_advance: 0,
      },
    ],
  },
  [`GET /api/payslips/${SLIP}`]: {
    payslip: slip({
      status: 'approved',
      approved_by_name: 'Owner',
      payments: [
        {
          id: 'P1',
          amount: RS(1000),
          account_id: 'A',
          account_name: 'HBL',
          date: '2026-10-05',
          note: null,
        },
      ],
    }),
  },
  'GET /api/payslips/mine': { payslips: [slip({ status: 'paid' })] },
  'GET /api/accounts': accounts,
};

const PAGES: [string, string, string, ReactNode][] = [
  ['salary', '/salary', '/salary', <SalaryPage key="s" />],
  ['payslip', `/salary/${SLIP}`, '/salary/:id', <PayslipPage key="p" />],
  [
    'slip print',
    `/payslips/${SLIP}/print?lang=ur`,
    '/payslips/:id/print',
    <PayslipPrintPage key="pp" />,
  ],
  ['my payslips', '/my/payslips', '/my/payslips', <MyPayslipsPage key="m" />],
  ['salary register', '/reports/salaries', '/reports/salaries', <SalaryRegisterPage key="r" />],
];

describe('RTL smoke: payroll pages in Urdu', () => {
  it.each(PAGES)(
    '%s: dir=rtl and no English outside isolated data',
    async (_n, path, pattern, el) => {
      await act(() => setLanguage('ur'));
      mockApi(RTL_API);
      const { container } = renderAt(path, pattern, el, ['owner']);
      expect(document.documentElement.dir).toBe('rtl');
      await waitFor(() => {
        const text = container.textContent ?? '';
        if (!text.trim() || text.includes('لوڈ ہو رہا ہے') || !container.querySelector('bdi'))
          throw new Error('still loading');
      });
      await new Promise((r) => setTimeout(r, 50));
      const latin = uiText(container).match(/[A-Za-z]{2,}/g) ?? [];
      expect(latin, `untranslated: ${latin.join(', ')}`).toEqual([]);
    },
  );
});

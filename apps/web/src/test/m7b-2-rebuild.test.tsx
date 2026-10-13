import 'fake-indexeddb/auto';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { BillingPage } from '@/pages/fees/Billing';
import { ConcessionRegisterPage, FeeRegisterPage } from '@/pages/fees/Reports';
import { group, ids, mockApi, renderAt } from './api-mock';
import { line } from './fee-fixtures';

/*
 * M7b part 2 fix pass: the rebuilt Fee register, Concessions, Billing and Advances screens
 * (prompt and empty states, DataTable rows, row menus, dialogs, the attention panel).
 */

const RS = (n: number) => n * 100;
const stubResizeObserver = () =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
const byId = (id: string) =>
  waitFor(() => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  });
const openMenu = async (name: string | RegExp) => {
  fireEvent.keyDown(await screen.findByRole('button', { name }), { key: 'Enter' });
  return screen.findByRole('menu');
};

beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  stubResizeObserver();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fee register (rebuilt)', () => {
  const G2 = '01JAAAAAAAAAAAAAAAAAAAAAG2';
  const rows = [
    {
      ...line({ id: 'L1', status: 'paid', paid: RS(3000), due: 0 }),
      father_name: 'Imran',
      roll_no: '7',
    },
    {
      ...line({ id: 'L2', student_id: 'S2', student_name: 'Sara' }),
      father_name: null,
      roll_no: null,
    },
  ];
  it('asks for a class first (no request), then shows totals, rows, CSV and Print', async () => {
    const api = mockApi({
      'GET /api/groups': { items: [group, { ...group, id: G2, name: 'B' }] },
      'GET /api/fees/register': { rows, totals: { net: RS(6000), paid: RS(3000), due: RS(3000) } },
    });
    renderAt('/fees/register', '/fees/register', <FeeRegisterPage />, ['owner']);
    expect(await screen.findByText('Choose a class to see its register')).toBeTruthy();
    expect(api.calls.some((c) => c.path.startsWith('/api/fees/register'))).toBe(false);
    expect(document.getElementById('register-csv')).toBeNull();
    const select = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: G2 } });
    const table = await byId('register-table');
    expect(within(table).getByText('Sara')).toBeTruthy();
    expect(within(table).getByText('Imran')).toBeTruthy();
    expect(document.getElementById('reg-students')?.textContent).toContain('2');
    expect(document.getElementById('reg-due')?.textContent).toContain('3,000');
    expect(document.getElementById('register-csv')?.getAttribute('href')).toMatch(
      new RegExp(`grp_id=${G2}&period=\\d{4}-\\d{2}&format=csv$`),
    );
    expect(document.getElementById('register-print')).toBeTruthy();
  });

  it('an empty month says so and points to Billing', async () => {
    mockApi({
      'GET /api/groups': { items: [group] },
      'GET /api/fees/register': { rows: [], totals: {} },
    });
    renderAt('/fees/register', '/fees/register', <FeeRegisterPage />, ['owner']);
    const select = (await byId('register-group')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: ids.group } });
    expect(await screen.findByText('No fees billed for this class this month')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open billing' }).getAttribute('href')).toBe(
      '/fees/billing',
    );
  });
});

describe('concessions (rebuilt)', () => {
  const row = {
    id: 'C1',
    student_id: 'S1',
    student_name: 'Hina',
    admission_no: 'A-9',
    head_name: null,
    type: 'pct',
    value: 50,
    reason: 'topper',
    note: null,
    approved_by_name: 'Owner',
    valid_from: '2026-04-01',
    valid_to: null,
    ended_at: null,
    end_reason: null,
    amount_given: RS(1500),
  };
  const routes = {
    'GET /api/fees/concessions/register': { concessions: [row], total_given: RS(1500) },
    'GET /api/fees/heads': { heads: [] },
    'GET /api/students': {
      items: [{ id: 'S7', name: 'Bilal Khan', admission_no: '2026-0007' }],
      total: 1,
      page: 1,
    },
    'POST /api/fees/concessions/C1/end': { ok: true },
  };

  it('End is the destructive item of the row menu and opens the end dialog', async () => {
    mockApi(routes);
    renderAt('/fees/concessions', '/fees/concessions', <ConcessionRegisterPage />, ['owner']);
    expect(document.getElementById('con-given')?.textContent ?? '').toBe('');
    const menu = await openMenu('More actions: Hina');
    const item = within(menu).getByRole('menuitem', { name: 'End this concession' });
    expect(item.dataset.destructive).toBe('true');
    fireEvent.click(item);
    expect(await byId('concession-end-date')).toBeTruthy();
    expect(document.getElementById('con-given')?.textContent).toContain('1,500');
  });

  it('Add: pick a student, then the "Reduce fee" dialog for that student', async () => {
    const api = mockApi(routes);
    renderAt('/fees/concessions', '/fees/concessions', <ConcessionRegisterPage />, ['owner']);
    fireEvent.click(await byId('concession-add'));
    fireEvent.change(await byId('concession-student-search'), { target: { value: 'Bil' } });
    const pick = await waitFor(() => {
      const el = document.querySelector('[data-pick="S7"]');
      if (!el) throw new Error('no result');
      return el as HTMLElement;
    });
    expect(api.calls.some((c) => c.path.startsWith('/api/students?q=Bil&status=active'))).toBe(
      true,
    );
    fireEvent.click(pick);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Bilal Khan')).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Reduce fee' })).toBeTruthy();
  });

  it('an accountant reads the register without Add or row menus', async () => {
    mockApi(routes);
    renderAt('/fees/concessions', '/fees/concessions', <ConcessionRegisterPage />, ['accountant']);
    await screen.findByText('Hina');
    expect(document.getElementById('concession-add')).toBeNull();
    expect(screen.queryByRole('button', { name: /^More actions/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Fee register' }).getAttribute('href')).toBe(
      '/fees/register',
    );
  });
});

describe('billing (rebuilt)', () => {
  it('one attention panel holds the failing groups and the months to re-open', async () => {
    mockApi({
      'GET /api/groups': { items: [group] },
      'GET /api/fees/unbilled': { period: '2026-10', items: [], more: false },
      'GET /api/fees/runs': {
        period: '2026-10',
        complete: false,
        failing: [
          {
            grp_id: ids.group,
            fail_streak: 3,
            error_code: 'constraint',
            retry_after: null,
            attention_required: true,
          },
        ],
        attention_required: 1,
        reopenable: [ids.group],
        chunks: [
          {
            id: 'K1',
            grp_id: ids.group,
            status: 'failed',
            fees: 0,
            concessions: 0,
            sponsored: 0,
            fines: 0,
            error_code: 'constraint',
            created_at: '2026-10-10T19:30:00.000Z',
          },
        ],
      },
    });
    renderAt('/fees/billing', '/fees/billing', <BillingPage />, ['owner']);
    const panel = await byId('billing-attention-panel');
    await waitFor(() => expect(within(panel).getByText(/failed three times/)).toBeTruthy());
    expect(panel.querySelector('#billing-failing')?.textContent).toContain(
      'Refused by a ledger rule',
    );
    expect(panel.querySelector('#billing-reopenable')).toBeTruthy();
    const runs = await byId('billing-chunks');
    expect(within(runs).getByText('Failed')).toBeTruthy();
    expect(within(runs).getByText('2026-10-11 00:30')).toBeTruthy();
    expect(screen.getByText('Every enrolled student is billed for this month.')).toBeTruthy();
  });

  it('no attention panel when nothing is wrong', async () => {
    mockApi({
      'GET /api/groups': { items: [] },
      'GET /api/fees/unbilled': { period: '2026-10', items: [], more: false },
      'GET /api/fees/runs': {
        period: '2026-10',
        complete: true,
        failing: [],
        attention_required: 0,
        chunks: [],
      },
    });
    renderAt('/fees/billing', '/fees/billing', <BillingPage />, ['owner']);
    expect(await screen.findByText('Nothing generated for this month yet.')).toBeTruthy();
    expect(document.getElementById('billing-attention-panel')).toBeNull();
  });
});

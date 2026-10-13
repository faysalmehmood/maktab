import 'fake-indexeddb/auto';
import type { RegisterResponse } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import * as ob from '@/offline/outbox';
import { _reset } from '@/offline/sync';
import { RegisterPage } from '@/pages/attendance/Register';
import { CounterPage } from '@/pages/fees/Counter';
import { ReceiptPage } from '@/pages/fees/Receipt';
import { ids, meAs, mockApi, renderAt } from './api-mock';
import { accounts, fam, familyStatement, receiptId, receiptPrint } from './fee-fixtures';

/*
 * M7b part 2 (screens): the key interactions of each restyled screen. Money, permission and
 * offline rules are covered by their own suites; these pin what the new layouts add.
 */

let n = 0;
beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  ob._close();
  ob.configure({ dbName: `m7b2-${n++}`, now: () => Date.now(), userId: meAs(['admin']).user.id });
  _reset();
});

describe('attendance register (M7b-2)', () => {
  const date = '2026-10-08';
  const row = (id: string, name: string, roll: string) => ({
    student_id: id,
    name,
    roll_no: roll,
    admission_no: `2026-${roll}`,
    has_photo: false,
    status: null,
    note: null,
  });
  const register = (over: Partial<RegisterResponse> = {}): RegisterResponse => ({
    grp_id: ids.group,
    grp_name: 'A',
    programme_name: 'Class 5',
    date,
    grp_subject_id: '',
    day_off: null,
    rows: [
      row('01JAAAAAAAAAAAAAAAAAAAAAS1', 'Ali Khan', '1'),
      row('01JAAAAAAAAAAAAAAAAAAAAAS2', 'Sara Khan', '2'),
      row('01JAAAAAAAAAAAAAAAAAAAAAS3', 'Omar Ali', '3'),
    ],
    current: null,
    history: [],
    ...over,
  });
  const path = `/attendance/register/${ids.group}?date=${date}`;
  const pattern = '/attendance/register/:grpId';

  it('shows progress first and keeps it live as marks cycle P → A → L → E', async () => {
    mockApi({ 'GET /api/attendance/register': register() });
    renderAt(path, pattern, <RegisterPage />, ['teacher']);
    await screen.findByText('3 of 3 present');
    const bar = document.querySelector('[data-action-bar]') as HTMLElement;
    const sara = () => screen.getByRole('button', { name: /^Sara Khan:/ });
    expect(sara().getAttribute('aria-label')).toBe('Sara Khan: Present');
    fireEvent.click(sara());
    expect(sara().getAttribute('aria-label')).toBe('Sara Khan: Absent');
    expect(screen.getByText('2 of 3 present')).toBeTruthy();
    // The row is tinted for its exception; the live counts in the save bar move with it.
    expect(sara().closest('li')?.dataset.status).toBe('A');
    expect(within(bar).getByTitle('Absent').textContent).toBe('A 1');
    fireEvent.click(sara());
    fireEvent.click(sara());
    expect(sara().getAttribute('aria-label')).toBe('Sara Khan: Leave');
    fireEvent.click(sara());
    expect(sara().getAttribute('aria-label')).toBe('Sara Khan: Present');
    expect(screen.getByText('3 of 3 present')).toBeTruthy();
    // A back link to the day's list; nothing says "correction" for a teacher's first register.
    expect(screen.getByRole('link', { name: 'Attendance' }).getAttribute('href')).toBe(
      '/attendance',
    );
    expect(document.getElementById('correction-mode')).toBeNull();
  });

  it('an admin opening a taken register sees correction mode before saving, and Save asks for a reason', async () => {
    const current = {
      register_id: 'R1',
      taken_by_name: 'Ms Sana',
      taken_at: '2026-10-08T03:00:00Z',
    };
    mockApi({
      'GET /api/attendance/register': register({
        current,
        history: [
          {
            ...current,
            received_at: current.taken_at,
            is_current: true,
            kind: 'sync',
            reason: null,
            counts: { P: 3, A: 0, L: 0, E: 0 },
          },
        ],
      }),
    });
    renderAt(path, pattern, <RegisterPage />, ['admin']);
    expect(await screen.findByText(/Saving makes a correction/)).toBeTruthy();
    // Back goes to the same day (an earlier date) on the office list.
    expect(screen.getByRole('link', { name: 'Attendance' }).getAttribute('href')).toBe(
      `/attendance?date=${date}`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Correct this register' }));
    expect(await screen.findByLabelText('Reason for the correction')).toBeTruthy();
  });
});

describe('fee counter and receipt result (M7b-2)', () => {
  it('"Full due" fills the amount with the net due; the preview then pays every open line', async () => {
    mockApi({ [`GET /api/fees/family/${fam}`]: familyStatement(), 'GET /api/accounts': accounts });
    renderAt(`/fees/counter?family=${fam}`, '/fees/counter', <CounterPage />, ['owner']);
    const amount = (await screen.findByLabelText(/Amount/)) as HTMLInputElement;
    expect(screen.getByText('Type an amount to see which months it pays.')).toBeTruthy();
    const net = familyStatement().totals.due;
    fireEvent.click(screen.getByRole('button', { name: /Full due/ }));
    expect(amount.value).toBe((net / 100).toLocaleString('en-US'));
    const after = document.getElementById('allocation-after') as HTMLElement;
    expect(after.textContent).toContain('PKR 0');
    // The children show as chips with their initials; Collect sits in the action bar.
    expect(
      screen.getAllByText('Ali')[0]?.closest('li')?.querySelector('[data-avatar]'),
    ).toBeTruthy();
    const bar = document.querySelector('[data-action-bar]') as HTMLElement;
    expect(within(bar).getByRole('button', { name: 'Confirm and issue receipt' })).toBeTruthy();
    expect(bar.style.bottom).toBe('var(--tabbar-h, 0px)');
  });

  it("result screen: school header, amount, still due, and Reverse only inside the owner's menu", async () => {
    mockApi({
      [`GET /api/receipts/${receiptId}`]: receiptPrint(),
      [`POST /api/receipts/${receiptId}/parent-link`]: { url: null },
    });
    renderAt(`/receipts/${receiptId}?lang=en`, '/receipts/:id', <ReceiptPage />, ['owner']);
    const result = await waitFor(() => {
      const el = document.getElementById('receipt-result');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(within(result).getByText('Payment received')).toBeTruthy();
    expect(document.getElementById('receipt-amount')?.textContent).toBe('PKR 7,000');
    // Reverse is not a button on the page; it is the destructive item of the "more" menu.
    expect(screen.queryByRole('button', { name: 'Reverse' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: /^More actions: / }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const item = within(menu).getByRole('menuitem', { name: 'Reverse' });
    expect(item.dataset.destructive).toBe('true');
    fireEvent.click(item);
    expect(await screen.findByText('Reverse this receipt')).toBeTruthy();
  });

  it('an accountant gets no "more" menu on the receipt (no Reverse grant)', async () => {
    mockApi({ [`GET /api/receipts/${receiptId}`]: receiptPrint() });
    renderAt(`/receipts/${receiptId}?lang=en`, '/receipts/:id', <ReceiptPage />, ['accountant']);
    await screen.findByText('Payment received');
    expect(screen.queryByRole('button', { name: /^More actions: / })).toBeNull();
    expect(document.getElementById('receipt-print')).toBeTruthy();
  });
});

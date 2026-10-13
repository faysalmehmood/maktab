import 'fake-indexeddb/auto';
import type { RegisterResponse, StudentDetailDto } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import * as ob from '@/offline/outbox';
import { _reset } from '@/offline/sync';
import { RegisterPage } from '@/pages/attendance/Register';
import { CounterPage } from '@/pages/fees/Counter';
import { ReceiptPage } from '@/pages/fees/Receipt';
import { GroupDetail, GroupsPage } from '@/pages/Groups';
import { StudentDetail } from '@/pages/students/StudentDetail';
import { group, ids, meAs, mockApi, renderAt, session } from './api-mock';
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

describe('student profile (M7b-2)', () => {
  const detail: StudentDetailDto = {
    id: ids.student,
    family_id: ids.family,
    admission_no: '2026-0001',
    name: 'Ali Raza',
    father_name: 'Imran',
    dob: null,
    gender: 'm',
    b_form_no: null,
    has_photo: false,
    admission_date: '2026-04-01',
    status: 'active',
    left_date: null,
    left_reason: null,
    extra: {},
    family: { id: ids.family, name: 'Raza', address: null, area: null },
    guardians: [],
    enrolments: [
      {
        id: 'E1',
        student_id: ids.student,
        grp_id: ids.group,
        grp_name: '5-A',
        programme_name: 'Class 5',
        session_id: ids.session,
        is_primary: true,
        roll_no: '7',
        start_date: '2026-04-01',
        end_date: null,
        status: 'active',
        end_reason: null,
        prev_enrolment_id: null,
      },
    ],
  };
  const setup = (roles: Parameters<typeof renderAt>[3]) => {
    const api = mockApi({
      [`GET /api/students/${ids.student}`]: detail,
      [`GET /api/families/${ids.family}`]: { ...detail.family, guardians: [], students: [] },
      'GET /api/custom-fields': { items: [] },
      [`GET /api/attendance/student/${ids.student}`]: { days: [], pct: 92 },
      [`GET /api/fees/student/${ids.student}`]: {
        due: 570000,
        family_due: 1140000,
        family_credit: 0,
        lines: [],
        sponsored: [],
        concessions: [],
        sponsorships: [],
        opening_balance: null,
        receipts: [],
        student: {
          id: ids.student,
          name: 'Ali Raza',
          admission_no: '2026-0001',
          family_id: ids.family,
        },
        family_name: 'Raza',
      },
      'GET /api/messages': {
        items: [
          {
            id: 'M1',
            family_id: ids.family,
            family_name: 'Raza',
            template_key: 'absence',
            lang: 'ur',
            status: 'queued',
            created_at: '2026-10-12T04:00:00Z',
            preview: 'علی آج غیر حاضر ہے',
          },
        ],
        total: 1,
        counts: {},
      },
    });
    renderAt(`/students/${ids.student}`, '/students/:id', <StudentDetail />, roles);
    return api;
  };

  it('summary strip first (class + roll, attendance %, dues), then tabs; Messages asks for this family only', async () => {
    const api = setup(['owner']);
    const strip = await screen.findByText('This child owes');
    expect(await screen.findByText('92%')).toBeTruthy();
    const dues = strip.closest('div') as HTMLElement;
    await waitFor(() => expect(within(dues).getByText('5,700')).toBeTruthy());
    expect(document.getElementById('sum-class')?.textContent).toContain('Roll no.');
    expect(screen.getByRole('link', { name: 'Collect fee' }).getAttribute('href')).toBe(
      `/fees/counter?family=${ids.family}`,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }));
    expect(screen.getByRole('tab', { name: 'Messages' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const row = await screen.findByText('علی آج غیر حاضر ہے');
    expect(row.getAttribute('dir')).toBe('rtl');
    expect(row.getAttribute('lang')).toBe('ur');
    expect(api.calls.some((c) => c.path === `/api/messages?family_id=${ids.family}`)).toBe(true);
  });

  it('Edit and Mark left sit in the header menu; Mark left is the destructive item', async () => {
    setup(['admin']);
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More actions: Ali Raza' }), {
      key: 'Enter',
    });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toBeTruthy();
    const left = within(menu).getAllByRole('menuitem').at(-1) as HTMLElement;
    expect(left.dataset.destructive).toBe('true');
    fireEvent.click(left);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('classes (M7b-2)', () => {
  const g2 = {
    ...group,
    id: '01JAAAAAAAAAAAAAAAAAAAAAG2',
    name: 'B',
    active_count: 0,
    seats_left: 30,
    class_teacher_name: 'Ms Sana',
  };
  const api = () =>
    mockApi({
      'GET /api/sessions': { items: [session] },
      'GET /api/groups': { items: [group, g2] },
      [`POST /api/groups/${g2.id}/archive`]: { ok: true },
      [`GET /api/groups/${ids.group}`]: {
        ...group,
        subjects: [
          {
            id: 'GS1',
            subject_id: 'S1',
            subject_name: 'Maths',
            teacher_id: null,
            teacher_name: 'Mr Ali',
          },
        ],
        roster: [
          {
            enrolment_id: 'E1',
            student_id: ids.student,
            name: 'Ali Raza',
            father_name: null,
            roll_no: '1',
            admission_no: '2026-0001',
            has_photo: false,
          },
        ],
      },
    });

  it('list: totals strip, one row per class; archive is a confirmed row-menu action for the office', async () => {
    const calls = api().calls;
    renderAt('/groups', '/groups', <GroupsPage />, ['owner']);
    await screen.findByText('Class 5 B');
    expect(document.getElementById('grp-students')?.textContent).toContain('1');
    expect(document.getElementById('grp-no-teacher')?.textContent).toContain('1');
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions: Class 5 B' }), {
      key: 'Enter',
    });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem'));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((c) => c.path.endsWith('/archive'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: /recycle bin/i }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === `/api/groups/${g2.id}/archive`),
      ).toBe(true),
    );
  });

  it('a teacher sees "My groups" without the row menu', async () => {
    api();
    renderAt('/groups', '/groups', <GroupsPage />, ['teacher']);
    await screen.findByText('Class 5 B');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('My groups');
    expect(screen.queryByRole('button', { name: /^More actions/ })).toBeNull();
  });

  it('detail: roster with roll numbers, subject teachers, and Take attendance for today', async () => {
    api();
    renderAt(`/groups/${ids.group}`, '/groups/:id', <GroupDetail />, ['teacher']);
    expect(await screen.findByText('Ali Raza')).toBeTruthy();
    expect(screen.getByText('Mr Ali')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Take attendance' }).getAttribute('href')).toContain(
      `/attendance/register/${ids.group}?date=`,
    );
  });
});

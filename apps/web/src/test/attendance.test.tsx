import 'fake-indexeddb/auto';
import type { AttendanceSubmission, RegisterResponse, TodayResponse } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import * as ob from '@/offline/outbox';
import { _reset, startAutoSync } from '@/offline/sync';
import { RegisterPage } from '@/pages/attendance/Register';
import { TodayPage } from '@/pages/attendance/Today';
import { ids, mockApi, renderAt } from './api-mock';

const s1 = '01JAAAAAAAAAAAAAAAAAAAAAS1';
const s2 = '01JAAAAAAAAAAAAAAAAAAAAAS2';
const date = '2026-10-08';

const register = (over: Partial<RegisterResponse> = {}): RegisterResponse => ({
  grp_id: ids.group,
  grp_name: 'A',
  programme_name: 'Class 5',
  date,
  grp_subject_id: '',
  day_off: null,
  rows: [
    {
      student_id: s1,
      name: 'Ali Khan',
      roll_no: '1',
      admission_no: '2026-0001',
      has_photo: false,
      status: null,
      note: null,
    },
    {
      student_id: s2,
      name: 'Sara Khan',
      roll_no: '2',
      admission_no: '2026-0002',
      has_photo: false,
      status: null,
      note: null,
    },
  ],
  current: null,
  history: [],
  ...over,
});

const path = `/attendance/register/${ids.group}?date=${date}`;
const pattern = '/attendance/register/:grpId';
const rowFor = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}:`) });

let n = 0;
let stop: () => void = () => undefined;
beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  ob._close();
  ob.configure({ dbName: `att-ui-${n++}`, now: () => Date.now() });
  _reset();
});
afterEach(() => {
  stop();
  stop = () => undefined;
  ob._close();
});

describe('register screen', () => {
  it('starts everyone present and cycles P → A → L → E → P on tap', async () => {
    mockApi({ 'GET /api/attendance/register': register() });
    renderAt(path, pattern, <RegisterPage />, ['teacher']);
    const ali = await screen.findByRole('button', { name: /^Ali Khan: Present$/ });
    expect(rowFor('Sara Khan').getAttribute('aria-label')).toBe('Sara Khan: Present');
    for (const next of ['Absent', 'Late', 'Leave', 'Present']) {
      fireEvent.click(ali);
      expect(rowFor('Ali Khan').getAttribute('aria-label')).toBe(`Ali Khan: ${next}`);
    }
  });

  it('opens a taken register with its current marks', async () => {
    const taken = register({
      current: { register_id: 'R1', taken_by_name: 'Ms Sana', taken_at: '2026-10-08T03:00:00Z' },
    });
    taken.rows[1] = { ...(taken.rows[1] as RegisterResponse['rows'][number]), status: 'A' };
    mockApi({ 'GET /api/attendance/register': taken });
    renderAt(path, pattern, <RegisterPage />, ['teacher']);
    expect(await screen.findByRole('button', { name: 'Sara Khan: Absent' })).toBeTruthy();
  });

  it('offline save goes to the outbox, then syncs when the connection comes back', async () => {
    let online = false;
    const received: AttendanceSubmission[][] = [];
    const api = mockApi({
      'GET /api/attendance/register': register(),
      'POST /api/attendance/sync': (_url: URL, init: RequestInit) => {
        if (!online) throw new TypeError('Failed to fetch');
        const body = JSON.parse(String(init.body)) as AttendanceSubmission[];
        received.push(body);
        return {
          results: body.map((s) => ({
            client_id: s.client_id,
            status: 'applied',
            register_id: 'R1',
            queued_messages: 1,
          })),
        };
      },
    });
    stop = startAutoSync();
    renderAt(path, pattern, <RegisterPage />, ['teacher']);
    fireEvent.click(await screen.findByRole('button', { name: 'Sara Khan: Present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save attendance' }));

    expect(await screen.findByText(/Saved on this phone/)).toBeTruthy();
    expect(await ob.pending()).toBe(1);
    expect(received).toHaveLength(0);

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(async () => expect(await ob.pending()).toBe(0));
    expect(received).toHaveLength(1);
    const sent = received[0]?.[0];
    expect(sent?.grp_id).toBe(ids.group);
    expect(sent?.date).toBe(date);
    expect(sent?.marks).toEqual([
      { student_id: s1, status: 'P', note: null },
      { student_id: s2, status: 'A', note: null },
    ]);
    expect(api.calls.filter((c) => c.path === '/api/attendance/sync').length).toBeGreaterThan(1);
  });

  it('online save shows how many absence messages were queued', async () => {
    mockApi({
      'GET /api/attendance/register': register(),
      'POST /api/attendance/sync': (_u: URL, init: RequestInit) => ({
        results: (JSON.parse(String(init.body)) as AttendanceSubmission[]).map((s) => ({
          client_id: s.client_id,
          status: 'applied',
          register_id: 'R1',
          queued_messages: 2,
        })),
      }),
    });
    renderAt(path, pattern, <RegisterPage />, ['teacher']);
    fireEvent.click(await screen.findByRole('button', { name: 'Save attendance' }));
    expect(await screen.findByText('2 absence messages queued')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open send queue' })).toBeTruthy();
    expect(await ob.pending()).toBe(0);
  });

  it('an office correction needs a reason before it is sent', async () => {
    const api = mockApi({
      'GET /api/attendance/register': register({
        current: { register_id: 'R1', taken_by_name: 'Ms Sana', taken_at: '2026-10-08T03:00:00Z' },
      }),
      'POST /api/attendance/correct': { client_id: 'x', status: 'replaced', register_id: 'R2' },
    });
    renderAt(path, pattern, <RegisterPage />, ['admin']);
    fireEvent.click(await screen.findByRole('button', { name: 'Ali Khan: Present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Correct this register' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Required');
    expect(api.calls.some((c) => c.path === '/api/attendance/correct')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Reason for the correction'), {
      target: { value: 'Ali was on a school trip' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/api/attendance/correct')).toBe(true),
    );
    const call = api.calls.find((c) => c.path === '/api/attendance/correct');
    expect(call?.body).toMatchObject({
      grp_id: ids.group,
      date,
      reason: 'Ali was on a school trip',
      marks: [
        { student_id: s1, status: 'A' },
        { student_id: s2, status: 'P' },
      ],
    });
    // Corrections are online-only (office, laptop): nothing went through the outbox.
    expect(await ob.pending()).toBe(0);
  });
});

describe('today list', () => {
  const today: TodayResponse = {
    date,
    mode: 'daily',
    day_off: null,
    items: [
      {
        grp_id: ids.group,
        grp_name: 'A',
        programme_name: 'Class 5',
        grp_subject_id: '',
        subject_name: null,
        class_teacher_name: 'Ms Sana',
        student_count: 30,
        status: 'taken',
        register_id: 'R1',
        counts: { P: 28, A: 2, L: 0, E: 0 },
        taken_by_name: 'Ms Sana',
        taken_at: '2026-10-08T03:00:00Z',
      },
      {
        grp_id: '01JAAAAAAAAAAAAAAAAAAAAAG2',
        grp_name: 'B',
        programme_name: 'Class 5',
        grp_subject_id: '',
        subject_name: null,
        class_teacher_name: null,
        student_count: 25,
        status: 'not_taken',
        register_id: null,
        counts: { P: 0, A: 0, L: 0, E: 0 },
        taken_by_name: null,
        taken_at: null,
      },
    ],
  };

  it('renders in Urdu, right to left, with taken / not-taken badges and Latin digits', async () => {
    await act(() => setLanguage('ur'));
    mockApi({ 'GET /api/attendance/today': today });
    renderAt('/attendance', '/attendance', <TodayPage />, ['teacher']);
    expect(await screen.findByText('لی گئی')).toBeTruthy();
    expect(screen.getByText('نہیں لی گئی')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
    const links = screen
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href')?.includes('/register/'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `/attendance/register/${ids.group}?date=${date}`,
      `/attendance/register/01JAAAAAAAAAAAAAAAAAAAAAG2?date=${date}`,
    ]);
    expect(screen.getByText(/^30 طلبہ/)).toBeTruthy();
    // Names sit in their own bidi isolate inside the Urdu row.
    expect(screen.getAllByText('Ms Sana')[0]?.tagName).toBe('BDI');
  });
});

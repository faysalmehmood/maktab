import 'fake-indexeddb/auto';
import type { AttendanceSubmission, RegisterResponse, TodayResponse } from '@maktab/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SyncBanner, todayPk } from '@/components/attendance/common';
import { RequireAuth } from '@/components/RequireAuth';
import { initI18n, setLanguage } from '@/i18n';
import { createQueryClient } from '@/lib/query-client';
import { isOfflineApi } from '@/offline/api-cache';
import * as ob from '@/offline/outbox';
import { _reset, startAutoSync, syncNow } from '@/offline/sync';
import { RegisterPage } from '@/pages/attendance/Register';
import { TodayPage } from '@/pages/attendance/Today';
import { ids, meAs, mockApi, renderAt } from './api-mock';

/** What the browser reports: navigator.onLine plus the matching window event. */
function setOnline(on: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => on });
  window.dispatchEvent(new Event(on ? 'online' : 'offline'));
}

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
  ob.configure({
    dbName: `att-ui-${n++}`,
    now: () => Date.now(),
    userId: meAs(['teacher']).user.id,
  });
  _reset();
});
afterEach(() => {
  stop();
  stop = () => undefined;
  ob._close();
  // Back to jsdom's own (online) getter.
  delete (window.navigator as { onLine?: boolean }).onLine;
  window.dispatchEvent(new Event('online'));
});

const applied = (_url: URL, init: RequestInit) => ({
  results: (JSON.parse(String(init.body)) as AttendanceSubmission[]).map((s) => ({
    client_id: s.client_id,
    status: 'applied',
    register_id: 'R1',
    queued_messages: 1,
  })),
});

describe('register screen offline (browser reports offline)', () => {
  it('Save after the `offline` event lands in the outbox; `online` syncs it and clears the note', async () => {
    const received: AttendanceSubmission[][] = [];
    mockApi({
      'GET /api/attendance/register': register(),
      'POST /api/attendance/sync': (url: URL, init: RequestInit) => {
        if (!navigator.onLine) throw new TypeError('Failed to fetch');
        received.push(JSON.parse(String(init.body)) as AttendanceSubmission[]);
        return applied(url, init);
      },
    });
    stop = startAutoSync();
    renderAt(
      path,
      pattern,
      <>
        <SyncBanner />
        <RegisterPage />
      </>,
      ['teacher'],
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Sara Khan: Present' }));
    await act(async () => setOnline(false));
    fireEvent.click(screen.getByRole('button', { name: 'Save attendance' }));

    expect(await screen.findByText(/^Saved on this phone/)).toBeTruthy();
    await waitFor(async () => expect(await ob.pending()).toBe(1));
    expect(await screen.findByText('1 waiting to sync')).toBeTruthy(); // the banner
    expect(screen.getByText('1 saved registers waiting on this phone')).toBeTruthy();
    expect(received).toHaveLength(0);

    await act(async () => setOnline(true));
    await waitFor(async () => expect(await ob.pending()).toBe(0));
    expect(received.flat()).toHaveLength(1);
    expect(received[0]?.[0]?.marks[1]).toMatchObject({ student_id: s2, status: 'A' });
    // The server's answer replaces "will be sent" (the entry was acknowledged).
    await waitFor(() => expect(screen.queryByText(/^Saved on this phone/)).toBeNull());
    expect(await screen.findByText('1 absence messages queued')).toBeTruthy();
    expect(screen.queryByText(/waiting on this phone/)).toBeNull();
  });

  it('a double tap saves one register (one client_id per draft)', async () => {
    const received: AttendanceSubmission[] = [];
    mockApi({
      'GET /api/attendance/register': register(),
      'POST /api/attendance/sync': (url: URL, init: RequestInit) => {
        received.push(...(JSON.parse(String(init.body)) as AttendanceSubmission[]));
        return applied(url, init);
      },
    });
    renderAt(path, pattern, <RegisterPage />, ['teacher']);
    const save = await screen.findByRole('button', { name: 'Save attendance' });
    fireEvent.click(save);
    fireEvent.click(save);
    await screen.findByText('1 absence messages queued');
    expect(new Set(received.map((r) => r.client_id)).size).toBe(1);
  });

  it('a roster over 200 students cannot be saved, and says why', async () => {
    const big = register({
      rows: Array.from({ length: 201 }, (_, i) => ({
        student_id: `01JAAAAAAAAAAAAAAAAAAA${String(i).padStart(4, '0')}`,
        name: `Student ${i}`,
        roll_no: String(i + 1),
        admission_no: `A${i}`,
        has_photo: false,
        status: null,
        note: null,
      })),
    });
    mockApi({ 'GET /api/attendance/register': big });
    renderAt(path, pattern, <RegisterPage />, ['teacher']);
    expect(await screen.findByText(/This group has 201 students/)).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save attendance' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

describe('refused registers', () => {
  it('are listed with group, date and reason; Retry resends, Dismiss asks first', async () => {
    let answer = 'clock_skew';
    const api = mockApi({
      'POST /api/attendance/sync': (_u: URL, init: RequestInit) => ({
        results: (JSON.parse(String(init.body)) as AttendanceSubmission[]).map((s) =>
          answer === 'ok'
            ? { client_id: s.client_id, status: 'applied', register_id: 'R9' }
            : { client_id: s.client_id, status: 'rejected', error: answer },
        ),
      }),
    });
    const sub = (d: string): AttendanceSubmission => ({
      client_id: `01JAAAAAAAAAAAAAAAAAAAAC${d.slice(-2)}`,
      grp_id: ids.group,
      date: d,
      taken_at: `${d}T03:00:00.000Z`,
      marks: [{ student_id: s1, status: 'P' }],
    });
    await ob.enqueue(sub('2026-10-01'), { label: 'Class 5 A' });
    await ob.enqueue(sub('2026-10-02'), { label: 'Class 5 B' });
    await act(async () => {
      await syncNow({ force: true });
    });
    renderAt('/', '/', <SyncBanner />, ['teacher']);
    expect(await screen.findByText('2 not accepted', { exact: false })).toBeTruthy();
    // The rows load after the count (they are read from IndexedDB).
    expect(await screen.findAllByText(/Fix your phone's clock/)).toHaveLength(2);
    expect(screen.getByText('Class 5 A')).toBeTruthy();

    answer = 'ok';
    const before = api.calls.length;
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0] as HTMLElement);
    await waitFor(async () => expect((await ob.failed()).length).toBe(1));
    // The retried entry leaves the failed list before its sync request goes out: wait for the call
    // (was a flaky immediate assertion, seen in the M4 fix pass).
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(before));
    expect((await ob.failed())[0]?.label).toBe('Class 5 B');

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Dismiss this saved register?')).toBeTruthy();
    expect((await ob.failed()).length).toBe(1); // nothing deleted before confirming
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }));
    await waitFor(async () => expect((await ob.failed()).length).toBe(0));
  });
});

describe('offline reload', () => {
  it('the service worker caches exactly the reads a teacher needs offline', () => {
    const at = (p: string) => isOfflineApi({ url: new URL(p, 'https://s.pk'), sameOrigin: true });
    for (const p of [
      '/api/me',
      '/api/school',
      '/api/attendance/today',
      `/api/attendance/register?grp_id=${ids.group}&date=2026-10-10`,
    ])
      expect(at(p), p).toBe(true);
    for (const p of ['/api/attendance/sync', '/api/messages', '/api/students', '/api/auth/logout'])
      expect(at(p), p).toBe(false);
    expect(isOfflineApi({ url: new URL('https://x.com/api/me'), sameOrigin: false })).toBe(false);
  });

  it('queries still fetch while offline (so the SW cache can answer); the error screen shows what waits', async () => {
    await ob.enqueue({
      client_id: '01JAAAAAAAAAAAAAAAAAAAAAW1',
      grp_id: ids.group,
      date,
      taken_at: `${date}T03:00:00.000Z`,
      marks: [{ student_id: s1, status: 'A' }],
    });
    await act(async () => setOnline(false));
    const api = mockApi({
      'GET /api/me': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>
          <RequireAuth>
            <p>shell</p>
          </RequireAuth>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/^1 saved registers are safe on this phone/)).toBeTruthy();
    expect(api.calls.some((c) => c.path === '/api/me')).toBe(true);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
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
    // Links open today's register even if the (possibly cached) list is from another day.
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      `/attendance/register/${ids.group}?date=${todayPk()}`,
      `/attendance/register/01JAAAAAAAAAAAAAAAAAAAAAG2?date=${todayPk()}`,
    ]);
    expect(screen.getByText(/^30 طلبہ/)).toBeTruthy();
    // Names sit in their own bidi isolate inside the Urdu row.
    expect(screen.getAllByText('Ms Sana')[0]?.tagName).toBe('BDI');
  });
});

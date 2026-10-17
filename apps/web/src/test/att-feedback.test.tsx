import 'fake-indexeddb/auto';
import type { AttendanceReport, GroupDto, RegisterResponse } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/AppShell';
import { initI18n, setLanguage } from '@/i18n';
import * as ob from '@/offline/outbox';
import { _reset } from '@/offline/sync';
import { RegisterPage } from '@/pages/attendance/Register';
import { ReportPage } from '@/pages/attendance/Report';
import { GroupsPage } from '@/pages/Groups';
import { group, ids, meAs, mockApi, renderAt, session } from './api-mock';

/*
 * Owner feedback of 2026-10-17 (used the demo as a teacher): the register row says the word
 * (Present / Late …) and not a letter; codes are P, A, Lt, Lv; the monthly register prints on one
 * A4 landscape sheet with its own title; "My groups" says the teacher's role in each group.
 */

const s1 = '01JAAAAAAAAAAAAAAAAAAAAAS1';
const s2 = '01JAAAAAAAAAAAAAAAAAAAAAS2';

const school = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAC1',
  name: 'Global Science Academy',
  name_ur: 'گلوبل سائنس اکیڈمی',
  mode: 'school',
  address: null,
  phone: null,
  default_lang: 'en',
  receipt_prefix: null,
  has_logo: false,
  short_name: 'GSA',
  city: null,
  brand_color: 'blue',
  setup_completed_at: '2026-10-01T00:00:00Z',
  attendance_mode: 'daily',
  weekly_off: [0],
};

function stubMedia(phone: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

let n = 0;
beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  ob._close();
  ob.configure({
    dbName: `att-fb-${n++}`,
    now: () => Date.now(),
    userId: meAs(['teacher']).user.id,
  });
  _reset();
  stubMedia(false);
});
afterEach(() => {
  ob._close();
  vi.unstubAllGlobals();
});

describe('register row: the current mark is the word', () => {
  const register = (): RegisterResponse => ({
    grp_id: ids.group,
    grp_name: 'A',
    programme_name: 'Class 5',
    date: '2026-10-08',
    grp_subject_id: '',
    day_off: null,
    rows: [s1, s2].map((id, i) => ({
      student_id: id,
      name: i ? 'Sara Khan' : 'Ali Khan',
      roll_no: String(i + 1),
      admission_no: `2026-000${i + 1}`,
      has_photo: false,
      status: null,
      note: null,
    })),
    current: null,
    history: [],
  });

  it('a pill with Present → Absent → Late → Leave; the row keeps its aria-label; counts use Lt/Lv', async () => {
    mockApi({ 'GET /api/attendance/register': register() });
    renderAt(
      `/attendance/register/${ids.group}?date=2026-10-08`,
      '/attendance/register/:grpId',
      <RegisterPage />,
      ['teacher'],
    );
    const row = await screen.findByRole('button', { name: 'Ali Khan: Present' });
    const chip = () => row.querySelector('[data-solid]') as HTMLElement;
    expect(chip().textContent).toBe('Present');
    // Auto-width pill, at least 44 px tall: not the old fixed square.
    expect(chip().className).toContain('rounded-full');
    expect(chip().className).toContain('min-h-11');
    expect(chip().className).toContain('min-w-[5.5rem]');
    expect(chip().className).not.toContain('size-');
    for (const word of ['Absent', 'Late', 'Leave']) {
      fireEvent.click(row);
      expect(chip().textContent).toBe(word);
      expect(row.getAttribute('aria-label')).toBe(`Ali Khan: ${word}`);
    }
    // Ali is on leave, Sara present: the save bar counts read P 1 · A 0 · Lt 0 · Lv 1.
    const counts = [...document.querySelectorAll('[data-action-bar] [title]')].map((e) =>
      e.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(counts).toEqual(['P 1', 'A 0', 'Lt 0', 'Lv 1']);
  });

  it('Urdu words on the pill (حاضر / غیر حاضر / تاخیر / رخصت)', async () => {
    await act(() => setLanguage('ur'));
    mockApi({ 'GET /api/attendance/register': register() });
    renderAt(
      `/attendance/register/${ids.group}?date=2026-10-08`,
      '/attendance/register/:grpId',
      <RegisterPage />,
      ['teacher'],
    );
    const row = await screen.findByRole('button', { name: 'Ali Khan: حاضر' });
    const words = [row.querySelector('[data-solid]')?.textContent];
    for (let i = 0; i < 3; i++) {
      fireEvent.click(row);
      words.push(row.querySelector('[data-solid]')?.textContent);
    }
    expect(words).toEqual(['حاضر', 'غیر حاضر', 'تاخیر', 'رخصت']);
  });
});

describe('monthly register print', () => {
  const D = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
  const days = Array.from({ length: 31 }, (_, i) => {
    const date = D(i + 1);
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    return {
      date,
      day_off: sunday ? ('weekly_off' as const) : date === D(14) ? ('holiday' as const) : null,
      taken: date === D(1) || date === D(2),
    };
  });
  const cells = (a: string, b: string) => days.map((_d, i) => (i === 0 ? a : i === 1 ? b : '–'));
  const report: AttendanceReport = {
    grp_id: ids.group,
    grp_name: 'A',
    programme_name: 'Class 5',
    month: '2026-10',
    grp_subject_id: '',
    class_teacher_name: 'Ms Sana',
    days,
    non_school_days: days.filter((d) => d.day_off).map((d) => d.date),
    working_days: 12,
    rows: [
      {
        student_id: s1,
        roll_no: '1',
        name: 'Ali Khan',
        cells: cells('P', 'L'),
        counts: { P: 1, A: 0, L: 1, E: 0 },
        pct: 100,
      },
      {
        student_id: s2,
        roll_no: '2',
        name: 'Sara Khan',
        cells: cells('E', 'A'),
        counts: { P: 0, A: 1, L: 0, E: 1 },
        pct: 0,
      },
    ],
  };
  const api = () =>
    mockApi({
      'GET /api/groups': { items: [{ ...group, class_teacher_name: 'Ms Sana' }] },
      'GET /api/school': { school },
      'GET /api/attendance/report': report,
      'GET /api/sessions': { items: [session] },
    });
  const open = () =>
    renderAt(
      `/attendance/report?grp=${ids.group}&month=2026-10`,
      '/attendance/report',
      <ReportPage />,
      ['teacher'],
    );
  const pageStyle = () => document.head.querySelector('style[data-register-page]');

  it('a school register: header, Lt/Lv codes, present per day, shaded days off, working days, signatures', async () => {
    api();
    open();
    const table = await screen.findByRole('table');
    expect(screen.getByText('Global Science Academy')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Attendance register' })).toBeTruthy();
    expect(screen.getByText('Ms Sana')).toBeTruthy();
    const head = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(head.slice(-5)).toEqual(['P', 'A', 'Lt', 'Lv', '%']);
    const ali = within(table).getByText('Ali Khan').closest('tr') as HTMLElement;
    const sara = within(table).getByText('Sara Khan').closest('tr') as HTMLElement;
    const day = (tr: HTMLElement, i: number) => tr.querySelectorAll('td')[2 + i]?.textContent;
    expect([day(ali, 0), day(ali, 1), day(sara, 0), day(sara, 1), day(ali, 5)]).toEqual([
      'P',
      'Lt',
      'Lv',
      'A',
      '–',
    ]);
    // Present per day counts P and Lt; a day with no register stays blank.
    const totals = table.querySelector('[data-totals]') as HTMLElement;
    const tds = totals.querySelectorAll('td');
    expect([tds[0]?.textContent, tds[1]?.textContent, tds[2]?.textContent]).toEqual(['1', '1', '']);
    // Sundays (4, 11, 18, 25 Oct 2026) and the holiday (14th) are shaded.
    const shaded = [...table.querySelectorAll('thead th.day-off')].map((th) => th.textContent);
    expect(shaded).toEqual(['04', '11', '14', '18', '25']);
    expect(screen.getByText('Working days: 12')).toBeTruthy();
    expect(screen.getByText('Registers taken: 2')).toBeTruthy();
    for (const l of ['P = Present', 'A = Absent', 'Lt = Late', 'Lv = Leave', '– = no mark'])
      expect(screen.getByText(l)).toBeTruthy();
    expect(screen.getByText('Class teacher', { selector: '.register-signs span' })).toBeTruthy();
    expect(screen.getByText('Principal')).toBeTruthy();
  });

  it('tab title and the document-level A4 landscape page exist only while the report is open', async () => {
    document.title = 'Take attendance';
    expect(pageStyle()).toBeNull();
    api();
    const view = open();
    await screen.findByRole('table');
    await waitFor(() => expect(document.title).toBe('Attendance register · Class 5 A · Oct 2026'));
    const style = pageStyle();
    expect(style?.textContent).toContain('@page { size: A4 landscape; margin: 0; }');
    // No named page left behind: the whole document takes this page size.
    expect(style?.textContent).not.toMatch(/@page\s+\w/);
    view.unmount();
    expect(document.title).toBe('Take attendance');
    expect(pageStyle()).toBeNull();
  });

  it('a language change while the report is open: on leaving, the tab shows the shell title in the new language', async () => {
    api();
    const view = renderAt(
      `/attendance/report?grp=${ids.group}&month=2026-10`,
      '/*',
      <Routes>
        <Route element={<AppShell />}>
          <Route path="attendance/report" element={<ReportPage />} />
        </Route>
      </Routes>,
      ['teacher'],
    );
    await screen.findByRole('table');
    await waitFor(() => expect(document.title).toBe('Attendance register · Class 5 A · Oct 2026'));
    await act(() => setLanguage('ur'));
    await waitFor(() => expect(document.title).toMatch(/^حاضری رجسٹر · /));
    view.unmount();
    expect(document.title).toBe(`GSA · ${i18next.t('app.name')}`);
    expect(i18next.language).toBe('ur');
  });

  it('Urdu: the title and labels in Urdu, codes stay Latin', async () => {
    await act(() => setLanguage('ur'));
    api();
    open();
    await screen.findByRole('table');
    await waitFor(() => expect(document.title).toMatch(/^حاضری رجسٹر · Class 5 A · /));
    expect(screen.getByText('گلوبل سائنس اکیڈمی')).toBeTruthy();
    expect(screen.getByText('Lt = تاخیر')).toBeTruthy();
    expect(screen.getByText('Lv = رخصت')).toBeTruthy();
    // Days read 01 → 31 left to right in Urdu too.
    expect(screen.getByRole('table').getAttribute('dir')).toBe('ltr');
  });
});

describe('My groups: Your role', () => {
  const me = (r: GroupDto['my_role']) => r;
  const rows: GroupDto[] = [
    {
      ...(group as GroupDto),
      name: 'A',
      class_teacher_name: 'Ms Sana',
      my_role: me({ class_teacher: true, subjects: ['Maths'] }),
    },
    {
      ...(group as GroupDto),
      id: '01JAAAAAAAAAAAAAAAAAAAAAB2',
      name: 'B',
      my_role: me({ class_teacher: false, subjects: ['English', 'Maths'] }),
    },
    {
      ...(group as GroupDto),
      id: '01JAAAAAAAAAAAAAAAAAAAAAB3',
      name: 'C',
      my_role: me({ class_teacher: false, subjects: [] }),
    },
  ];
  const api = () =>
    mockApi({ 'GET /api/groups': { items: rows }, 'GET /api/sessions': { items: [session] } });

  it('a teacher sees Class teacher, the subjects, or –', async () => {
    api();
    renderAt('/groups', '/groups', <GroupsPage />, ['teacher']);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Your role' })).toBeTruthy();
    const roleOf = (name: string) => {
      const tr = within(table).getByText(name).closest('tr') as HTMLElement;
      return tr.querySelectorAll('td')[0]?.textContent;
    };
    expect(roleOf('Class 5 A')).toBe('Class teacher, Maths');
    expect(roleOf('Class 5 B')).toBe('English, Maths');
    expect(roleOf('Class 5 C')).toBe('–');
  });

  it('the office (no teacher role) has no Your role column', async () => {
    api();
    renderAt('/groups', '/groups', <GroupsPage />, ['owner']);
    await screen.findByText('Class 5 B');
    expect(screen.queryByText('Your role')).toBeNull();
  });

  it('phone cards carry the role line too (Urdu)', async () => {
    stubMedia(true);
    await act(() => setLanguage('ur'));
    api();
    renderAt('/groups', '/groups', <GroupsPage />, ['teacher']);
    await screen.findByText('Class 5 B');
    expect(document.querySelector('[data-layout="cards"]')).toBeTruthy();
    expect(screen.getAllByText('آپ کا کردار').length).toBe(3);
    expect(screen.getByText('کلاس ٹیچر, Maths', { selector: 'bdi' })).toBeTruthy();
  });
});

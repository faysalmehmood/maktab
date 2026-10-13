import 'fake-indexeddb/auto';
import { GUIDE_TASKS } from '@maktab/shared/guide';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/AppShell';
import { matchPath } from '@/guide/engine';
import { initI18n, setLanguage } from '@/i18n';
import * as ob from '@/offline/outbox';
import { _reset } from '@/offline/sync';
import { RegisterPage } from '@/pages/attendance/Register';
import { TodayPage } from '@/pages/attendance/Today';
import { Dashboard } from '@/pages/Dashboard';
import { BillingPage } from '@/pages/fees/Billing';
import { CashPage } from '@/pages/fees/Cash';
import { CounterPage } from '@/pages/fees/Counter';
import { DefaultersPage } from '@/pages/fees/Defaulters';
import { MessagesPage } from '@/pages/Messages';
import { IncomeExpensePage, ReportsHub } from '@/pages/money/Reports';
import { SalaryPage } from '@/pages/money/Salary';
import { SettingsPage } from '@/pages/Settings';
import { AdmissionPage } from '@/pages/students/Admission';
import { StudentDetail } from '@/pages/students/StudentDetail';
import { StudentsList } from '@/pages/students/StudentsList';
import { group, ids, meAs, mockApi, renderAt, session } from './api-mock';
import { accounts, cashSession, fam, familyStatement, feeSettings } from './fee-fixtures';

/*
 * Every "Show me" step points at a real element: each targeted screen is mounted (with the data
 * that makes the element appear) and every `[data-tour]` of every tour must be found on a screen
 * whose route matches the step's path.
 */

const ME = meAs(['owner']).user.id;
const RS = (n: number) => n * 100;

type Scenario = {
  name: string;
  /** The route pattern the screen lives at (compared with each step's `path`). */
  route: string;
  mount: () => void;
  /** Interactions that reveal more targets (open a tab, look a family up). */
  reveal?: (snap: () => void) => Promise<void>;
  /** Wait until the screen has loaded. */
  ready: string;
};

const school = {
  id: 'SCH',
  name: 'Al-Noor',
  name_ur: null,
  short_name: 'ANS',
  city: null,
  brand_color: 'teal',
  has_logo: false,
  setup_completed_at: '2026-10-01T00:00:00Z',
};

const FEES_API = {
  [`GET /api/fees/family/${fam}`]: familyStatement(),
  'GET /api/accounts': accounts,
  'GET /api/groups': { items: [group] },
  'GET /api/sessions': { items: [session] },
  'GET /api/school/fees': feeSettings,
  'GET /api/fees/runs': {
    period: '2026-10',
    complete: false,
    cursor: null,
    failing: [],
    attention_required: 0,
    chunks: [],
  },
  'GET /api/fees/unbilled': { period: '2026-10', items: [], more: false },
  'GET /api/fees/defaulters': { summary_only: false, defaulters: [], total_overdue: 0 },
  'GET /api/cash/sessions': { sessions: [cashSession({ collector_id: ME })] },
  'GET /api/fees/collection': { rows: [], total: 0 },
};

const guardian = {
  id: 'G1',
  family_id: ids.family,
  name: 'Imran Raza',
  relation: 'father',
  cnic: null,
  phone: '923001234567',
  whatsapp: null,
  priority: 1,
  consent_whatsapp: true,
  consent_sms: false,
  lang: 'ur' as const,
};

const studentDetail = {
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
  guardians: [guardian],
  enrolments: [],
};

const queueRow = {
  id: 'm1',
  family_id: 'F1',
  family_name: 'Raza',
  guardian_id: 'G1',
  guardian_name: 'Imran',
  guardian_phone: '923001234567',
  wa_number: '923001234567',
  number: '923001234567',
  channel: 'wa_manual',
  template_key: 'absence',
  lang: 'en',
  status: 'queued',
  payload: {},
  created_at: '2026-10-11T04:00:00Z',
  preview: 'Ali was absent today.\n{link}',
  grp_id: group.id,
  grp_name: 'Class 5 A',
  opened_at: null,
  sent_at: null,
  sent_by_name: null,
  skipped_reason: null,
};

const SCENARIOS: Scenario[] = [
  {
    name: 'home (first week)',
    route: '/',
    mount: () => {
      mockApi({
        'GET /api/home/first-week': {
          setup: true,
          admission: false,
          fees: false,
          register: false,
          message: false,
        },
        'GET /api/school': { school },
      });
      renderAt('/', '/', <Dashboard />, ['owner']);
    },
    ready: '[data-tour="home-first-week"]',
  },
  {
    name: 'app shell',
    route: '*',
    mount: () => {
      mockApi({ 'GET /api/school': { school } });
      renderAt(
        '/',
        '/*',
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<p>home</p>} />
          </Route>
        </Routes>,
        ['owner'],
      );
    },
    ready: '#sync-state',
  },
  {
    name: 'settings → staff',
    route: '/settings',
    mount: () => {
      mockApi({ 'GET /api/staff': { items: [] }, 'GET /api/school': { school } });
      renderAt('/settings?section=staff', '/settings', <SettingsPage />, ['owner']);
    },
    ready: '[data-tour="settings-tab-programmes"]',
  },
  {
    name: 'settings → backup',
    route: '/settings',
    mount: () => {
      mockApi({
        'GET /api/backup/status': {
          last_nightly: null,
          last_drill: null,
          runs: [],
          objects: [],
          objects_error: null,
          time_travel_days: 7,
          report_configured: true,
        },
        'GET /api/alarms': { at: '2026-10-13T05:00:00.000Z', total: 0, alarms: [] },
        'GET /api/school': { school },
      });
      renderAt('/settings?section=backup', '/settings', <SettingsPage />, ['owner']);
    },
    ready: '[data-tour="backup-status"]',
  },
  {
    name: 'students',
    route: '/students',
    mount: () => {
      mockApi({
        'GET /api/students': { items: [], total: 0, page: 1, page_size: 50 },
        'GET /api/groups': { items: [group] },
      });
      renderAt('/students', '/students', <StudentsList />, ['owner']);
    },
    ready: '[data-tour="students-admit"]',
  },
  {
    name: 'admission (+ a known family)',
    route: '/students/new',
    mount: () => {
      mockApi({
        'GET /api/groups': { items: [group] },
        'GET /api/sessions': { items: [session] },
        'GET /api/custom-fields': { items: [] },
        'GET /api/families': {
          items: [
            {
              id: ids.family,
              name: 'Raza',
              address: null,
              area: null,
              guardians: [{ id: 'G1', name: 'Imran', relation: 'father', phone: '923001234567' }],
              students: [{ id: 'S1', name: 'Ali', admission_no: '2026-0001', status: 'active' }],
            },
          ],
        },
      });
      renderAt('/students/new', '/students/new', <AdmissionPage />, ['owner']);
    },
    reveal: async () => {
      const phone = document.getElementById('lookup-phone') as HTMLInputElement;
      fireEvent.change(phone, { target: { value: '03001234567' } });
      fireEvent.click(document.querySelector('[data-tour="adm-find"]') as HTMLElement);
      await waitFor(() => {
        if (!document.querySelector('[data-tour="adm-same-family"]')) throw new Error('no hit');
      });
    },
    ready: '[data-tour="adm-phone"]',
  },
  {
    name: 'student profile',
    route: '/students/:id',
    mount: () => {
      mockApi({
        [`GET /api/students/${ids.student}`]: studentDetail,
        [`GET /api/families/${ids.family}`]: {
          ...studentDetail.family,
          guardians: [guardian],
          students: [],
        },
        'GET /api/custom-fields': { items: [] },
        [`GET /api/fees/student/${ids.student}`]: {
          due: 0,
          family_due: 0,
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
      });
      renderAt(`/students/${ids.student}`, '/students/:id', <StudentDetail />, ['owner']);
    },
    reveal: async (snap) => {
      fireEvent.click(document.querySelector('[data-tour="profile-tab-guardians"]') as HTMLElement);
      await wait('[data-tour="parent-link"]');
      snap();
      fireEvent.click(document.querySelector('[data-tour="profile-tab-fees"]') as HTMLElement);
      await waitFor(() => {
        if (!document.querySelector('[data-tour="student-reduce-fee"]')) throw new Error('fees');
      });
    },
    ready: '[data-tour="profile-tab-fees"]',
  },
  {
    name: 'attendance today',
    route: '/attendance',
    mount: () => {
      mockApi({
        'GET /api/attendance/today': {
          date: '2026-10-13',
          mode: 'daily',
          day_off: null,
          items: [
            {
              grp_id: ids.group,
              grp_name: 'A',
              programme_name: 'Class 5',
              grp_subject_id: '',
              subject_name: null,
              class_teacher_name: null,
              student_count: 2,
              status: 'not_taken',
              register_id: null,
              counts: { P: 0, A: 0, L: 0, E: 0 },
              taken_by_name: null,
              taken_at: null,
            },
          ],
        },
      });
      renderAt('/attendance', '/attendance', <TodayPage />, ['owner']);
    },
    ready: '[data-tour="att-group"]',
  },
  {
    name: 'register',
    route: '/attendance/register/:grpId',
    mount: () => {
      mockApi({
        'GET /api/attendance/register': {
          grp_id: ids.group,
          grp_name: 'A',
          programme_name: 'Class 5',
          date: '2026-10-13',
          grp_subject_id: '',
          day_off: null,
          rows: [
            {
              student_id: 'S1',
              name: 'Ali',
              roll_no: '1',
              admission_no: '1',
              has_photo: false,
              status: null,
              note: null,
            },
          ],
          current: null,
          history: [],
        },
      });
      renderAt(
        `/attendance/register/${ids.group}?date=2026-10-13`,
        '/attendance/register/:grpId',
        <RegisterPage />,
        ['teacher'],
      );
    },
    ready: '[data-tour="att-save"]',
  },
  {
    name: 'messages',
    route: '/messages',
    mount: () => {
      const counts = { queued: 1, sent_today: 0, skipped_today: 0, by_template: { absence: 1 } };
      mockApi({
        'GET /api/messages': { items: [queueRow], total: 1, counts },
        'GET /api/messages/counts': counts,
        'GET /api/groups': { items: [group] },
        'GET /api/sessions': { items: [session] },
      });
      renderAt('/messages', '/messages', <MessagesPage />, ['owner']);
    },
    ready: '[data-tour="msg-open-wa"]',
  },
  {
    name: 'counter (search)',
    route: '/fees/counter',
    mount: () => {
      mockApi(FEES_API);
      renderAt('/fees/counter', '/fees/counter', <CounterPage />, ['owner']);
    },
    ready: '[data-tour="counter-search"]',
  },
  {
    name: 'counter (a family open)',
    route: '/fees/counter',
    mount: () => {
      mockApi(FEES_API);
      renderAt(`/fees/counter?family=${fam}`, '/fees/counter', <CounterPage />, ['owner']);
    },
    ready: '[data-tour="counter-confirm"]',
  },
  {
    name: 'cash',
    route: '/cash',
    mount: () => {
      mockApi(FEES_API);
      renderAt('/cash', '/cash', <CashPage />, ['owner']);
    },
    ready: '[data-tour="cash-close"]',
  },
  {
    name: 'billing',
    route: '/fees/billing',
    mount: () => {
      mockApi(FEES_API);
      renderAt('/fees/billing', '/fees/billing', <BillingPage />, ['owner']);
    },
    ready: '[data-tour="fines-preview"]',
  },
  {
    name: 'defaulters',
    route: '/fees/defaulters',
    mount: () => {
      mockApi(FEES_API);
      renderAt('/fees/defaulters', '/fees/defaulters', <DefaultersPage />, ['owner']);
    },
    ready: '[data-tour="def-remind"]',
  },
  {
    name: 'reports',
    route: '/reports',
    mount: () => {
      mockApi({});
      renderAt('/reports', '/reports', <ReportsHub />, ['owner']);
    },
    ready: '[data-tour="reports-income-expense"]',
  },
  {
    name: 'income vs expense',
    route: '/reports/income-expense',
    mount: () => {
      mockApi({
        'GET /api/reports/income-expense': {
          from: '2026-10',
          to: '2026-10',
          income: { by_head: [], unallocated: 0, total: RS(100) },
          expenses: { by_category: [], total: 0 },
          salaries: { pay: 0, slips: 0, scope: 'all' },
          net: RS(100),
          months: [{ period: '2026-10', income: RS(100), expenses: 0, salaries: 0, net: RS(100) }],
          reconciliation: {
            income: RS(100),
            expenses: 0,
            salary_paid: 0,
            advances_paid: 0,
            expected_movement: RS(100),
            movement: RS(100),
            ties: true,
          },
        },
      });
      renderAt('/reports/income-expense', '/reports/income-expense', <IncomeExpensePage />, [
        'owner',
      ]);
    },
    ready: '[data-tour="ie-totals"]',
  },
  {
    name: 'payroll',
    route: '/salary',
    mount: () => {
      mockApi({ 'GET /api/payslips': { items: [] }, 'GET /api/accounts': accounts });
      renderAt('/salary', '/salary', <SalaryPage />, ['owner']);
    },
    ready: '[data-tour="salary-prepare"]',
  },
];

/** What each scenario rendered: its route and the data-tour names on screen. */
const found: { name: string; route: string; targets: Set<string> }[] = [];

let n = 0;
const stubResizeObserver = () =>
  // Radix (tabs, menus) measures with ResizeObserver, missing in jsdom.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  stubResizeObserver();
  ob._close();
  ob.configure({ dbName: `guide-${n++}`, now: () => Date.now(), userId: ME });
  _reset();
});
afterEach(() => vi.unstubAllGlobals());

const wait = (sel: string) =>
  waitFor(
    () => {
      if (!document.querySelector(sel)) throw new Error(`no ${sel}`);
    },
    { timeout: 4000 },
  );

describe('tour targets exist on the real screens', () => {
  for (const s of SCENARIOS)
    it(`mounts ${s.name}`, async () => {
      s.mount();
      await wait(s.ready);
      const snap = () =>
        found.push({
          name: s.name,
          route: s.route,
          targets: new Set(
            [...document.querySelectorAll<HTMLElement>('[data-tour]')].map(
              (el) => el.dataset.tour ?? '',
            ),
          ),
        });
      if (s.reveal) await s.reveal(snap);
      snap();
    });

  it('every step of every tour has its target on a screen at the step’s path', () => {
    const missing: string[] = [];
    let steps = 0;
    for (const t of GUIDE_TASKS)
      for (const st of t.tour ?? []) {
        steps++;
        const ok = found.some(
          (f) =>
            f.targets.has(st.target) &&
            (!st.path || f.route === '*' || matchPath(st.path, f.route.replace(/:\w+/g, 'x'))),
        );
        if (!ok) missing.push(`${t.id}: ${st.target} (${st.path ?? 'any screen'})`);
      }
    expect(new Set(found.map((f) => f.name)).size).toBe(SCENARIOS.length);
    expect(missing).toEqual([]);
    expect(steps).toBeGreaterThanOrEqual(40);
  });
});

/** Contextual help: the "?" of a screen opens that screen's task (and only for its roles). */
describe('contextual help', () => {
  const sheetFor = async (path: string, pattern: string, page: ReactNode, roles = ['owner']) => {
    mockApi(FEES_API);
    renderAt(path, pattern, page, roles as Parameters<typeof renderAt>[3]);
  };

  it('the counter "?" opens "Collect a fee" in a sheet; Show me starts its tour', async () => {
    await sheetFor('/fees/counter', '/fees/counter', <CounterPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Help for this screen' }));
    const sheet = await waitFor(() => {
      const el = document.querySelector('[data-guide-sheet]');
      if (!el) throw new Error('no sheet');
      return el as HTMLElement;
    });
    expect(sheet.dataset.guideSheet).toBe('collect-fee');
    expect(
      screen.getByRole('heading', { name: 'Collect a fee and give the receipt' }),
    ).toBeTruthy();
    // The steps quote the counter's own button.
    expect(sheet.querySelector('[data-label="fee.counter.confirm"]')?.textContent).toBe(
      'Confirm and issue receipt',
    );
    expect(screen.getByRole('link', { name: /Open full page/ }).getAttribute('href')).toBe(
      '/guide/collect-fee',
    );
  });

  it('each major screen carries its own task', async () => {
    const cases: [string, string, ReactNode, string][] = [
      ['/fees/billing', '/fees/billing', <BillingPage key="b" />, 'generate-fees'],
      ['/fees/defaulters', '/fees/defaulters', <DefaultersPage key="d" />, 'defaulters'],
      ['/cash', '/cash', <CashPage key="c" />, 'close-cash'],
    ];
    for (const [path, pattern, page, task] of cases) {
      await sheetFor(path, pattern, page);
      await wait(`[data-help="${task}"]`);
      document.body.innerHTML = '';
    }
  });

  it('is hidden from a role the task is not for (a teacher on the dues list)', async () => {
    await sheetFor('/fees/defaulters', '/fees/defaulters', <DefaultersPage />, ['teacher']);
    await screen.findByRole('heading', { level: 1 });
    expect(document.querySelector('[data-help]')).toBeNull();
  });
});

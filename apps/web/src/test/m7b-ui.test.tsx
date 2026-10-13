import { formatPkPhone, type StaffRole } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell, bottomTabs, navGroups, ThemeSwitch } from '@/components/AppShell';
import { SchoolBadge } from '@/components/brand/SchoolBadge';
import { GlobalSearch, SEARCH_LIMIT } from '@/components/GlobalSearch';
import { Mny, StatusBadge } from '@/components/page';
import { initI18n, setLanguage } from '@/i18n';
import { BRAND_KEY, getThemePref, initTheme, setBrand, setThemePref, THEME_KEY } from '@/lib/theme';
import { Dashboard, homeVariant } from '@/pages/Dashboard';
import { Login } from '@/pages/Login';
import { SetupWizard } from '@/pages/Setup';
import { mockApi, renderAt, session } from './api-mock';

// M7b part 1 (UI plan §5–7): theme, shell per role, search, badge, five-step setup, homes, RTL.

const school = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAC1',
  name: 'Global Science Academy',
  name_ur: 'گلوبل سائنس اکیڈمی',
  mode: 'both',
  address: null,
  phone: '92457123456',
  default_lang: 'ur',
  receipt_prefix: 'GSA',
  has_logo: false,
  short_name: 'GSA',
  city: 'Pakpattan',
  brand_color: 'blue',
  setup_completed_at: '2026-10-01T00:00:00Z',
  attendance_mode: 'daily',
  weekly_off: [0],
};

function shellAt(roles: StaffRole[], routes: Record<string, unknown> = {}) {
  const api = mockApi({ 'GET /api/school': { school }, ...routes });
  renderAt(
    '/',
    '/*',
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<p>home</p>} />
        <Route path="students/:id" element={<p>profile</p>} />
        <Route path="students" element={<p>list</p>} />
      </Route>
    </Routes>,
    roles,
  );
  return api;
}

beforeAll(async () => {
  await initI18n('en');
});
beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-brand');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

describe('theme', () => {
  it('follows the phone until a choice is made, then remembers it per device', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('dark'),
      addEventListener: () => undefined,
    }));
    initTheme();
    expect(getThemePref()).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    setThemePref('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    // A reload reads the saved choice over the system setting.
    initTheme();
    expect(getThemePref()).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('the switch in the account menu sets and shows the choice', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined }));
    initTheme();
    renderAt('/', '/', <ThemeSwitch />);
    fireEvent.click(screen.getByRole('button', { name: /Dark/ }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: /Dark/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }));
    expect(localStorage.getItem(THEME_KEY)).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('the school colour is a curated key on <html>, remembered; anything else is teal', () => {
    setBrand('blue');
    expect(document.documentElement.dataset.brand).toBe('blue');
    expect(localStorage.getItem(BRAND_KEY)).toBe('blue');
    setBrand('#ff0000');
    expect(document.documentElement.hasAttribute('data-brand')).toBe(false);
  });
});

describe('navigation per role', () => {
  const tabs = (r: StaffRole[]) => bottomTabs(r).map((i) => i.to);
  it('phone bottom bar: office Home/Attendance/Fees/Messages; teacher Home/Attendance/Messages', () => {
    expect(tabs(['owner'])).toEqual(['/', '/attendance', '/fees', '/messages']);
    expect(tabs(['admin'])).toEqual(['/', '/attendance', '/fees', '/messages']);
    expect(tabs(['teacher'])).toEqual(['/', '/attendance', '/messages']);
    expect(tabs(['accountant'])).toEqual(['/', '/fees', '/messages']);
  });

  it('sidebar headings only for groups the role can see', () => {
    const heads = (r: StaffRole[]) => navGroups(r).groups.map((g) => g.id);
    expect(heads(['owner'])).toEqual(['people', 'daily', 'money', 'school']);
    // A teacher has no Settings / Audit entry: no "School" heading.
    expect(heads(['teacher'])).toEqual(['people', 'daily', 'money']);
    expect(navGroups(['teacher']).groups[2]?.items.map((i) => i.to)).toEqual([
      '/fees/defaulters',
      '/my/payslips',
    ]);
  });

  it('desktop sidebar shows the school, grouped menu and "Runs on Maktab"; More holds the rest', async () => {
    shellAt(['owner']);
    const side = document.getElementById('sidebar') as HTMLElement;
    expect(await within(side).findByText('Global Science Academy')).toBeTruthy();
    expect(within(side).getByText('Pakpattan')).toBeTruthy();
    expect(side.querySelector('[data-badge="GSA"][data-color="blue"]')).toBeTruthy();
    for (const h of ['People', 'Daily work', 'Money', 'School'])
      expect(within(side).getByRole('heading', { name: h })).toBeTruthy();
    expect(within(side).getByText('Runs on Maktab')).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.brand).toBe('blue'));
    const bar = document.getElementById('tabbar') as HTMLElement;
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual(['/', '/attendance', '/fees', '/messages']);
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const more = await screen.findByRole('navigation', { name: 'More' });
    const hrefs = within(more)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '/students',
      '/groups',
      '/expenses',
      '/salary',
      '/reports',
      '/settings',
      '/audit',
    ]);
    // The account is reachable on the phone too.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('a teacher’s phone bar has no Fees tab', () => {
    shellAt(['teacher']);
    const bar = document.getElementById('tabbar') as HTMLElement;
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Home', 'Attendance', 'Messages']);
  });
});

describe('student search (top bar)', () => {
  const hit = (n: number) => ({
    id: `01JAAAAAAAAAAAAAAAAAAAAS${String(n).padStart(2, '0')}`,
    name: `Ali ${n}`,
    admission_no: `2026-${n}`,
    group_name: '5-A',
    status: 'active',
  });

  it('asks the Students endpoint (server-scoped, active only) and lists at most 6', async () => {
    const api = mockApi({
      'GET /api/students': {
        items: Array.from({ length: 9 }, (_, i) => hit(i + 1)),
        total: 9,
        page: 1,
        page_size: 50,
      },
    });
    renderAt(
      '/',
      '/*',
      <Routes>
        <Route path="/" element={<GlobalSearch />} />
        <Route path="/students/:id" element={<p>profile</p>} />
      </Routes>,
      ['teacher'],
    );
    const box = screen.getByRole('combobox', { name: 'Search students' });
    fireEvent.change(box, { target: { value: 'al' } });
    const list = await screen.findByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(SEARCH_LIMIT));
    const call = api.calls.find((c) => c.path.startsWith('/api/students'));
    expect(call?.path).toBe('/api/students?q=al&status=active&page=1');
    expect(within(list).getByRole('button', { name: 'See all results' })).toBeTruthy();
    fireEvent.click(within(list).getAllByRole('option')[0] as HTMLElement);
    expect(await screen.findByText('profile')).toBeTruthy();
  });

  it('one letter does not search; no student-reader, no search box', async () => {
    const api = mockApi({});
    const { unmount } = renderAt('/', '/', <GlobalSearch />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a' } });
    await new Promise((r) => setTimeout(r, 300));
    expect(api.calls.filter((c) => c.path.startsWith('/api/students'))).toEqual([]);
    unmount();
    renderAt('/', '/', <GlobalSearch />, []);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});

describe('school badge and shared parts', () => {
  it('draws the short name in the school colour, initials when there is none', () => {
    const { container, rerender } = renderAt(
      '/',
      '/',
      <SchoolBadge shortName="gsa" color="blue" label="GSA badge" />,
    );
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.dataset.badge).toBe('GSA');
    expect(svg.querySelector('text')?.getAttribute('fill')).toBe('#1e40af');
    expect(svg.getAttribute('role')).toBe('img');
    rerender(<SchoolBadge name="Al-Noor Community School" />);
    expect(container.querySelector('svg')?.dataset.badge).toBe('ANC');
    expect(container.querySelector('svg')?.dataset.color).toBe('teal');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('money cell: small PKR then the amount, one isolated run; status tones', () => {
    const { container } = renderAt(
      '/',
      '/',
      <>
        <Mny paisa={6020000} />
        <StatusBadge tone="bad">Overdue</StatusBadge>
      </>,
    );
    const m = container.querySelector('.mny') as HTMLElement;
    expect(m.tagName).toBe('BDI');
    expect(m.textContent).toBe('PKR 60,200');
    expect(m.querySelector('.mny-cur')?.textContent).toBe('PKR');
    expect(screen.getByText('Overdue').dataset.tone).toBe('bad');
    expect(screen.getByText('Overdue').className).toContain('bg-bad-soft');
  });
});

describe('sign-in page', () => {
  it('shows the school (badge, both names, city, office phone) and keeps the plain Google link', async () => {
    mockApi({
      'GET /api/identity': {
        school: {
          name: school.name,
          name_ur: school.name_ur,
          city: 'Pakpattan',
          short_name: 'GSA',
          brand_color: 'blue',
          phone: '92457123456',
          logo_v: null,
        },
      },
    });
    renderAt('/login', '/login', <Login />, []);
    expect(await screen.findByRole('heading', { name: 'Global Science Academy' })).toBeTruthy();
    expect(screen.getByText('گلوبل سائنس اکیڈمی').getAttribute('lang')).toBe('ur');
    expect(screen.getByText('Pakpattan')).toBeTruthy();
    expect(document.querySelector('[data-badge="GSA"]')).toBeTruthy();
    expect(screen.getByText('Staff sign-in')).toBeTruthy();
    expect(screen.getByText('Are you a parent?')).toBeTruthy();
    expect(screen.getByText(formatPkPhone('92457123456')).closest('a')?.getAttribute('href')).toBe(
      'tel:+92457123456',
    );
    expect(screen.getByText('Runs on Maktab')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Sign in with Google/ }).getAttribute('href')).toBe(
      '/api/auth/google/start',
    );
  });

  it('with a logo: the logo from the public route; before setup: Maktab', async () => {
    mockApi({
      'GET /api/identity': {
        school: {
          name: 'Al-Noor',
          name_ur: null,
          city: null,
          short_name: 'AN',
          brand_color: null,
          phone: null,
          logo_v: 'abc123',
        },
      },
    });
    const { unmount } = renderAt('/login', '/login', <Login />, []);
    await screen.findByRole('heading', { name: 'Al-Noor' });
    const logos = [...document.querySelectorAll('img[data-logo]')].map((i) =>
      i.getAttribute('src'),
    );
    expect(logos[0]).toBe('/api/identity/logo?v=abc123');
    unmount();
    mockApi({ 'GET /api/identity': { school: null } });
    renderAt('/login', '/login', <Login />, []);
    expect(await screen.findByRole('heading', { name: 'Maktab' })).toBeTruthy();
    expect(screen.queryByText('Are you a parent?')).toBeNull();
  });
});

describe('five-step setup', () => {
  it('names five stages and previews the badge, colour and staged logo live', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:logo', revokeObjectURL: () => undefined }),
    );
    mockApi({ 'GET /api/school': { school: null }, 'GET /api/sessions': { items: [session] } });
    renderAt('/setup', '/setup', <SetupWizard />);
    expect(await screen.findByText('Step 1 of 5')).toBeTruthy();
    const rail = screen.getAllByRole('list', { name: 'Set up your school' })[0] as HTMLElement;
    expect(
      within(rail)
        .getAllByRole('listitem')
        .map((l) => l.textContent?.replace(/^\d/, '')),
    ).toEqual(['Your school', 'Classes and sections', 'Fees', 'Staff', 'Done']);
    const preview = document.getElementById('identity-preview') as HTMLElement;
    fireEvent.change(screen.getByLabelText(/School name/), {
      target: { value: 'Global Science Academy' },
    });
    // The short name is suggested from the name until typed.
    expect((screen.getByLabelText(/Short name/) as HTMLInputElement).placeholder).toBe('GSA');
    await waitFor(() =>
      expect(preview.querySelector('[data-preview-icon]')?.textContent).toBe('GSA'),
    );
    fireEvent.change(screen.getByLabelText(/Short name/), { target: { value: 'g s' } });
    expect((screen.getByLabelText(/Short name/) as HTMLInputElement).value).toBe('GS');
    fireEvent.click(screen.getByLabelText('Maroon'));
    await waitFor(() =>
      expect(preview.querySelector('[data-badge="GS"]')?.getAttribute('data-color')).toBe('maroon'),
    );
    expect(document.documentElement.dataset.brand).toBe('maroon');
    // No logo yet: the badge stands in; a chosen file shows in the preview at once.
    expect(screen.getByText('No logo yet? This badge is used until you add one.')).toBeTruthy();
    const input = document.getElementById('school-logo') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(10)], 'l.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(preview.querySelector('img[data-logo]')?.getAttribute('src')).toBe('blob:logo'),
    );
  });
});

describe('home per role', () => {
  const today = {
    date: '2026-10-13',
    day_off: null,
    registers: {
      total: 3,
      taken: 1,
      not_taken: [
        {
          grp_id: 'G2',
          grp_name: '5-B',
          programme_name: 'Class 5',
          grp_subject_id: '',
          subject_name: null,
          class_teacher_name: null,
        },
        {
          grp_id: 'G3',
          grp_name: '6-A',
          programme_name: 'Class 6',
          grp_subject_id: '',
          subject_name: null,
          class_teacher_name: null,
        },
      ],
    },
    absentees: [],
    queued_absence_messages: 0,
    billing_alerts: 0,
  };
  const fees = {
    date: '2026-10-13',
    collected: [{ method: 'cash', amount: 4120000, count: 9 }],
    collected_total: 4120000,
    dues_outstanding: 18450000,
    defaulters: 14,
    billing_alerts: 2,
    queued_fee_messages: 0,
  };

  it('picks the variant from the grants', () => {
    expect(homeVariant(['owner'])).toBe('office');
    expect(homeVariant(['admin'])).toBe('office');
    expect(homeVariant(['accountant'])).toBe('accountant');
    expect(homeVariant(['teacher'])).toBe('teacher');
    expect(homeVariant([])).toBe('none');
  });

  it('owner: today cards, and "Needs attention" from registers, defaulters, drawer, billing and alarms', async () => {
    const api = mockApi({
      'GET /api/school': { school },
      'GET /api/dashboard/today': today,
      'GET /api/dashboard/fees': fees,
      'GET /api/messages/counts': {
        queued: 10,
        sent_today: 0,
        skipped_today: 0,
        by_template: { absence: 4, notice: 6 },
      },
      'GET /api/cash/sessions': { sessions: [{ id: 'C1', expected: 4120000 }] },
      'GET /api/alarms/latest': {
        event: {
          day: '2026-10-13',
          at: '',
          total: 1,
          acknowledged_at: null,
          alarms: [{ kind: 'backup_stale', count: 1 }],
        },
      },
      'POST /api/alarms/2026-10-13/ack': { ok: true },
    });
    renderAt('/', '/', <Dashboard />, ['owner']);
    expect(await screen.findByText('1 of 3 taken')).toBeTruthy();
    expect(document.getElementById('home-collected')?.textContent).toContain('PKR 41,200');
    expect(await screen.findByText('10 waiting')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Take Class 5 5-B/ }).getAttribute('href')).toContain(
      'G2',
    );
    await waitFor(() => expect(document.getElementById('attn-alarm-backup_stale')).toBeTruthy());
    const ids = [
      ...(document.getElementById('home-attention')?.querySelectorAll('li[id]') ?? []),
    ].map((l) => l.id);
    expect(ids).toEqual([
      'attn-registers',
      'attn-defaulters',
      'attn-drawer',
      'attn-billing',
      'attn-alarm-backup_stale',
    ]);
    expect(document.querySelector('#attn-defaulters a')?.getAttribute('href')).toBe(
      '/fees/defaulters',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === '/api/alarms/2026-10-13/ack')).toBe(true),
    );
  });

  it('teacher: registers and messages only — no money, no money requests', async () => {
    const api = mockApi({
      'GET /api/attendance/today': {
        date: '2026-10-13',
        mode: 'daily',
        day_off: null,
        items: [
          {
            grp_id: 'G1',
            grp_name: '5-A',
            programme_name: 'Class 5',
            grp_subject_id: '',
            subject_name: null,
            class_teacher_name: null,
            student_count: 20,
            status: 'not_taken',
            register_id: null,
            counts: { P: 0, A: 0, L: 0, E: 0 },
            taken_by_name: null,
            taken_at: null,
          },
        ],
      },
      'GET /api/messages/counts': {
        queued: 2,
        sent_today: 0,
        skipped_today: 0,
        by_template: { absence: 2 },
      },
    });
    renderAt('/', '/', <Dashboard />, ['teacher']);
    expect(await screen.findByText('Your registers today')).toBeTruthy();
    expect(await screen.findByText(/5-A/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/PKR|Collect a fee|Collected today/);
    await new Promise((r) => setTimeout(r, 20));
    const paths = api.calls.map((c) => c.path);
    expect(paths.some((p) => /dashboard\/(fees|month)|cash|receipts/.test(p))).toBe(false);
  });

  it('accountant: counter, own drawer and the queue; no attendance', async () => {
    mockApi({
      'GET /api/dashboard/fees': { ...fees, billing_alerts: 0 },
      'GET /api/cash/sessions': { sessions: [] },
      'GET /api/messages/counts': { queued: 0, sent_today: 0, skipped_today: 0, by_template: {} },
    });
    renderAt('/', '/', <Dashboard />, ['accountant']);
    expect(await screen.findByRole('link', { name: /Collect a fee/ })).toBeTruthy();
    expect(await screen.findByText('Not open today.')).toBeTruthy();
    expect(screen.queryByText('Attendance registers')).toBeNull();
    expect(await screen.findByText('Nothing is waiting to be sent.')).toBeTruthy();
  });
});

describe('Urdu mirroring (smoke)', () => {
  it('the shell turns right-to-left, in Urdu, with logical sides and mirrored arrows', async () => {
    await act(() => setLanguage('ur'));
    shellAt(['owner']);
    expect(document.documentElement.dir).toBe('rtl');
    const side = document.getElementById('sidebar') as HTMLElement;
    // Logical utilities only: the sidebar border/active bar use start/end, never left/right.
    expect(side.outerHTML).not.toMatch(/\b(left|right|ml|mr|pl|pr)-/);
    expect(await within(side).findByRole('heading', { name: 'لوگ' })).toBeTruthy();
    expect(within(side).getByText('Maktab پر چلتا ہے')).toBeTruthy();
    fireEvent.click(within(side).getByRole('button', { name: 'اکاؤنٹ مینو' }));
    const out = screen.getByRole('button', { name: 'سائن آؤٹ' });
    expect(out.querySelector('svg')?.getAttribute('class')).toContain('rtl:-scale-x-100');
    // The school's Urdu name leads in Urdu.
    expect(await within(side).findByText('گلوبل سائنس اکیڈمی')).toBeTruthy();
  });
});

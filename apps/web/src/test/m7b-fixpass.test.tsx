import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_COLOR_KEYS, BRAND_COLORS, STATUS_TOKENS, tokenVar } from '@maktab/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { useState } from 'react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell, ThemeSwitch } from '@/components/AppShell';
import { StatusChip } from '@/components/attendance/common';
import { Avatar, initials } from '@/components/avatar';
import { DataTable } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { GlobalSearch } from '@/components/GlobalSearch';
import { PayslipPrint } from '@/components/money/payslip';
import { changeOf, Skeleton, StatStrip } from '@/components/page';
import { RowMenu } from '@/components/row-menu';
import { SegmentedControl, TabPanel, Tabs } from '@/components/segmented';
import { SchoolForm } from '@/components/setup/school';
import { Button } from '@/components/ui/button';
import { initI18n, setLanguage } from '@/i18n';
import { Dashboard, loadState } from '@/pages/Dashboard';
import { Login } from '@/pages/Login';
import { SetupWizard } from '@/pages/Setup';
import { mockApi, renderAt, session } from './api-mock';

// M7b part 1 fix pass: contrast tokens, honest home states, register marks, setup preview, payslip
// print, wording, badge letters, theme boot, reduced motion, search a11y, phone top bar, and the
// shared parts owed to part 2 (DataTable, FilterBar, Avatar, RowMenu, Tabs/SegmentedControl,
// StatStrip comparison).

const web = join(__dirname, '..', '..');
const css = readFileSync(join(web, 'src', 'styles.css'), 'utf8');

/** The declarations of the first CSS block whose selector line is exactly `head`. */
function block(head: string): Record<string, string> {
  const at = css.indexOf(`\n${head} {`);
  if (at < 0) throw new Error(`no block ${head}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] ?? '').trim()]),
  );
}

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

/** matchMedia that answers `phone` for the max-width query (DataTable / FilterBar layouts). */
function stubMedia(phone: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('max-width') ? phone : false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
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

describe('colour tokens (item 1, 9)', () => {
  it('styles.css carries exactly the tested status, solid and input values, light and dark', () => {
    const light = block(':root');
    const dark = block('  html.dark');
    for (const [k, v] of Object.entries(STATUS_TOKENS.light)) {
      if (k === 'card' || k === 'background' || k === 'foreground' || k === 'mutedForeground') {
        const name = k === 'mutedForeground' ? '--muted-foreground' : tokenVar(k);
        expect(light[name], name).toBe(v);
        continue;
      }
      expect(light[tokenVar(k)], `light ${tokenVar(k)}`).toBe(v);
    }
    for (const [k, v] of Object.entries(STATUS_TOKENS.dark)) {
      const name = k === 'mutedForeground' ? '--muted-foreground' : tokenVar(k);
      if (/Solid$|^onSolid$/.test(k)) {
        // Solid fills are the same in both themes: dark does not override them.
        expect(dark[name], `dark ${name} not overridden`).toBeUndefined();
        expect(light[name]).toBe(v);
      } else expect(dark[name], `dark ${name}`).toBe(v);
    }
  });

  it('styles.css carries the curated school colours (BRAND_COLORS) for light and dark', () => {
    const teal = BRAND_COLORS.teal;
    expect(block(':root')['--brand']).toBe(teal.light.brand);
    expect(block('  html.dark')['--brand']).toBe(teal.dark.brand);
    for (const k of BRAND_COLOR_KEYS.filter((c) => c !== 'teal')) {
      const l = block(`html[data-brand="${k}"]`);
      const d = block(`  html.dark[data-brand="${k}"]`);
      expect([l['--brand'], l['--brand-fg'], l['--side']]).toEqual([
        BRAND_COLORS[k].light.brand,
        BRAND_COLORS[k].light.fg,
        BRAND_COLORS[k].light.side,
      ]);
      expect([d['--brand'], d['--brand-fg'], d['--side']]).toEqual([
        BRAND_COLORS[k].dark.brand,
        BRAND_COLORS[k].dark.fg,
        BRAND_COLORS[k].dark.side,
      ]);
    }
  });

  it('the destructive button is the solid red with white text (never text-white on --bad)', () => {
    renderAt('/', '/', <Button variant="destructive">Delete</Button>);
    const cls = screen.getByRole('button').className.split(/\s+/);
    expect(cls).toContain('bg-bad-solid');
    expect(cls).toContain('text-on-solid');
    expect(cls).not.toContain('bg-destructive');
    expect(cls).not.toContain('text-white');
  });
});

describe('home: never a false all-clear (item 3)', () => {
  const ownerRoutes = (over: Record<string, unknown>) => ({
    'GET /api/school': { school },
    'GET /api/messages/counts': { queued: 0, sent_today: 0, skipped_today: 0, by_template: {} },
    'GET /api/cash/sessions': { sessions: [] },
    'GET /api/alarms/latest': { event: null },
    'GET /api/dashboard/month': new Response('{}', { status: 500 }),
    ...over,
  });
  const fees = {
    date: '2026-10-13',
    collected: [],
    collected_total: 0,
    dues_outstanding: 0,
    defaulters: 0,
    billing_alerts: 0,
    queued_fee_messages: 0,
  };
  const today = {
    date: '2026-10-13',
    day_off: null,
    registers: { total: 0, taken: 0, not_taken: [] },
    absentees: [],
    queued_absence_messages: 0,
    billing_alerts: 0,
  };

  it('pure rule: loading, failed, offline (paused or no network), ready', () => {
    const q = (o: Partial<Parameters<typeof loadState>[0][number]>) => ({
      isError: false,
      isPending: false,
      isSuccess: true,
      fetchStatus: 'idle' as const,
      refetch: () => undefined,
      ...o,
    });
    expect(loadState([q({})])).toBe('ready');
    expect(loadState([q({}), q({ isPending: true, isSuccess: false })])).toBe('loading');
    expect(loadState([q({ isPending: true, isSuccess: false })], true)).toBe('offline');
    expect(loadState([q({ isPending: true, isSuccess: false, fetchStatus: 'paused' })])).toBe(
      'offline',
    );
    expect(loadState([q({ isPending: true }), q({ isError: true, isSuccess: false })])).toBe(
      'failed',
    );
  });

  it('while a source is still loading: a skeleton, not "Nothing needs attention"', async () => {
    mockApi(
      ownerRoutes({
        'GET /api/dashboard/today': () => new Promise(() => undefined),
        'GET /api/dashboard/fees': fees,
      }),
    );
    renderAt('/', '/', <Dashboard />, ['owner']);
    const panel = await waitFor(() => {
      const p = document.getElementById('home-attention');
      if (!p) throw new Error('no panel');
      return p;
    });
    await waitFor(() => expect(panel.querySelector('[data-state="loading"]')).toBeTruthy());
    expect(within(panel).queryByText('Nothing needs attention right now.')).toBeNull();
  });

  it('when a source fails: an error line, never the all-clear; the today card says so too', async () => {
    const api = mockApi(
      ownerRoutes({
        'GET /api/dashboard/today': () =>
          new Response(JSON.stringify({ error: { code: 'internal' } }), { status: 500 }),
        'GET /api/dashboard/fees': fees,
      }),
    );
    renderAt('/', '/', <Dashboard />, ['owner']);
    const failed = await screen.findByText(/Could not check everything/);
    expect(failed.closest('[data-state="failed"]')?.getAttribute('role')).toBe('alert');
    expect(screen.queryByText('Nothing needs attention right now.')).toBeNull();
    // The registers card shows its own error with Try again (not a skeleton forever).
    const card = document.getElementById('home-registers') as HTMLElement;
    expect(card.dataset.state).toBe('error');
    expect(within(card).getByText(/Could not load this/)).toBeTruthy();
    const before = api.calls.filter((c) => c.path === '/api/dashboard/today').length;
    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.path === '/api/dashboard/today').length).toBeGreaterThan(
        before,
      ),
    );
  });

  it('all sources answered with nothing to do: the all-clear', async () => {
    mockApi(ownerRoutes({ 'GET /api/dashboard/today': today, 'GET /api/dashboard/fees': fees }));
    renderAt('/', '/', <Dashboard />, ['owner']);
    expect(await screen.findByText('Nothing needs attention right now.')).toBeTruthy();
  });

  it('offline with nothing cached: says it cannot check, not all-clear', async () => {
    mockApi(
      ownerRoutes({
        'GET /api/dashboard/today': () => new Promise(() => undefined),
        'GET /api/dashboard/fees': fees,
      }),
    );
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    window.dispatchEvent(new Event('offline'));
    try {
      renderAt('/', '/', <Dashboard />, ['owner']);
      expect(
        await screen.findByText(/Offline: what needs attention cannot be checked/),
      ).toBeTruthy();
      expect(screen.queryByText('Nothing needs attention right now.')).toBeNull();
    } finally {
      delete (window.navigator as { onLine?: boolean }).onLine;
      window.dispatchEvent(new Event('online'));
    }
  });

  it('messages card chips count messages, in the info tone (item 7)', async () => {
    mockApi(
      ownerRoutes({
        'GET /api/dashboard/today': today,
        'GET /api/dashboard/fees': fees,
        'GET /api/messages/counts': {
          queued: 3,
          sent_today: 0,
          skipped_today: 0,
          by_template: { absence: 1, notice: 2 },
        },
      }),
    );
    renderAt('/', '/', <Dashboard />, ['owner']);
    const card = await waitFor(() => {
      const c = document.querySelector('#dash-messages [data-kind="absence"]');
      if (!c) throw new Error('no chip');
      return c as HTMLElement;
    });
    expect(card.textContent).toBe('Absent today · 1 message to send');
    expect(card.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('info');
    expect(document.querySelector('#dash-messages [data-kind="notice"]')?.textContent).toBe(
      'Notice · 2 messages to send',
    );
  });
});

describe('plural-aware counts in dialogs and banners (verify item 3)', () => {
  it('one and many read correctly, in English and Urdu', async () => {
    expect(i18next.t('auth.unsentBody', { count: 1 })).toBe(
      '1 register not yet sent — sign out anyway?',
    );
    expect(i18next.t('auth.unsentBody', { count: 2 })).toBe(
      '2 registers not yet sent — sign out anyway?',
    );
    expect(i18next.t('attendance.waitingHere', { count: 1 })).toBe(
      '1 saved register waiting on this phone',
    );
    expect(i18next.t('fee.defaulters.queued', { count: 1 })).toBe(
      '1 family queued in the send queue',
    );
    expect(i18next.t('home.messages.toSend', { count: 1 })).toBe('1 message to send');
    await act(() => setLanguage('ur'));
    expect(i18next.t('auth.unsentBody', { count: 1 })).toContain('بھیجا گیا');
    expect(i18next.t('auth.unsentBody', { count: 3 })).toContain('بھیجے گئے');
  });
});

describe('register marks (item 4)', () => {
  it('the current mark is a solid fill; badges elsewhere stay soft', () => {
    renderAt(
      '/',
      '/',
      <>
        <StatusChip status="A" solid />
        <StatusChip status="L" />
      </>,
    );
    const [solid, soft] = screen.getAllByTitle(/Absent|Late/);
    expect(solid?.className).toContain('bg-bad-solid');
    expect(solid?.className).toContain('text-on-solid');
    expect(solid?.dataset.solid).toBe('true');
    expect(soft?.className).toContain('bg-warn-soft');
    expect(soft?.dataset.solid).toBeUndefined();
  });
});

describe('setup preview (item 5) and short names (item 8)', () => {
  it('no installed-icon tile; with a saved logo every preview uses the logo (Al-Noor)', async () => {
    mockApi({
      'GET /api/school': {
        school: { ...school, name: 'Al-Noor Community School', short_name: 'AN', has_logo: true },
      },
      'GET /api/sessions': { items: [session] },
    });
    renderAt('/setup', '/setup', <SetupWizard />);
    const preview = await waitFor(() => {
      const p = document.getElementById('identity-preview');
      if (!p) throw new Error('no preview');
      return p;
    });
    expect(preview.querySelector('[data-preview-icon]')).toBeNull();
    expect(within(preview).queryByText('Icon on staff phones')).toBeNull();
    for (const part of ['signin', 'shell', 'receipt']) {
      const el = preview.querySelector(`[data-preview="${part}"]`) as HTMLElement;
      expect(el.querySelector('img[data-logo]')?.getAttribute('src'), part).toBe(
        '/api/school/logo',
      );
      expect(el.querySelector('[data-badge]'), part).toBeNull();
    }
    expect(within(preview.querySelector('[data-preview="shell"]') as HTMLElement).getByText('AN'));
  });

  it('an Urdu-only name needs a short name before it saves', async () => {
    const api = mockApi({
      'PUT /api/school': { school: { ...school, name: 'گلوبل', short_name: 'GSA' } },
      'GET /api/fees/settings': { fees: { receipts_issued: 0 } },
    });
    renderAt('/', '/', <SchoolForm school={null} part="identity" />);
    fireEvent.change(screen.getByLabelText(/School name/), {
      target: { value: 'گلوبل سائنس اکیڈمی' },
    });
    expect(screen.getByText(/has no English letters/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Type a short name in English letters/)).toBeTruthy();
    expect(api.calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.change(screen.getByLabelText(/Short name/), { target: { value: 'gsa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'PUT')).toBe(true));
  });
});

describe('payslip print (item 6)', () => {
  it('prints on its own named A5 page while shown, like the receipts', () => {
    const slip = {
      id: 'S1',
      staff_id: 'ST1',
      staff_name: 'Ayesha Bibi',
      staff_role: 'teacher',
      period_key: '2026-10',
      status: 'approved',
      earnings: 3200000,
      deductions: 0,
      recovery: 0,
      pay: 3200000,
      net: 3200000,
      paid: 0,
      paid_partial: false,
      approved_by_name: null,
      approved_at: null,
      void_reason: null,
      lines: [{ id: 'L1', kind: 'basic', amount: 3200000, note: null }],
      payments: [],
      advance: { advanced: 0, recovered: 0, outstanding: 0 },
      can_approve: false,
      school: { name: 'GSA', name_ur: null, address: null, phone: null },
    } as const;
    const { unmount } = renderAt(
      '/',
      '/',
      <PayslipPrint
        slip={slip as unknown as Parameters<typeof PayslipPrint>[0]['slip']}
        lang="en"
      />,
    );
    const style = document.querySelector('style[data-receipt-page="payslip-a5"]');
    expect(style?.textContent).toBe('@media print { html, body { page: payslip-a5; } }');
    expect(document.getElementById('payslip-paper')?.className).toContain('payslip-a5');
    expect(css).toMatch(/@page payslip-a5 \{\s*size: A5 portrait;/);
    expect(css).toMatch(/\.receipt-a5\.payslip-a5 \{\s*page: payslip-a5;/);
    unmount();
    expect(document.querySelector('style[data-receipt-page="payslip-a5"]')).toBeNull();
  });
});

describe('no theme flash (item 10)', () => {
  const html = readFileSync(join(web, 'index.html'), 'utf8');
  const boot = readFileSync(join(web, 'public', 'theme-boot.js'), 'utf8');
  it('index.html paints the phone theme inline and runs the boot script before the bundle', () => {
    expect(html).toMatch(/<style>[\s\S]*prefers-color-scheme: dark[\s\S]*<\/style>/);
    const bootAt = html.indexOf('<script src="/theme-boot.js"></script>');
    expect(bootAt).toBeGreaterThan(0);
    expect(bootAt).toBeLessThan(html.indexOf('<script type="module"'));
    // CSP: scripts from 'self' only, so no inline <script> body.
    expect(html).not.toMatch(/<script>[^<]/);
  });

  const run = (theme: string | null, systemDark: boolean, brand?: string) => {
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-brand');
    localStorage.clear();
    if (theme) localStorage.setItem('maktab.theme', theme);
    if (brand) localStorage.setItem('maktab.brand', brand);
    vi.stubGlobal('matchMedia', () => ({ matches: systemDark }));
    new Function(boot)();
    return document.documentElement;
  };
  it('applies the saved choice over the phone, and only curated colours', () => {
    expect(run('dark', false).classList.contains('dark')).toBe(true);
    expect(run('light', true).classList.contains('light')).toBe(true);
    expect(run('light', true).classList.contains('dark')).toBe(false);
    expect(run(null, true).classList.contains('dark')).toBe(true);
    expect(run('system', false).classList.contains('light')).toBe(true);
    expect(run(null, false, 'maroon').dataset.brand).toBe('maroon');
    expect(run(null, false, '"><x').hasAttribute('data-brand')).toBe(false);
  });
});

describe('reduced motion (item 11)', () => {
  it('skeleton pulse and button transitions stop under prefers-reduced-motion', () => {
    const { container } = renderAt(
      '/',
      '/',
      <>
        <Skeleton className="h-4" />
        <Button>Go</Button>
      </>,
    );
    expect(container.querySelector('.animate-pulse')?.className).toContain(
      'motion-reduce:animate-none',
    );
    expect(screen.getByRole('button').className).toContain('motion-reduce:transition-none');
    const sheet = readFileSync(join(web, 'src', 'components', 'ui', 'sheet.tsx'), 'utf8');
    expect(sheet.match(/motion-reduce:animate-none/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('search combobox (item 12)', () => {
  it('arrow keys move aria-activedescendant over option ids', async () => {
    mockApi({
      'GET /api/students': {
        items: [1, 2].map((n) => ({
          id: `01JAAAAAAAAAAAAAAAAAAAAS0${n}`,
          name: `Ali ${n}`,
          admission_no: `2026-${n}`,
          group_name: '5-A',
          status: 'active',
        })),
        total: 2,
        page: 1,
        page_size: 50,
      },
    });
    renderAt('/', '/', <GlobalSearch />);
    const box = screen.getByRole('combobox', { name: 'Search students' });
    fireEvent.change(box, { target: { value: 'al' } });
    const opts = await screen.findAllByRole('option');
    expect(box.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[0]?.id);
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(opts[1]?.id);
    expect(opts[1]?.getAttribute('aria-selected')).toBe('true');
    expect(new Set(opts.map((o) => o.id)).size).toBe(2);
  });
});

describe('phone top bar (items 8, 13) and touch targets (verify items 1, 2)', () => {
  function shell(s: typeof school) {
    mockApi({ 'GET /api/school': { school: s } });
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
  }
  it('badge + short name + city in a 44 px home link; the badge draws at most 3 letters', async () => {
    shell({ ...school, short_name: 'ABCD' });
    const link = document.getElementById('topbar-school') as HTMLElement;
    await waitFor(() => expect(within(link).getByText('ABCD')).toBeTruthy());
    expect(within(link).getByText('Pakpattan')).toBeTruthy();
    expect(link.querySelector('[data-badge]')?.getAttribute('data-badge')).toBe('ABC');
    expect(link.className).toContain('min-h-11');
    expect(link.className).toContain('min-w-11');
    expect(link.getAttribute('href')).toBe('/');
    // The top bar clears the status bar / notch.
    expect(link.closest('header')?.className).toContain('pt-[env(safe-area-inset-top)]');
  });

  it('theme buttons fill the density token; the sign-in office phone is a 44 px target', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined }));
    renderAt('/', '/', <ThemeSwitch />);
    for (const b of screen.getAllByRole('button')) {
      expect(b.className).toContain('h-[calc(var(--h)-8px)]');
      expect(b.className).not.toMatch(/flex-col/);
    }
    mockApi({
      'GET /api/identity': {
        school: {
          name: school.name,
          name_ur: null,
          city: null,
          short_name: 'GSA',
          brand_color: 'blue',
          phone: '92457123456',
          logo_v: null,
        },
      },
    });
    renderAt('/login', '/login', <Login />, []);
    const call = await waitFor(() => {
      const a = document.getElementById('door-call');
      if (!a) throw new Error('no call link');
      return a;
    });
    expect(call.className).toContain('min-h-11');
  });
});

describe('shared parts for part 2', () => {
  it('Avatar: one initials rule, photo with a fallback', () => {
    expect(initials('Ali Raza Khan')).toBe('AR');
    expect(initials('(Late) Ahmed khan')).toBe('AK');
    expect(initials('علی رضا')).toBe('عر');
    expect(initials('  ')).toBe('');
    const { container } = renderAt(
      '/',
      '/',
      <>
        <Avatar name="Sara Khan" />
        <Avatar name="Ali" src="/x.jpg" />
        <Avatar name="123" />
      </>,
    );
    const [a, b, c] = [...container.querySelectorAll('[data-avatar]')];
    expect(a?.textContent).toBe('SK');
    expect(b?.tagName).toBe('IMG');
    fireEvent.error(b as Element);
    expect(container.querySelectorAll('[data-avatar="initials"]')).toHaveLength(3);
    expect(c?.textContent).toBe('·');
  });

  type Row = { id: string; name: string; due: number };
  const rows: Row[] = [
    { id: 'a', name: 'Ali', due: 500 },
    { id: 'b', name: 'Sara', due: 0 },
  ];
  const cols = [
    { id: 'name', header: 'Name', cell: (r: Row) => r.name, primary: true },
    { id: 'due', header: 'Due', cell: (r: Row) => String(r.due), numeric: true },
  ];

  it('DataTable: a semantic table on desktop with one row link each', () => {
    stubMedia(false);
    renderAt(
      '/',
      '/',
      <DataTable
        caption="Students"
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        rowHref={(r) => `/students/${r.id}`}
        rowActions={() => <button type="button">menu</button>}
      />,
    );
    const table = screen.getByRole('table', { name: 'Students' });
    expect(table.dataset.layout).toBe('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Name', 'Due', 'More actions']);
    expect(within(table).getAllByRole('rowheader')).toHaveLength(2);
    expect(within(table).getByRole('link', { name: 'Ali' }).getAttribute('href')).toBe(
      '/students/a',
    );
    expect(within(table).getAllByRole('cell')[0]?.className).toContain('text-end');
  });

  it('DataTable: cards on a phone (label/value), each value once; loading, error, empty', () => {
    stubMedia(true);
    const { rerender } = renderAt(
      '/',
      '/',
      <DataTable caption="Students" columns={cols} rows={rows} rowKey={(r) => r.id} />,
    );
    const list = screen.getByRole('list', { name: 'Students' });
    expect(list.dataset.layout).toBe('cards');
    expect(screen.queryByRole('table')).toBeNull();
    expect(within(list).getAllByText('Due')).toHaveLength(2);
    expect(screen.getAllByText('Ali')).toHaveLength(1);
    rerender(
      <DataTable caption="S" columns={cols} rows={undefined} rowKey={(r) => r.id} loading />,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(
      <DataTable caption="S" columns={cols} rows={[]} rowKey={(r) => r.id} error="Failed" />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Failed');
    rerender(<DataTable caption="S" columns={cols} rows={[]} rowKey={(r) => r.id} empty="None" />);
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('FilterBar: inline on desktop; on a phone a Filters button, a sheet and clearable chips', async () => {
    stubMedia(false);
    const clear = vi.fn();
    const filters = <label htmlFor="f-class">Class</label>;
    const active = [{ id: 'class', label: 'Class: 5-A', onClear: clear }];
    const { unmount } = renderAt('/', '/', <FilterBar active={active}>{filters}</FilterBar>);
    expect(document.getElementById('filters')?.dataset.layout).toBe('inline');
    expect(screen.getByText('Class')).toBeTruthy();
    unmount();
    stubMedia(true);
    renderAt('/', '/', <FilterBar active={active}>{filters}</FilterBar>);
    expect(document.getElementById('filters')?.dataset.layout).toBe('sheet');
    expect(screen.queryByText('Class')).toBeNull();
    const open = screen.getByRole('button', { name: /Filters/ });
    expect(open.textContent).toContain('1');
    fireEvent.click(screen.getByRole('button', { name: /Class: 5-A/ }));
    expect(clear).toHaveBeenCalledTimes(1);
    fireEvent.click(open);
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).getByText('Class')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Show results' })).toBeTruthy();
  });

  it('RowMenu: rare actions in a menu, the destructive one last and red', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const voidIt = vi.fn();
    const view = vi.fn();
    renderAt(
      '/',
      '/',
      <RowMenu
        label="More actions for EXP-1"
        actions={[
          { id: 'void', label: 'Void', onSelect: voidIt, destructive: true },
          { id: 'view', label: 'View photo', onSelect: view },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More actions for EXP-1' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['View photo', 'Void']);
    expect(items[1]?.dataset.destructive).toBe('true');
    expect(items[1]?.className).toContain('text-destructive');
    fireEvent.click(items[1] as HTMLElement);
    expect(voidIt).toHaveBeenCalledTimes(1);
    expect(view).not.toHaveBeenCalled();
  });

  it('Tabs: tablist with roving focus and panels; SegmentedControl: pressed buttons', () => {
    const Harness = () => {
      const [v, setV] = useState<'fees' | 'att'>('fees');
      return (
        <>
          <Tabs
            label="Profile"
            idBase="p"
            value={v}
            onChange={setV}
            items={[
              { value: 'fees', label: 'Fees' },
              { value: 'att', label: 'Attendance', count: 3 },
            ]}
          />
          <TabPanel idBase="p" value={v}>
            {v}
          </TabPanel>
        </>
      );
    };
    renderAt('/', '/', <Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[0]?.getAttribute('aria-controls')).toBe('p-panel-fees');
    expect(tabs[1]?.tabIndex).toBe(-1);
    fireEvent.keyDown(tabs[0] as HTMLElement, { key: 'ArrowRight' });
    expect(screen.getAllByRole('tab')[1]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').textContent).toBe('att');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('p-tab-att');

    const onChange = vi.fn();
    renderAt(
      '/',
      '/',
      <SegmentedControl
        label="Paper"
        value="a5"
        onChange={onChange}
        options={[
          { value: 'a5', label: 'A5' },
          { value: 'thermal', label: '58 mm' },
        ]}
      />,
    );
    const group = screen.getByRole('group', { name: 'Paper' });
    expect(within(group).getByRole('button', { name: 'A5' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(within(group).getByRole('button', { name: '58 mm' }));
    expect(onChange).toHaveBeenCalledWith('thermal');
  });

  it('StatStrip: a comparison with direction, percentage and the right tone', () => {
    expect(changeOf(120, 100)).toEqual({ dir: 'up', pct: 20 });
    expect(changeOf(50, 100)).toEqual({ dir: 'down', pct: 50 });
    expect(changeOf(5, 0)).toEqual({ dir: 'up', pct: null });
    expect(changeOf(7, 7)).toEqual({ dir: 'same', pct: 0 });
    const { container } = renderAt(
      '/',
      '/',
      <StatStrip
        items={[
          {
            id: 'in',
            label: 'Income',
            value: '120',
            compare: { now: 120, before: 100, label: 'vs Sep' },
          },
          {
            id: 'out',
            label: 'Spending',
            value: '120',
            compare: { now: 120, before: 100, label: 'vs Sep', higherIsBetter: false },
          },
          { id: 'n', label: 'Net', value: '0', compare: { now: 0, before: 0, label: 'vs Sep' } },
        ]}
      />,
    );
    const inc = container.querySelector('#in [data-compare]') as HTMLElement;
    expect(inc.textContent).toBe('Up 20%vs Sep');
    expect(inc.className).toContain('text-ok');
    expect(container.querySelector('#out [data-compare]')?.className).toContain('text-bad');
    expect(container.querySelector('#n [data-compare]')?.textContent).toContain('No change');
  });
});

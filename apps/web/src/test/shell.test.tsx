import type { Language, MeResponse, StaffRole } from '@maktab/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppShell, navFor } from '@/components/AppShell';
import { initI18n, setLanguage } from '@/i18n';

export const meAs = (roles: StaffRole[]): MeResponse => ({
  user: { id: '01JABCDEFGHJKMNPQRSTVWXYZ0', email: 'o@example.com', name: 'O', status: 'active' },
  roles,
});

/** The nav depends on /api/me; seed it instead of fetching (no network in tests). */
function renderShell(roles: StaffRole[] = ['owner']) {
  const client = new QueryClient();
  client.setQueryData(['me'], meAs(roles));
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<p>home</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cases: [Language, 'ltr' | 'rtl', string, string][] = [
  ['en', 'ltr', 'Attendance', 'Fees'],
  ['ur', 'rtl', 'حاضری', 'فیس'],
];

describe('app shell', () => {
  beforeAll(async () => {
    await initI18n('en');
  });

  it.each(cases)('renders in %s with dir=%s', async (lang, dir, attendance, fees) => {
    await act(() => setLanguage(lang));
    renderShell();
    expect(document.documentElement.dir).toBe(dir);
    expect(document.documentElement.lang).toBe(lang);
    // Sidebar and phone tab bar both carry the daily tasks (CSS shows one of them).
    expect(screen.getAllByRole('link', { name: attendance })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: fees })).toHaveLength(2);
    expect(screen.getByText('home')).toBeTruthy();
    // The sync pill is one polite live region (saved → waiting → offline is announced).
    expect(document.getElementById('sync-state')?.getAttribute('aria-live')).toBe('polite');
  });

  it('renders the "اردو" toggle label in the system font (no Nastaliq download)', async () => {
    await act(() => setLanguage('en'));
    renderShell();
    // M7b: the language toggle sits in the account menu.
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    const label = screen.getByText('اردو');
    expect(label.getAttribute('lang')).toBe('ur');
    expect(label.classList.contains('font-system')).toBe(true);
  });

  it('shows each role only what it can use', () => {
    const paths = (roles: StaffRole[]) => navFor(roles).map((n) => n.to);
    // M7b grouping (UI plan §5.3): Home; People; Daily work; Money; School. Cash is a tab of
    // Fees and Advances part of Payroll, so neither has its own entry for roles that open those.
    expect(paths(['owner'])).toEqual([
      '/',
      '/students',
      '/groups',
      '/attendance',
      '/messages',
      '/fees',
      '/expenses',
      '/salary',
      '/reports',
      '/settings',
      '/audit',
      '/guide',
    ]);
    // The audit trail is the owner's alone (PLAN §5.4).
    expect(paths(['admin'])).toEqual(paths(['owner']).filter((p) => p !== '/audit'));
    expect(paths(['teacher'])).toEqual([
      '/',
      '/students',
      '/groups',
      '/attendance',
      '/messages',
      '/fees/defaulters',
      '/my/payslips',
      '/guide',
    ]);
    expect(navFor(['teacher']).find((n) => n.to === '/groups')?.label).toBe('nav.myGroups');
    expect(paths(['accountant'])).toEqual([
      '/',
      '/students',
      '/messages',
      '/fees',
      '/expenses',
      '/salary',
      '/reports',
      '/settings',
      '/guide',
    ]);
    expect(paths([])).toEqual([]);
  });
});

import type { Language, MeResponse, StaffRole } from '@maktab/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
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
    expect(screen.getByRole('link', { name: attendance })).toBeTruthy();
    expect(screen.getByRole('link', { name: fees })).toBeTruthy();
    expect(screen.getByText('home')).toBeTruthy();
  });

  it('renders the "اردو" toggle label in the system font (no Nastaliq download)', async () => {
    await act(() => setLanguage('en'));
    renderShell();
    const label = screen.getByText('اردو');
    expect(label.getAttribute('lang')).toBe('ur');
    expect(label.classList.contains('font-system')).toBe(true);
  });

  it('shows each role only what it can use', () => {
    const paths = (roles: StaffRole[]) => navFor(roles).map((n) => n.to);
    expect(paths(['owner'])).toEqual([
      '/',
      '/students',
      '/groups',
      '/attendance',
      '/fees',
      '/cash',
      '/messages',
      '/settings',
    ]);
    expect(paths(['admin'])).toEqual(paths(['owner']));
    expect(paths(['teacher'])).toEqual([
      '/',
      '/students',
      '/groups',
      '/attendance',
      '/fees/defaulters',
      '/messages',
    ]);
    expect(navFor(['teacher']).find((n) => n.to === '/groups')?.label).toBe('nav.myGroups');
    expect(paths(['accountant'])).toEqual([
      '/',
      '/students',
      '/fees',
      '/cash',
      '/messages',
      '/settings',
    ]);
    expect(paths([])).toEqual([]);
  });
});

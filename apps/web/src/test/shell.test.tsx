import type { Language } from '@maktab/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppShell } from '@/components/AppShell';
import { initI18n, setLanguage } from '@/i18n';

function renderShell() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
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
});

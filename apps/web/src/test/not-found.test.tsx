import type { StaffRole } from '@maktab/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { initI18n, setLanguage } from '@/i18n';
import { ApiError } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { RegisterPage } from '@/pages/attendance/Register';
import { FamilyStatementPage } from '@/pages/fees/FamilyStatement';
import { ReceiptPage } from '@/pages/fees/Receipt';
import { SponsorDetail } from '@/pages/fees/Sponsors';
import { GroupDetail } from '@/pages/Groups';
import { PayslipPage, PayslipPrintPage } from '@/pages/money/Salary';
import { StudentDetail } from '@/pages/students/StudentDetail';
import { StudentEdit } from '@/pages/students/StudentEdit';
import { meAs, mockApi, renderAt } from './api-mock';

beforeAll(async () => {
  await initI18n('en');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const BAD = '01JZZZZZZZZZZZZZZZZZZZZZZZ';

describe('not-found: the query client', () => {
  it('does not retry a 404, but still retries other failures', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== 'function') throw new Error('retry is not a function');
    expect(retry(0, new ApiError(404, 'not_found', 'Group not found'))).toBe(false);
    expect(retry(0, new ApiError(503, 'http_error', 'HTTP 503'))).toBe(true);
    expect(retry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(retry(3, new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('not-found: detail pages', () => {
  // Every API call answers 404 not_found (mockApi's default for an unlisted route).
  const cases: [string, string, string, ComponentType, string, StaffRole[]?][] = [
    ['student', `/students/${BAD}`, '/students/:id', StudentDetail, '/students'],
    ['student edit', `/students/${BAD}/edit`, '/students/:id/edit', StudentEdit, '/students'],
    ['group', `/groups/${BAD}`, '/groups/:id', GroupDetail, '/groups'],
    ['family statement', `/fees/family/${BAD}`, '/fees/family/:id', FamilyStatementPage, '/fees'],
    ['receipt', `/receipts/${BAD}`, '/receipts/:id', ReceiptPage, '/fees'],
    ['sponsor', `/fees/sponsors/${BAD}`, '/fees/sponsors/:id', SponsorDetail, '/fees/sponsors'],
    ['payslip', `/salary/${BAD}`, '/salary/:id', PayslipPage, '/salary'],
    ['payslip print', `/payslips/${BAD}/print`, '/payslips/:id/print', PayslipPrintPage, '/salary'],
    [
      'own payslip print',
      `/payslips/${BAD}/print`,
      '/payslips/:id/print',
      PayslipPrintPage,
      '/my/payslips',
      ['teacher'],
    ],
    [
      'attendance register',
      `/attendance/register/${BAD}`,
      '/attendance/register/:grpId',
      RegisterPage,
      '/attendance',
    ],
  ];

  it.each(cases)(
    '%s: a not_found answer shows the not-found state with a way back',
    async (_name, path, pattern, Page, back, roles = ['owner']) => {
      mockApi({});
      renderAt(path, pattern, <Page />, roles);
      expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
      expect(screen.getByText('It may have been removed, or the link is wrong.')).toBeTruthy();
      expect(document.getElementById('not-found-back')?.getAttribute('href')).toBe(back);
    },
  );

  it('other errors keep their own message', async () => {
    mockApi({
      'GET /api/fees/family/X1': () =>
        new Response(JSON.stringify({ error: { code: 'forbidden', message: 'No' } }), {
          status: 403,
        }),
    });
    renderAt('/fees/family/X1', '/fees/family/:id', <FamilyStatementPage />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(document.getElementById('not-found')).toBeNull();
  });
});

describe('not-found: unknown addresses', () => {
  const renderApp = (path: string) => {
    mockApi({
      'GET /api/school': {
        school: { id: 'S', name: 'Al-Noor', setup_completed_at: '2026-01-01T00:00:00.000Z' },
      },
    });
    const client = createQueryClient();
    client.setQueryData(['me'], meAs(['owner']));
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it.each([
    ['en', 'Page not found', 'Go to Home'],
    ['ur', 'صفحہ نہیں ملا', 'ہوم پر جائیں'],
  ] as const)(
    'in %s: "Page not found", one sentence and a link home',
    async (lang, title, home) => {
      await act(() => setLanguage(lang));
      renderApp('/fees/cash');
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
      expect(screen.getByRole('link', { name: home }).getAttribute('href')).toBe('/');
      expect(screen.queryByText('Coming in a later milestone.')).toBeNull();
      await act(() => setLanguage('en'));
    },
  );
});

import type { StaffRole } from '@maktab/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FEE_ROUTES } from '@/App';
import { RequireGrant } from '@/components/RequireGrant';
import { toast } from '@/components/ui/sonner';
import { initI18n } from '@/i18n';
import { meAs } from './api-mock';

beforeAll(async () => {
  await initI18n('en');
});
afterEach(() => vi.restoreAllMocks());

/** Who may open each fee route by URL (PLAN §5.4); everyone else is sent home with a toast. */
const ALLOWED: Record<string, readonly StaffRole[]> = {
  fees: ['owner', 'admin', 'accountant'],
  'fees/counter': ['owner', 'admin', 'accountant'],
  'fees/family/:id': ['owner', 'admin', 'accountant'],
  'fees/defaulters': ['owner', 'admin', 'accountant', 'teacher'],
  'fees/billing': ['owner', 'admin'],
  'fees/register': ['owner', 'admin', 'accountant'],
  'fees/concessions': ['owner', 'admin', 'accountant'],
  'fees/sponsors': ['owner', 'admin', 'accountant'],
  'fees/sponsors/:id': ['owner', 'admin', 'accountant'],
  'receipts/:id': ['owner', 'admin', 'accountant'],
  cash: ['owner', 'admin', 'accountant'],
};
const ROLES: StaffRole[] = ['owner', 'admin', 'accountant', 'teacher'];

function open(path: string, grant: (typeof FEE_ROUTES)[number][2], role: StaffRole) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['me'], meAs([role]));
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/${path.replace(/:id/g, 'X1')}`]}>
        <Routes>
          <Route path="/" element={<p>home</p>} />
          <Route
            path={`/${path}`}
            element={
              <RequireGrant grant={grant}>
                <p>page</p>
              </RequireGrant>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('fee routes are guarded by the shared MATRIX', () => {
  it('every fee route has an expectation', () => {
    expect(FEE_ROUTES.map(([p]) => p).sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  const cases = FEE_ROUTES.flatMap(([path, , grant]) =>
    ROLES.map((role) => [path, role, grant] as const),
  );
  it.each(cases)('%s as %s', (path, role, grant) => {
    const err = vi.spyOn(toast, 'error');
    open(path, grant, role);
    if (ALLOWED[path]?.includes(role)) {
      expect(screen.getByText('page')).toBeTruthy();
      expect(err).not.toHaveBeenCalled();
    } else {
      expect(screen.getByText('home')).toBeTruthy();
      expect(screen.queryByText('page')).toBeNull();
      expect(err).toHaveBeenCalledWith('You do not have access to this', {
        id: 'route-forbidden',
      });
    }
  });
});

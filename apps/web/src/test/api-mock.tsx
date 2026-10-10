import type { MeResponse, StaffRole } from '@maktab/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';

export type Call = { method: string; path: string; body: unknown };
type Handler = unknown | ((url: URL, init: RequestInit) => unknown);

/**
 * Stubs global fetch with a route table keyed "METHOD /path" (query string ignored for matching).
 * A handler may return (or resolve to) a Response, or any value that is sent as a 200 JSON body.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body =
        typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : (init.body ?? null);
      calls.push({ method, path: url.pathname + url.search, body });
      const handler = routes[`${method} ${url.pathname}`];
      if (handler === undefined) {
        return new Response(
          JSON.stringify({ error: { code: 'not_found', message: url.pathname } }),
          {
            status: 404,
          },
        );
      }
      const out: unknown = typeof handler === 'function' ? await handler(url, init) : handler;
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

export const meAs = (roles: StaffRole[]): MeResponse => ({
  user: { id: '01JABCDEFGHJKMNPQRSTVWXYZ0', email: 'o@example.com', name: 'O', status: 'active' },
  roles,
});

/** Router + fresh query client (no retries) with /api/me already answered. */
export function renderAt(
  path: string,
  pattern: string,
  element: ReactNode,
  roles: StaffRole[] = ['owner'],
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['me'], meAs(roles));
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={pattern} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const ids = {
  session: '01JAAAAAAAAAAAAAAAAAAAAAA1',
  programme: '01JAAAAAAAAAAAAAAAAAAAAAA2',
  group: '01JAAAAAAAAAAAAAAAAAAAAAA3',
  family: '01JAAAAAAAAAAAAAAAAAAAAAA4',
  student: '01JAAAAAAAAAAAAAAAAAAAAAA5',
};

export const session = {
  id: ids.session,
  name: '2026-27',
  start_date: '2026-04-01',
  end_date: '2027-03-31',
  is_current: true,
};

export const group = {
  id: ids.group,
  programme_id: ids.programme,
  programme_name: 'Class 5',
  programme_kind: 'grade',
  session_id: ids.session,
  name: 'A',
  is_primary: true,
  class_teacher_id: null,
  class_teacher_name: null,
  start_date: null,
  end_date: null,
  capacity: 30,
  days: null,
  start_time: null,
  end_time: null,
  room: null,
  next_grp_id: null,
  status: 'open',
  active_count: 1,
  seats_left: 29,
  subjects: [],
};

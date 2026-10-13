import 'fake-indexeddb/auto';
import type { AttendanceSubmission, MeResponse, StaffRole } from '@maktab/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '@/components/AppShell';
import { SyncBanner } from '@/components/attendance/common';
import { initI18n, setLanguage } from '@/i18n';
import { fetchMe } from '@/lib/api';
import { API_CACHE } from '@/offline/api-cache';
import { LOGOUT_COOKIE, logoutPending, queueLogout } from '@/offline/logout';
import * as ob from '@/offline/outbox';
import { _reset, refreshStatus, setOutboxUser } from '@/offline/sync';
import { Login } from '@/pages/Login';

// M7a fix pass (web): sign-out bound to the old session; Login never starts Google while offline
// with a revocation waiting; the outbox per user; the offline API copy cleared on a user change.

const A = '01JAAAAAAAAAAAAAAAAAAAAAAA';
const B = '01JBBBBBBBBBBBBBBBBBBBBBBB';
const meOf = (id: string, roles: StaffRole[], token = `tok-${id}`): MeResponse => ({
  user: { id, email: `${id.slice(-3)}@example.com`, name: 'X', status: 'active' },
  roles,
  logout_token: token,
});

const sub = (client_id: string, grp = 'g1'): AttendanceSubmission => ({
  client_id,
  grp_id: grp,
  date: '2026-10-12',

  marks: [{ student_id: 's1', status: 'P' }],
  taken_at: '2026-10-12T08:00:00.000Z',
});

let n = 0;
beforeAll(async () => {
  await initI18n('en');
});
beforeEach(async () => {
  await act(() => setLanguage('en'));
  localStorage.clear();
  // biome-ignore lint/suspicious/noDocumentCookie: test reset
  document.cookie = `${LOGOUT_COOKIE}=; Path=/; Max-Age=0`;
  ob._close();
  ob.configure({ dbName: `m7a-${n++}`, now: () => Date.now(), userId: null });
  _reset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  ob._close();
  delete (window.navigator as { onLine?: boolean }).onLine;
});

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Login with a sign-out still queued', () => {
  it('offline: does not go to Google, says to connect', async () => {
    await queueLogout('tok-old', async () => {
      throw new TypeError('offline');
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline');
      }),
    );
    renderLogin();
    fireEvent.click(screen.getByRole('link', { name: /Sign in with Google/ }));
    expect(await screen.findByText('Connect to the internet to sign in.')).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
    expect(logoutPending()).toBe(true);
  });

  it('server 5xx at sign-in time: goes on to Google (the callback revokes the old session by cookie)', async () => {
    await queueLogout('tok-old', async () => {
      throw new TypeError('offline');
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const f = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', f);
    renderLogin();
    fireEvent.click(screen.getByRole('link', { name: /Sign in with Google/ }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(String(assign.mock.calls[0]?.[0])).toContain('/api/auth/google/start');
    // The logout went with the token, not as a bare cookie sign-out.
    expect(
      JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toEqual({
      logout_token: 'tok-old',
    });
    // Still queued; the cookie is there for the callback.
    expect(document.cookie).toContain(`${LOGOUT_COOKIE}=tok-old`);
  });
});

describe('outbox per user on a shared phone', () => {
  it("syncs only the signed-in user's registers; another account's stay untouched", async () => {
    setOutboxUser(A);
    await ob.enqueue(sub('a1'), { label: 'A' });
    setOutboxUser(B);
    await ob.enqueue(sub('b1', 'g2'), { label: 'B' });
    const sent: string[] = [];
    const fetchImpl = async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as AttendanceSubmission[];
      for (const s of body) sent.push(s.client_id);
      return Response.json({
        results: body.map((s) => ({ client_id: s.client_id, status: 'applied' })),
      });
    };
    await ob.sync(fetchImpl);
    expect(sent).toEqual(['b1']);
    expect(await ob.pending()).toBe(0);
    expect(await ob.others()).toBe(1);
    expect(await ob.has('a1')).toBe(true);
    // A's failed-list actions cannot touch it either.
    await ob.discardFailed();
    expect(await ob.has('a1')).toBe(true);
    // A signs in again: it goes.
    setOutboxUser(A);
    expect(await ob.pending()).toBe(1);
    await ob.sync(fetchImpl);
    expect(sent).toEqual(['b1', 'a1']);
    expect(await ob.others()).toBe(0);
  });

  it('owner/admin see the count of another account’s registers; a teacher does not', async () => {
    setOutboxUser(A);
    await ob.enqueue(sub('a1'));
    await ob.enqueue(sub('a2', 'g3'));
    setOutboxUser(B);
    await refreshStatus();
    const show = (roles: StaffRole[]) => {
      const client = new QueryClient();
      client.setQueryData(['me'], meOf(B, roles));
      return render(
        <QueryClientProvider client={client}>
          <SyncBanner />
        </QueryClientProvider>,
      );
    };
    const owner = show(['owner']);
    expect(
      await screen.findByText(/2 registers saved by another account on this phone/),
    ).toBeTruthy();
    owner.unmount();
    show(['teacher']);
    expect(screen.queryByText(/another account/)).toBeNull();
  });
});

describe('sign-out', () => {
  function renderShell(me: MeResponse) {
    const client = new QueryClient();
    client.setQueryData(['me'], me);
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<p>home</p>} />
            </Route>
            <Route path="/login" element={<p>login page</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('warns when this user has registers not yet sent, then queues this session’s token', async () => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    const f = vi.fn(async () => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('fetch', f);
    setOutboxUser(A);
    await ob.enqueue(sub('a1'));
    await ob.enqueue(sub('a2', 'g2'));
    renderShell(meOf(A, ['teacher'], 'tok-A'));
    await act(() => refreshStatus());
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('2 registers not yet sent — sign out anyway?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('home')).toBeTruthy();
    expect(logoutPending()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out anyway' }));
    expect(await screen.findByText('login page')).toBeTruthy();
    expect(localStorage.getItem('maktab.logoutPending')).toBe('tok-A');
    // The registers stay on the phone for A.
    expect(await ob.has('a1')).toBe(true);
  });

  it('nothing waiting: signs out without asking', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true })),
    );
    setOutboxUser(A);
    renderShell(meOf(A, ['owner']));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('login page')).toBeTruthy();
  });
});

describe('offline API copy across accounts', () => {
  it('is deleted when /api/me answers with a different user than last time', async () => {
    const del = vi.fn(async () => true);
    vi.stubGlobal('caches', { delete: del });
    let who = A;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(meOf(who, ['teacher']))),
    );
    expect((await fetchMe()).user.id).toBe(A);
    expect((await fetchMe()).user.id).toBe(A);
    expect(del).not.toHaveBeenCalled();
    who = B;
    const me = await fetchMe();
    expect(me.user.id).toBe(B);
    expect(me.logout_token).toBe(`tok-${B}`);
    expect(del).toHaveBeenCalledWith(API_CACHE);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMe } from '@/lib/api';
import { flushLogout, logoutPending, queueLogout, startLogoutFlush } from '@/offline/logout';

// Sign-out while offline (M7, carried from M2): the server-side revocation is queued and sent on
// reconnect; until then the phone counts as signed out; a later sign-in flushes it first.

const offlineFetch = vi.fn(async () => {
  throw new TypeError('Failed to fetch');
});

beforeEach(() => {
  localStorage.clear();
  offlineFetch.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('sign-out while offline', () => {
  it('queues the revocation offline and sends it once the phone is back online', async () => {
    expect(await queueLogout(offlineFetch)).toBe('queued');
    expect(offlineFetch).toHaveBeenCalledTimes(1);
    expect(logoutPending()).toBe(true);
    // Survives a reload (localStorage), not just this page.
    expect(localStorage.getItem('maktab.logoutPending')).toBe('1');

    const calls: { url: string; init?: RequestInit }[] = [];
    const online = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    const stop = startLogoutFlush(online);
    await vi.waitFor(() => expect(logoutPending()).toBe(false));
    stop();
    expect(calls).toEqual([
      { url: '/api/auth/logout', init: { method: 'POST', credentials: 'same-origin' } },
    ]);
  });

  it('the online event flushes it; a 5xx keeps it queued', async () => {
    await queueLogout(offlineFetch);
    let status = 503;
    const f = vi.fn(async () => new Response(null, { status }));
    const stop = startLogoutFlush(f);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(logoutPending()).toBe(true);
    status = 401; // the cookie was already gone: done as well
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(logoutPending()).toBe(false));
    stop();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('while queued, /api/me is not asked: the app is signed out even though the cookie is valid', async () => {
    await queueLogout(offlineFetch);
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchMe()).rejects.toMatchObject({ status: 401 });
    // Only the logout retry went out, never /api/me with the old cookie.
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(['/api/auth/logout']);
  });

  it('nothing queued: flush is a no-op', async () => {
    expect(await flushLogout(offlineFetch)).toBe('done');
    expect(offlineFetch).not.toHaveBeenCalled();
  });
});

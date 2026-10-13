import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMe } from '@/lib/api';
import {
  flushLogout,
  LOGOUT_COOKIE,
  logoutPending,
  queueLogout,
  signedOutLocally,
  startLogoutFlush,
} from '@/offline/logout';

// Sign-out while offline (M7, carried from M2; bound to one session in M7a): the server-side
// revocation is queued with the old session's logout token and sent on reconnect; until then the
// phone counts as signed out; the token also rides in a cookie the OAuth callback honours.

const offlineFetch = vi.fn(async () => {
  throw new TypeError('Failed to fetch');
});
const clearCookie = () => {
  // biome-ignore lint/suspicious/noDocumentCookie: test reset
  document.cookie = `${LOGOUT_COOKIE}=; Path=/; Max-Age=0`;
};
const cookieValue = () =>
  document.cookie
    .split(/;\s*/)
    .find((c) => c.startsWith(`${LOGOUT_COOKIE}=`))
    ?.slice(LOGOUT_COOKIE.length + 1);

beforeEach(() => {
  localStorage.clear();
  clearCookie();
  offlineFetch.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('sign-out while offline', () => {
  it('queues the token offline (storage + cookie) and sends it once the phone is back online', async () => {
    expect(await queueLogout('tok-old', offlineFetch)).toBe('offline');
    expect(offlineFetch).toHaveBeenCalledTimes(1);
    expect(logoutPending()).toBe(true);
    // Survives a reload (localStorage), and the OAuth callback can see it (cookie).
    expect(localStorage.getItem('maktab.logoutPending')).toBe('tok-old');
    expect(cookieValue()).toBe('tok-old');

    const calls: { url: string; init?: RequestInit }[] = [];
    const online = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    });
    const stop = startLogoutFlush(online);
    await vi.waitFor(() => expect(logoutPending()).toBe(false));
    stop();
    expect(calls).toEqual([
      {
        url: '/api/auth/logout',
        init: {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ logout_token: 'tok-old' }),
        },
      },
    ]);
    expect(cookieValue()).toBeUndefined();
  });

  it('the online event flushes it; 5xx and 429 keep it queued', async () => {
    await queueLogout('tok', offlineFetch);
    let status = 503;
    const f = vi.fn(async () => new Response(null, { status }));
    const stop = startLogoutFlush(f);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    expect(logoutPending()).toBe(true);
    status = 429;
    expect(await flushLogout(f)).toBe('queued');
    expect(logoutPending()).toBe(true);
    status = 200;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(logoutPending()).toBe(false));
    stop();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('while queued, /api/me is not asked: the app is signed out even though the cookie is valid', async () => {
    await queueLogout('tok', offlineFetch);
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new TypeError('offline');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchMe()).rejects.toMatchObject({ status: 401 });
    // Only the logout retry went out, never /api/me with the old cookie.
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(['/api/auth/logout']);
  });

  it('a sign-in that consumed the cookie (callback revoked it) is not blocked by a failing flush', async () => {
    await queueLogout('tok', offlineFetch);
    clearCookie(); // what the OAuth callback does after revoking the old session
    expect(signedOutLocally()).toBe(false);
    expect(logoutPending()).toBe(false);
  });

  it('a pre-M7a flag ("1") names no session and is dropped, never sent', async () => {
    localStorage.setItem('maktab.logoutPending', '1');
    expect(logoutPending()).toBe(false);
    expect(await flushLogout(offlineFetch)).toBe('done');
    expect(offlineFetch).not.toHaveBeenCalled();
  });

  it('nothing queued: flush is a no-op', async () => {
    expect(await flushLogout(offlineFetch)).toBe('done');
    expect(offlineFetch).not.toHaveBeenCalled();
  });
});

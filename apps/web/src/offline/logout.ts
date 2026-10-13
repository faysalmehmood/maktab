/**
 * Sign-out that works offline (M7; carried from M2, bound to one session in M7a). Local state goes
 * at once (the caller clears the query cache and the offline API copy); the server-side revocation
 * is a tiny queue of one: the old session's *logout token* (from /api/me) in localStorage, flushed
 * with `POST /api/auth/logout {logout_token}` now, on every `online` event and at start-up. The
 * token names that session only, so a late flush can never end a newer session on this phone.
 *
 * The same token also goes into the `maktab_logout_pending` cookie: the OAuth callback revokes it
 * before the new session starts and deletes the cookie. Until the old session is gone (flushed, or
 * the cookie consumed by a sign-in) the app treats the phone as signed out (fetchMe answers 401
 * without asking the server, whose old cookie is still valid). Sign-in itself never starts while
 * the phone is offline with a revocation waiting (Login.tsx).
 */
const KEY = 'maktab.logoutPending';
export const LOGOUT_COOKIE = 'maktab_logout_pending';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** done = revoked (or nothing waiting); queued = the server answered 5xx / 429; offline = no answer. */
export type FlushResult = 'done' | 'queued' | 'offline';

let pendingInMemory: string | null = null;

/** The queued logout token, or null. A pre-M7a flag ('1') names no session and is dropped. */
function pendingToken(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    if (v === '1') {
      localStorage.removeItem(KEY);
      return null;
    }
    return v;
  } catch {
    return pendingInMemory;
  }
}

function cookieHas(): boolean {
  try {
    return document.cookie.split(/;\s*/).some((c) => c.startsWith(`${LOGOUT_COOKIE}=`));
  } catch {
    return false;
  }
}

function setPending(token: string | null): void {
  pendingInMemory = token;
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the in-memory copy still covers this tab.
  }
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing on older Android WebViews
    document.cookie = token
      ? `${LOGOUT_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`
      : `${LOGOUT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  } catch {
    // No cookies: the localStorage flush still revokes it.
  }
}

/** A revocation is still waiting to be sent. */
export function logoutPending(): boolean {
  return pendingToken() !== null;
}

/**
 * The phone must count as signed out: a revocation waits and no sign-in has consumed it yet (the
 * OAuth callback deletes the cookie once it has revoked the old session).
 */
export function signedOutLocally(): boolean {
  if (!logoutPending()) return false;
  if (cookieHas()) return true;
  // The callback already revoked it; the stored copy is a harmless repeat — drop it.
  setPending(null);
  return false;
}

let inflight: Promise<FlushResult> | null = null;

/** Sends the queued revocation. */
export function flushLogout(fetchImpl: FetchLike = (i, o) => fetch(i, o)): Promise<FlushResult> {
  const token = pendingToken();
  if (!token) return Promise.resolve('done');
  inflight ??= (async () => {
    try {
      const res = await fetchImpl('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ logout_token: token }),
      });
      // 429 / 5xx: try again later. Anything else: the server has dealt with this token (revoked,
      // already gone, or a token it will never accept — retrying would not change that).
      if (res.status === 429 || res.status >= 500) return 'queued' as const;
      if (pendingToken() === token) setPending(null);
      return 'done' as const;
    } catch {
      return 'offline' as const;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Queues the revocation of the session `token` names and tries it straight away. Without a token
 * (an /api/me answer from before M7a) it falls back to a plain cookie sign-out, online only.
 */
export function queueLogout(
  token: string | null | undefined,
  fetchImpl: FetchLike = (i, o) => fetch(i, o),
): Promise<FlushResult> {
  if (!token)
    return fetchImpl('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(
      () => 'done' as const,
      () => 'offline' as const,
    );
  setPending(token);
  return flushLogout(fetchImpl);
}

let listening = false;
/** Flushes at start-up and whenever the phone comes back online (main.tsx). */
export function startLogoutFlush(fetchImpl?: FetchLike): () => void {
  if (listening || typeof window === 'undefined') return () => undefined;
  listening = true;
  const onOnline = () => void flushLogout(fetchImpl);
  window.addEventListener('online', onOnline);
  void flushLogout(fetchImpl);
  return () => {
    listening = false;
    window.removeEventListener('online', onOnline);
  };
}

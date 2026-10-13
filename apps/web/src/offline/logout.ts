/**
 * Sign-out that works offline (M7; carried from M2). Local state goes at once (the caller clears the
 * query cache and the offline API copy); the server-side session revocation is a tiny queue of one:
 * a flag in localStorage that is flushed with `POST /api/auth/logout` now, on every `online` event
 * and at start-up. Until it is flushed the app treats the phone as signed out (fetchMe answers 401
 * without asking the server, whose cookie is still valid), and a new sign-in flushes it first so the
 * late revocation can never end the *new* session.
 */
const KEY = 'maktab.logoutPending';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function logoutPending(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return pendingInMemory;
  }
}

let pendingInMemory = false;
function setPending(on: boolean): void {
  pendingInMemory = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the in-memory flag still covers this tab.
  }
}

let inflight: Promise<'done' | 'queued'> | null = null;

/** Sends the queued revocation; 'queued' = still waiting (offline, or the server answered 5xx). */
export function flushLogout(
  fetchImpl: FetchLike = (i, o) => fetch(i, o),
): Promise<'done' | 'queued'> {
  if (!logoutPending()) return Promise.resolve('done');
  inflight ??= (async () => {
    try {
      const res = await fetchImpl('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      });
      // Any answer below 500 means the server has dealt with this cookie (ended, or never valid).
      if (res.status < 500) {
        setPending(false);
        return 'done' as const;
      }
      return 'queued' as const;
    } catch {
      return 'queued' as const;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Queues the revocation and tries it straight away. */
export function queueLogout(fetchImpl?: FetchLike): Promise<'done' | 'queued'> {
  setPending(true);
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

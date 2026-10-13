import { type MeResponse, STAFF_ROLES, USER_STATUSES } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { API_CACHE } from '@/offline/api-cache';
import { setCurrentUser } from '@/offline/current-user';
import { flushLogout, signedOutLocally } from '@/offline/logout';

const LAST_USER = 'maktab.lastUserId';

/**
 * A different account on this phone than last time (M7a): the offline API copy (who I am,
 * rosters, a family's dues) belongs to the previous account and goes; the outbox keeps the other
 * account's registers but sends only this user's.
 */
async function noteUser(userId: string): Promise<void> {
  setCurrentUser(userId);
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_USER);
    localStorage.setItem(LAST_USER, userId);
  } catch {
    return;
  }
  if (last !== null && last !== userId && typeof caches !== 'undefined')
    await caches.delete(API_CACHE).catch(() => false);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Same-origin JSON fetch; turns `{error:{code,message}}` bodies into ApiError. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const { code, message } = errorOf(body) ?? {
      code: 'http_error',
      message: `HTTP ${res.status}`,
    };
    throw new ApiError(res.status, code, message);
  }
  return body;
}

export async function fetchMe(): Promise<MeResponse> {
  // Signed out while offline and the revocation not sent yet (nor consumed by a new sign-in):
  // signed out, whatever the old cookie says.
  if (signedOutLocally() && (await flushLogout()) !== 'done')
    throw new ApiError(401, 'unauthenticated', 'Signed out');
  const me = parseMe(await apiFetch('/api/me'));
  await noteUser(me.user.id);
  return me;
}

// Hand-written guards instead of the zod schemas in @maktab/shared: the shell is the only web code
// that validated responses, and zod alone was ~55 KB gzip of the first load (M7 bundle work).
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStr = (v: unknown): v is string => typeof v === 'string';

/** `{error:{code,message}}` → its error, or null for any other shape. */
export function errorOf(body: unknown): { code: string; message: string } | null {
  const e = isObj(body) ? body.error : null;
  return isObj(e) && isStr(e.code) && isStr(e.message)
    ? { code: e.code, message: e.message }
    : null;
}

/** Same contract as meResponseSchema (user + staff roles); throws on anything else. */
export function parseMe(body: unknown): MeResponse {
  const u = isObj(body) ? body.user : null;
  const roles = isObj(body) ? body.roles : null;
  const ok =
    isObj(u) &&
    isStr(u.id) &&
    isStr(u.email) &&
    u.email.includes('@') &&
    isStr(u.name) &&
    (USER_STATUSES as readonly unknown[]).includes(u.status) &&
    Array.isArray(roles) &&
    roles.every((r) => (STAFF_ROLES as readonly unknown[]).includes(r));
  if (!ok) throw new ApiError(500, 'bad_response', 'Unexpected /api/me response');
  const token = isObj(body) && isStr(body.logout_token) ? body.logout_token : undefined;
  return {
    user: { id: u.id, email: u.email, name: u.name, status: u.status },
    roles,
    ...(token ? { logout_token: token } : {}),
  } as MeResponse;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    // 401 is an answer, not a transient failure. Offline, fail at once (the error screen shows
    // what is waiting on the phone) instead of a retry paused until the connection returns.
    retry: (count, err) =>
      !(err instanceof ApiError && err.status === 401) &&
      !(typeof navigator !== 'undefined' && navigator.onLine === false) &&
      count < 2,
  });
}

/** Typed GET; the shapes are the hand-written contract in @maktab/shared (dto.ts). */
export const getJson = <T>(path: string): Promise<T> => apiFetch(path) as Promise<T>;

export const sendJson = <T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> =>
  apiFetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as Promise<T>;

/** Multipart upload in field `file` (photos, logo, CSV). */
export function uploadFile<T>(path: string, file: Blob, filename = 'upload'): Promise<T> {
  const form = new FormData();
  form.append('file', file, filename);
  return apiFetch(path, { method: 'POST', body: form }) as Promise<T>;
}

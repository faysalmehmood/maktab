import { type MeResponse, STAFF_ROLES, USER_STATUSES } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';

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

export const fetchMe = async (): Promise<MeResponse> => parseMe(await apiFetch('/api/me'));

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
  return {
    user: { id: u.id, email: u.email, name: u.name, status: u.status },
    roles,
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

export const logout = () => apiFetch('/api/auth/logout', { method: 'POST' });

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

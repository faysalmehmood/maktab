import { apiErrorSchema, type MeResponse, meResponseSchema } from '@maktab/shared';
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
    const parsed = apiErrorSchema.safeParse(body);
    const { code, message } = parsed.success
      ? parsed.data.error
      : { code: 'http_error', message: `HTTP ${res.status}` };
    throw new ApiError(res.status, code, message);
  }
  return body;
}

export const fetchMe = async (): Promise<MeResponse> =>
  meResponseSchema.parse(await apiFetch('/api/me'));

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    // 401 is an answer, not a transient failure.
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
  });
}

export const logout = () => apiFetch('/api/auth/logout', { method: 'POST' });

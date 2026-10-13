import type { Bindings } from '../env';

/**
 * Cloudflare Turnstile (PLAN §10, M7), optional: on only when both TURNSTILE_SITE_KEY (a var, public)
 * and TURNSTILE_SECRET (a secret) are set — otherwise every caller behaves exactly as before. Used
 * on the parent gate (`POST /api/p/gate`) and as a pre-check page in front of Google sign-in. The
 * real flood control is the Cloudflare rate-limiting rules (docs/deploy.md); this stops scripted
 * guessing that stays under them.
 */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

export const turnstileSiteKey = (env: Bindings): string | null =>
  env.TURNSTILE_SITE_KEY?.trim() && env.TURNSTILE_SECRET?.trim()
    ? env.TURNSTILE_SITE_KEY.trim()
    : null;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** true = a human (or Turnstile is off). A network error or a malformed answer is a failure. */
export async function verifyTurnstile(
  env: Bindings,
  fetchFn: Fetch,
  token: string | undefined | null,
  ip: string | undefined,
): Promise<boolean> {
  if (!turnstileSiteKey(env)) return true;
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET ?? '');
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetchFn(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
    if (!res.ok) return false;
    const body = (await res.json()) as { success?: unknown };
    return body.success === true;
  } catch {
    return false;
  }
}

export const clientIp = (h: (name: string) => string | undefined): string | undefined =>
  h('cf-connecting-ip') ?? h('x-forwarded-for')?.split(',')[0]?.trim();

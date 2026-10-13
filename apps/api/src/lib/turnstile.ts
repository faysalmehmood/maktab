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

/**
 * What to do when siteverify cannot answer (network error, timeout, 5xx):
 *   'open'   sign-in: Google is the real authentication and the sign-in rate limits still apply, so a
 *            Turnstile outage must not lock staff out;
 *   'closed' the parent gate: the atomic 5-attempt lockout in D1 is the real limiter, and a parent
 *            only has to try again.
 * An explicit `success: false`, a token for another hostname, or a missing token is a failure under
 * both policies.
 */
export type TurnstilePolicy = 'open' | 'closed';

/** Local testing keys answer with hostname "example.com": only checked off localhost. */
const isLocalOrigin = (origin: string): boolean =>
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin.replace(/\/$/, ''));

/** true = a human (or Turnstile is off). */
export async function verifyTurnstile(
  env: Bindings,
  fetchFn: Fetch,
  token: string | undefined | null,
  ip: string | undefined,
  policy: TurnstilePolicy,
): Promise<boolean> {
  if (!turnstileSiteKey(env)) return true;
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET ?? '');
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  let body: { success?: unknown; hostname?: unknown };
  try {
    const res = await fetchFn(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
    if (res.status >= 500) return policy === 'open';
    if (!res.ok) return false;
    body = (await res.json()) as typeof body;
  } catch {
    // Unreachable, or an unreadable answer.
    return policy === 'open';
  }
  if (body.success !== true) return false;
  if (isLocalOrigin(env.APP_ORIGIN)) return true;
  let host: string;
  try {
    host = new URL(env.APP_ORIGIN).hostname;
  } catch {
    return false;
  }
  return typeof body.hostname === 'string' && body.hostname.toLowerCase() === host.toLowerCase();
}

export const clientIp = (h: (name: string) => string | undefined): string | undefined =>
  h('cf-connecting-ip') ?? h('x-forwarded-for')?.split(',')[0]?.trim();

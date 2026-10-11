import type { Bindings } from '../env';

/**
 * One-line warning for missing settings, so a fresh clone fails visibly at `wrangler dev` start
 * instead of at the first sign-in. Google OAuth is checked in dev only (in production
 * /api/auth/google/start reports `misconfigured`); PARENT_LINK_SECRET everywhere, since without it
 * no parent link can be made or opened (those routes answer 503 `misconfigured`).
 */
export function configWarning(env: Partial<Bindings>): string | null {
  const out: string[] = [];
  if (env.APP_ORIGIN?.startsWith('http://')) {
    const missing = (['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const).filter(
      (k) => !env[k]?.trim(),
    );
    if (missing.length)
      out.push(
        `[maktab] ${missing.join(' and ')} empty in apps/api/.dev.vars: Google sign-in will not work`,
      );
  }
  if ((env.PARENT_LINK_SECRET?.trim().length ?? 0) < 32)
    out.push(
      '[maktab] PARENT_LINK_SECRET missing or shorter than 32 characters: parent links will not work (wrangler secret put PARENT_LINK_SECRET)',
    );
  return out.length ? out.join('\n') : null;
}

import type { Bindings } from '../env';

/**
 * One-line dev warning for missing Google OAuth settings, so a fresh clone fails visibly at
 * `wrangler dev` start instead of at the first sign-in. Silent in production (https origin), where
 * /api/auth/google/start reports `misconfigured` instead.
 */
export function configWarning(env: Partial<Bindings>): string | null {
  if (!env.APP_ORIGIN?.startsWith('http://')) return null;
  const missing = (['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const).filter(
    (k) => !env[k]?.trim(),
  );
  return missing.length
    ? `[maktab] ${missing.join(' and ')} empty in apps/api/.dev.vars: Google sign-in will not work`
    : null;
}

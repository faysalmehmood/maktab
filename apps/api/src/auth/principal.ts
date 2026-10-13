import { role, user, userSession } from '@maktab/db';
import type { PrincipalRole, StaffRole, User } from '@maktab/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../env';
import { verifySession } from './signed';

export type Principal = {
  kind: 'staff';
  user: User;
  roles: StaffRole[];
  /** The session this request came with (and its expiry, epoch seconds). */
  session: { id: string; exp: number };
};

/** Roles the permission matrix evaluates; parents will get their own principal kind with magic links. */
export const principalRoles = (p: Principal): PrincipalRole[] => p.roles;

export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

/** `__Host-` pins the cookie to this exact origin over HTTPS; plain http://localhost cannot use it. */
export const sessionCookieName = (appOrigin: string): string =>
  appOrigin.startsWith('https://') ? '__Host-maktab_sid' : 'maktab_sid';

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Looks the caller up once per request; a revoked session or disabled user is anonymous. */
export async function loadPrincipal(c: Context<AppEnv>): Promise<Principal | null> {
  const cached = c.get('principal');
  if (cached !== undefined) return cached;
  const token = getCookie(c, sessionCookieName(c.env.APP_ORIGIN));
  const claims = token ? await verifySession(c.env.SESSION_SECRET, token, nowSec()) : null;
  let principal: Principal | null = null;
  if (claims) {
    const db = c.get('db');
    const [row] = await db
      .select({ id: user.id, email: user.email, name: user.name, status: user.status })
      .from(userSession)
      .innerJoin(user, eq(user.id, userSession.userId))
      .where(
        and(
          eq(userSession.id, claims.sid),
          gt(userSession.expiresAt, new Date().toISOString()),
          eq(user.status, 'active'),
        ),
      );
    if (row) {
      const roles = await db.select({ role: role.role }).from(role).where(eq(role.userId, row.id));
      principal = {
        kind: 'staff',
        user: row,
        roles: roles.map((r) => r.role),
        session: { id: claims.sid, exp: claims.exp },
      };
    }
  }
  c.set('principal', principal);
  return principal;
}

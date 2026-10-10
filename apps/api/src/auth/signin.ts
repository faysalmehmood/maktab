import { type AppDb, atomic, rawStatement, user, userSession } from '@maktab/db';
import { newId } from '@maktab/shared';
import { eq, sql } from 'drizzle-orm';
import { ApiError } from '../lib/errors';
import type { GoogleClaims } from './google';
import { SESSION_TTL_SEC } from './principal';

type UserRow = typeof user.$inferSelect;

/**
 * Invite-only sign-in. The very first sign-in on an empty installation becomes the owner; both
 * statements run atomically and the NOT EXISTS guard means two simultaneous first sign-ins cannot
 * both become owner.
 */
export async function resolveGoogleUser(db: AppDb, claims: GoogleClaims): Promise<UserRow> {
  const email = claims.email.toLowerCase();
  const name = claims.name ?? '';
  const find = async () => (await db.select().from(user).where(eq(user.email, email)))[0];

  let found = await find();
  if (!found) {
    const id = newId();
    await atomic(db, () => [
      rawStatement(
        db,
        sql`INSERT INTO "user" (id, email, name, google_sub, status)
            SELECT ${id}, ${email}, ${name}, ${claims.sub}, 'active'
            WHERE NOT EXISTS (SELECT 1 FROM "user")`,
      ),
      rawStatement(
        db,
        sql`INSERT INTO role (user_id, role) SELECT id, 'owner' FROM "user" WHERE id = ${id}`,
      ),
    ]);
    found = await find();
  }
  if (!found) throw new ApiError(403, 'not_invited', 'This Google account has not been invited');
  if (found.status === 'disabled') throw new ApiError(403, 'disabled', 'This account is disabled');
  // An email can be re-assigned at Google; the stable `sub` must keep matching once linked.
  if (found.googleSub && found.googleSub !== claims.sub) {
    throw new ApiError(
      403,
      'account_mismatch',
      'This email is linked to a different Google account',
    );
  }
  if (found.status === 'invited' || !found.googleSub) {
    await db
      .update(user)
      .set({ status: 'active', googleSub: claims.sub, name: found.name || name })
      .where(eq(user.id, found.id));
    found = { ...found, status: 'active', googleSub: claims.sub, name: found.name || name };
  }
  return found;
}

export async function createSession(
  db: AppDb,
  userId: string,
  meta: { ua: string | null; ip: string | null; nowMs: number },
): Promise<{ id: string; exp: number }> {
  const id = newId();
  const exp = Math.floor(meta.nowMs / 1000) + SESSION_TTL_SEC;
  await db.insert(userSession).values({
    id,
    userId,
    expiresAt: new Date(exp * 1000).toISOString(),
    ua: meta.ua?.slice(0, 300) ?? null,
    ip: meta.ip,
    createdBy: userId,
  });
  return { id, exp };
}

export async function endSession(db: AppDb, sessionId: string): Promise<void> {
  await db.delete(userSession).where(eq(userSession.id, sessionId));
}

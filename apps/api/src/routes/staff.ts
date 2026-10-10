import { type AppDb, role, staff, user } from '@maktab/db';
import {
  newId,
  rolesInputSchema,
  type StaffRole,
  type StaffRowDto,
  staffInputSchema,
  staffInviteSchema,
  staffPatchSchema,
} from '@maktab/shared';
import { asc, eq, type SQL, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { idParam, jsonBody, notFoundError, todayPk, userId } from '../lib/http';
import { auditSql, changed, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';

/**
 * Staff list = staff profiles (teachers may have no login) ∪ users without a profile (e.g. the
 * bootstrap owner). Small by nature (5–30 people), so it is assembled in memory.
 */
async function staffRows(db: AppDb): Promise<StaffRowDto[]> {
  const [profiles, users, roles] = await Promise.all([
    db.select().from(staff).orderBy(asc(staff.name)),
    db.select().from(user).orderBy(asc(user.email)),
    db.select().from(role),
  ]);
  const rolesOf = (uid: string | null): StaffRole[] =>
    uid ? roles.filter((r) => r.userId === uid).map((r) => r.role) : [];
  const userById = new Map(users.map((u) => [u.id, u]));
  const linked = new Set(profiles.map((p) => p.userId).filter(Boolean));
  const rows: StaffRowDto[] = profiles.map((p) => {
    const u = p.userId ? userById.get(p.userId) : undefined;
    return {
      staff_id: p.id,
      user_id: p.userId,
      name: p.name,
      email: u?.email ?? null,
      phone: p.phone,
      title: p.role,
      staff_status: p.status,
      user_status: u?.status ?? null,
      roles: rolesOf(p.userId),
    };
  });
  for (const u of users) {
    if (linked.has(u.id)) continue;
    rows.push({
      staff_id: null,
      user_id: u.id,
      name: u.name || u.email,
      email: u.email,
      phone: null,
      title: null,
      staff_status: null,
      user_status: u.status,
      roles: rolesOf(u.id),
    });
  }
  return rows;
}

async function rowFor(db: AppDb, by: { staffId?: string; userId?: string }): Promise<StaffRowDto> {
  const row = (await staffRows(db)).find((r) =>
    by.staffId ? r.staff_id === by.staffId : r.user_id === by.userId,
  );
  if (!row) throw notFoundError('Staff member');
  return row;
}

export function staffRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const manage = requires('settings', 'manage');
  // Who can sign in, and with which role, is owner-only (PLAN §5.4 "roles: owner").
  const roles = requires('role', 'manage');

  defineRoute(app, table, { method: 'GET', path: '/api/staff', access: manage }, async (c) =>
    c.json({ items: await staffRows(c.get('db')) }),
  );

  defineRoute(app, table, { method: 'POST', path: '/api/staff', access: manage }, async (c) => {
    const input = await jsonBody(c, staffInputSchema);
    const db = c.get('db');
    const id = input.id ?? newId();
    if (input.user_id) {
      const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, input.user_id));
      if (!u) throw new ApiError(400, 'invalid', 'Unknown user');
    }
    const values = {
      userId: input.user_id ?? null,
      name: input.name,
      phone: input.phone ?? null,
      role: input.title ?? null,
      joined: input.joined ?? null,
      status: input.status ?? 'active',
    };
    await tx(db, [
      db.insert(staff).values({ id, ...values, createdBy: userId(c) }),
      auditSql({
        id: newId(),
        userId: userId(c),
        entity: 'staff',
        entityId: id,
        action: 'create',
        after: values,
      }),
    ]);
    return c.json(await rowFor(db, { staffId: id }), 201);
  });

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/staff/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, staffPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(staff).where(eq(staff.id, id));
      if (!before) throw notFoundError('Staff member');
      const values = {
        name: input.name,
        phone: input.phone,
        role: input.title,
        joined: input.joined,
        status: input.status,
      };
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(staff).set(values).where(eq(staff.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'staff',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      return c.json(await rowFor(db, { staffId: id }));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/staff/invite', access: roles },
    async (c) => {
      const input = await jsonBody(c, staffInviteSchema);
      const db = c.get('db');
      const uid = userId(c);
      const [dupe] = await db.select({ id: user.id }).from(user).where(eq(user.email, input.email));
      if (dupe) throw new ApiError(409, 'email_taken', 'This email is already invited');
      const newUserId = newId();
      const staffId = newId();
      const name = input.name ?? '';
      // The invited person signs in with this Google address; resolveGoogleUser activates them.
      const items: SQL[] = [
        sql`INSERT INTO "user" (id, email, name, status, created_by)
            VALUES (${newUserId}, ${input.email}, ${name}, 'invited', ${uid})`,
        sql`INSERT INTO role (user_id, role, created_by) VALUES (${newUserId}, ${input.role}, ${uid})`,
      ];
      if (input.with_profile) {
        items.push(sql`INSERT INTO staff (id, user_id, name, phone, role, joined, created_by)
                       VALUES (${staffId}, ${newUserId}, ${name || (input.email.split('@')[0] ?? input.email)},
                               ${input.phone ?? null}, ${input.title ?? null}, ${todayPk()}, ${uid})`);
      }
      await tx(db, [
        ...items,
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'user',
          entityId: newUserId,
          action: 'invite',
          after: {
            email: input.email,
            role: input.role,
            staff_id: input.with_profile ? staffId : null,
          },
        }),
      ]);
      return c.json(await rowFor(db, { userId: newUserId }), 201);
    },
  );

  for (const action of ['disable', 'enable'] as const) {
    defineRoute(
      app,
      table,
      { method: 'POST', path: `/api/users/:id/${action}`, access: roles },
      async (c) => {
        const db = c.get('db');
        const id = idParam(c);
        const [target] = await db.select().from(user).where(eq(user.id, id));
        if (!target) throw notFoundError('User');
        if (action === 'disable' && id === userId(c)) {
          throw new ApiError(409, 'cannot_disable_self', 'You cannot disable your own account');
        }
        // Re-enabled people who never signed in go back to "invited", not "active".
        const next = action === 'disable' ? 'disabled' : target.googleSub ? 'active' : 'invited';
        if (next !== target.status) {
          await tx(db, [
            // The user_keep_owner trigger refuses disabling the last active owner (409 last_owner).
            sql`UPDATE "user" SET status = ${next} WHERE id = ${id}`,
            // Disabling ends every session at once instead of at cookie expiry.
            ...(action === 'disable' ? [sql`DELETE FROM user_session WHERE user_id = ${id}`] : []),
            auditSql({
              id: newId(),
              userId: userId(c),
              entity: 'user',
              entityId: id,
              action,
              before: { status: target.status },
              after: { status: next },
            }),
          ]);
        }
        return c.json(await rowFor(db, { userId: id }));
      },
    );
  }

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/users/:id/roles', access: roles },
    async (c) => {
      const input = await jsonBody(c, rolesInputSchema);
      const db = c.get('db');
      const uid = userId(c);
      const id = idParam(c);
      const [target] = await db.select({ id: user.id }).from(user).where(eq(user.id, id));
      if (!target) throw notFoundError('User');
      const have = (await db.select().from(role).where(eq(role.userId, id))).map((r) => r.role);
      const want = input.roles;
      if (id === uid && have.includes('owner') && !want.includes('owner')) {
        throw new ApiError(
          409,
          'cannot_remove_self_owner',
          'You cannot remove your own owner role',
        );
      }
      const removed = have.filter((r) => !want.includes(r));
      const added = want.filter((r) => !have.includes(r));
      if (removed.length || added.length) {
        await tx(db, [
          // Only the difference: deleting and re-adding an unchanged owner row would trip the
          // role_keep_owner trigger for a sole owner.
          ...removed.map((r) => sql`DELETE FROM role WHERE user_id = ${id} AND role = ${r}`),
          ...added.map(
            (r) =>
              sql`INSERT OR IGNORE INTO role (user_id, role, created_by) VALUES (${id}, ${r}, ${uid})`,
          ),
          auditSql({
            id: newId(),
            userId: uid,
            entity: 'user',
            entityId: id,
            action: 'roles',
            before: { roles: have },
            after: { roles: want },
          }),
        ]);
      }
      return c.json(await rowFor(db, { userId: id }));
    },
  );
}

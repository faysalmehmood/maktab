import { STAFF_ROLES, USER_STATUSES } from '@maktab/shared';
import {
  type AnySQLiteColumn,
  check,
  index,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { id, oneOf, stamps } from './common';

/** Emails are stored lower-cased; the allowlist lookup depends on it. */
export const user = sqliteTable(
  'user',
  {
    id: id(),
    email: text('email').notNull().unique(),
    name: text('name').notNull().default(''),
    googleSub: text('google_sub').unique(),
    status: text('status', { enum: USER_STATUSES }).notNull().default('invited'),
    createdAt: stamps().createdAt,
    createdBy: text('created_by').references((): AnySQLiteColumn => user.id),
  },
  () => [check('user_status', oneOf('status', USER_STATUSES))],
);

export const role = sqliteTable(
  'role',
  {
    // Explicit RESTRICT: users are disabled, never deleted (audit and created_by point at them).
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    role: text('role', { enum: STAFF_ROLES }).notNull(),
    ...stamps(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    check('role_role', oneOf('role', STAFF_ROLES)),
  ],
);

/** PLAN §5.4 calls this `session`; renamed because the academic year already owns that name. */
export const userSession = sqliteTable(
  'user_session',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    expiresAt: text('expires_at').notNull(),
    ua: text('ua'),
    ip: text('ip'),
    ...stamps(),
  },
  (t) => [index('user_session_user').on(t.userId)],
);

// No zod here: the web shell needs these constants on first load, and a schema next to them would
// pull zod into the first chunk (M7 bundle work). The schemas live in user.ts.

/** Roles a signed-in staff user can hold (rows in the `role` table). */
export const STAFF_ROLES = ['owner', 'admin', 'accountant', 'teacher'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Every principal the permission matrix knows; parents arrive via magic link, never a session. */
export const PRINCIPAL_ROLES = [...STAFF_ROLES, 'parent'] as const;
export type PrincipalRole = (typeof PRINCIPAL_ROLES)[number];

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

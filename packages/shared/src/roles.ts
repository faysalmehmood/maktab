import { z } from 'zod';

/** Roles a signed-in staff user can hold (rows in the `role` table). */
export const STAFF_ROLES = ['owner', 'admin', 'accountant', 'teacher'] as const;
export const staffRoleSchema = z.enum(STAFF_ROLES);
export type StaffRole = z.infer<typeof staffRoleSchema>;

/** Every principal the permission matrix knows; parents arrive via magic link, never a session. */
export const PRINCIPAL_ROLES = [...STAFF_ROLES, 'parent'] as const;
export const principalRoleSchema = z.enum(PRINCIPAL_ROLES);
export type PrincipalRole = z.infer<typeof principalRoleSchema>;

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

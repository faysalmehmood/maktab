import { z } from 'zod';
import { PRINCIPAL_ROLES, STAFF_ROLES, USER_STATUSES } from './roles';

export const staffRoleSchema = z.enum(STAFF_ROLES);
export const principalRoleSchema = z.enum(PRINCIPAL_ROLES);
export const userStatusSchema = z.enum(USER_STATUSES);

export const idSchema = z.ulid();

export const userSchema = z.object({
  id: idSchema,
  email: z.email(),
  name: z.string(),
  status: userStatusSchema,
});
export type User = z.infer<typeof userSchema>;

export const meResponseSchema = z.object({
  user: userSchema,
  roles: z.array(staffRoleSchema),
  /**
   * Revokes this session and nothing else (POST /api/auth/logout `{logout_token}`): kept by the
   * phone at sign-out so a revocation sent later never ends a newer session (M7a).
   */
  logout_token: z.string().optional(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

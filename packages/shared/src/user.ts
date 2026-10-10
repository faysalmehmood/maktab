import { z } from 'zod';
import { staffRoleSchema, userStatusSchema } from './roles';

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
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

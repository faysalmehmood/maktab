import { type Action, hasGrant, MATRIX, type Resource, type StaffRole } from '@maktab/shared';
import { useMe } from './api';

/**
 * UI-side checks derived from the one permission matrix (MATRIX in @maktab/shared), used only to
 * hide what a role cannot do. The API enforces the same matrix regardless.
 */
export const useRoles = (): StaffRole[] => useMe().data?.roles ?? [];

export const canManageSettings = (r: readonly StaffRole[]) => hasGrant(r, 'settings', 'manage');
export const canManageRoles = (r: readonly StaffRole[]) => hasGrant(r, 'role', 'manage');
export const canWriteStudents = (r: readonly StaffRole[]) => hasGrant(r, 'student', 'write');
export const canReadStudents = (r: readonly StaffRole[]) => hasGrant(r, 'student', 'read');
/** Row-scoped readers (teachers without an office role) see "My groups" instead of every group. */
export const isTeacherOnly = (r: readonly StaffRole[]) =>
  r.includes('teacher') && !r.some((role) => MATRIX.student.read[role] === 'all');

/** One (resource, action) of the shared MATRIX, as a tuple the nav and route guards can list. */
export type GrantRef = { [R in Resource]: readonly [R, Action<R>] }[Resource];

/** Does any role hold this grant (any scope)? */
export const holds = (roles: readonly StaffRole[], [resource, action]: GrantRef): boolean =>
  hasGrant(roles, resource, action as Action<typeof resource>);

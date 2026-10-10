import type { StaffRole } from '@maktab/shared';
import { useMe } from './api';

/**
 * UI-side mirror of the permission matrix (apps/api/src/perm/matrix.ts), used only to hide what a
 * role cannot do. The API enforces it regardless.
 */
export const useRoles = (): StaffRole[] => useMe().data?.roles ?? [];

const any = (roles: readonly StaffRole[], allowed: readonly StaffRole[]) =>
  roles.some((r) => allowed.includes(r));

export const canManageSettings = (r: readonly StaffRole[]) => any(r, ['owner', 'admin']);
export const canManageRoles = (r: readonly StaffRole[]) => any(r, ['owner']);
export const canWriteStudents = (r: readonly StaffRole[]) =>
  any(r, ['owner', 'admin', 'accountant']);
export const canReadStudents = (r: readonly StaffRole[]) =>
  any(r, ['owner', 'admin', 'accountant', 'teacher']);
/** Teachers (without an office role) see "My groups" instead of every group. */
export const isTeacherOnly = (r: readonly StaffRole[]) =>
  r.includes('teacher') && !any(r, ['owner', 'admin', 'accountant']);

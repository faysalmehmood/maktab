import type { PrincipalRole } from './roles';

/**
 * Resource -> actions, mirroring the table in PLAN §5.4.
 * Adding a resource or action here forces the matrix in apps/api to cover it (it is `satisfies`-checked).
 */
export const RESOURCES = {
  self: ['read'],
  student: ['read', 'write'],
  attendance: ['mark', 'read'],
  fee: ['generate', 'concession'],
  receipt: ['create', 'reverse'],
  cash_session: ['close_own', 'reopen_any'],
  expense: ['manage'],
  payslip: ['read', 'approve', 'pay'],
  exam: ['marks_entry', 'read'],
  send_queue: ['use'],
  settings: ['manage'],
  role: ['manage'],
  backup: ['manage'],
} as const;

export type Resource = keyof typeof RESOURCES;
export type Action<R extends Resource> = (typeof RESOURCES)[R][number];

/**
 * What a role gets for one (resource, action).
 * A scope string means "allowed, but the data layer must filter rows to this scope".
 */
export type Grant =
  | false
  | 'all'
  | 'own_groups'
  | 'own_subjects'
  | 'own_children'
  | 'own_only'
  | 'all_except_owner';

export type RoleGrants = Record<PrincipalRole, Grant>;

export type PermissionMatrix = {
  [R in Resource]: { [A in Action<R>]: RoleGrants };
};

export type Permission = {
  [R in Resource]: { resource: R; action: Action<R> };
}[Resource];

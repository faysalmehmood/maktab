import type { PrincipalRole } from './roles';

/**
 * Resource -> actions, mirroring the table in PLAN §5.4.
 * Adding a resource or action here forces the matrix in apps/api to cover it (it is `satisfies`-checked).
 */
export const RESOURCES = {
  self: ['read'],
  /** School profile, sessions, programmes, subjects, custom fields: reference data every staff
   *  screen needs (labels, pickers). Writing it is settings.manage. */
  catalog: ['read'],
  student: ['read', 'write'],
  attendance: ['mark', 'correct', 'read'],
  fee: ['generate', 'concession'],
  receipt: ['create', 'reverse'],
  cash_session: ['close_own', 'reopen_any'],
  expense: ['create', 'void'],
  payslip: ['read', 'approve', 'pay'],
  exam: ['marks_entry', 'read'],
  send_queue: ['use'],
  settings: ['manage'],
  role: ['manage'],
  backup: ['manage'],
  audit: ['read'],
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

// The whole authorisation policy, reviewable in one screen. Mirrors PLAN §5.4; anything not listed
// is a compile error (the `satisfies` below), and anything not granted is denied. One source of
// truth: the API enforces it (apps/api/src/perm/matrix.ts), the web hides what it would refuse
// (apps/web/src/lib/roles.ts).

const none: RoleGrants = {
  owner: false,
  admin: false,
  accountant: false,
  teacher: false,
  parent: false,
};
const g = (grants: Partial<RoleGrants>): RoleGrants => ({ ...none, ...grants });
const all = 'all' as const;

export const MATRIX = {
  self: {
    read: g({ owner: 'own_only', admin: 'own_only', accountant: 'own_only', teacher: 'own_only' }),
  },
  // Reference data (school profile, sessions, programmes, subjects, custom fields): every staff
  // screen needs it for labels and pickers; changing it is settings.manage.
  catalog: { read: g({ owner: all, admin: all, accountant: all, teacher: all }) },
  student: {
    read: g({
      owner: all,
      admin: all,
      accountant: all,
      teacher: 'own_groups',
      parent: 'own_children',
    }),
    write: g({ owner: all, admin: all, accountant: all }),
  },
  attendance: {
    mark: g({ owner: all, admin: all, teacher: 'own_groups' }),
    // Editing a submitted register (office correction with reason); teachers only mark.
    correct: g({ owner: all, admin: all }),
    read: g({ owner: all, admin: all, teacher: 'own_groups', parent: 'own_children' }),
  },
  fee: {
    generate: g({ owner: all, admin: all }),
    concession: g({ owner: all, admin: all }),
  },
  receipt: {
    create: g({ owner: all, admin: all, accountant: all }),
    reverse: g({ owner: all, admin: all }),
  },
  cash_session: {
    close_own: g({ owner: 'own_only', admin: 'own_only', accountant: 'own_only' }),
    reopen_any: g({ owner: all, admin: all }),
  },
  expense: {
    create: g({ owner: all, admin: all, accountant: all }),
    // Separation of duties (PLAN §5.4): a void needs admin/owner.
    void: g({ owner: all, admin: all }),
  },
  payslip: {
    read: g({ owner: all, admin: all, accountant: 'all_except_owner', teacher: 'own_only' }),
    approve: g({ owner: all, admin: all }),
    pay: g({ owner: all, admin: all, accountant: all }),
  },
  exam: {
    marks_entry: g({ owner: all, admin: all, teacher: 'own_subjects' }),
    read: g({ owner: all, admin: all, teacher: 'own_groups', parent: 'own_children' }),
  },
  send_queue: {
    use: g({ owner: all, admin: all, accountant: all, teacher: 'own_groups' }),
  },
  settings: { manage: g({ owner: all, admin: all }) },
  role: { manage: g({ owner: all }) },
  backup: { manage: g({ owner: all }) },
  audit: { read: g({ owner: all }) },
} as const satisfies PermissionMatrix;

/** Does any of `roles` get (resource, action) at all (any scope)? For hiding UI the API would refuse. */
export function hasGrant<R extends Resource>(
  roles: readonly PrincipalRole[],
  resource: R,
  action: Action<R>,
): boolean {
  const byAction: Record<string, RoleGrants> = MATRIX[resource];
  return roles.some((role) => (byAction[action]?.[role] ?? false) !== false);
}

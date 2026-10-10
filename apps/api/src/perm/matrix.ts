import type {
  Action,
  Grant,
  Permission,
  PermissionMatrix,
  PrincipalRole,
  Resource,
  RoleGrants,
} from '@maktab/shared';

// The whole authorisation policy, reviewable in one screen. Mirrors PLAN §5.4; anything not listed
// is a compile error (the `satisfies` below), and anything not granted is denied.

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
    manage: g({ owner: all, admin: all, accountant: all }),
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
} as const satisfies PermissionMatrix;

/** Broadest wins when a user holds several roles (e.g. teacher + accountant). */
const RANK: Record<Exclude<Grant, false>, number> = {
  all: 3,
  all_except_owner: 2,
  own_groups: 1,
  own_subjects: 1,
  own_children: 1,
  own_only: 1,
};

export function grantFor<R extends Resource>(
  resource: R,
  action: Action<R>,
  role: PrincipalRole,
): Grant {
  const byAction: Record<string, RoleGrants> = MATRIX[resource];
  return byAction[action]?.[role] ?? false;
}

export function decide(roles: readonly PrincipalRole[], p: Permission): Grant {
  let best: Grant = false;
  for (const role of roles) {
    const grant = grantFor(p.resource, p.action, role);
    if (grant !== false && (best === false || RANK[grant] > RANK[best])) best = grant;
  }
  return best;
}

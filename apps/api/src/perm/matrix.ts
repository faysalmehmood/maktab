import {
  type Action,
  type Grant,
  MATRIX,
  type Permission,
  type PrincipalRole,
  type Resource,
  type RoleGrants,
} from '@maktab/shared';

// The policy itself lives in @maktab/shared (MATRIX), so the web hides exactly what the API refuses.
export { MATRIX };

/** Broadest wins when a user holds several roles (e.g. teacher + accountant). */
const RANK: Record<Exclude<Grant, false>, number> = {
  all: 3,
  all_except_owner: 2,
  own_groups: 1,
  own_subjects: 1,
  own_children: 1,
  own_only: 1,
  public: 1,
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

import { type AppDb, grp, grpSubject, staff } from '@maktab/db';
import type { Grant } from '@maktab/shared';
import { type Column, eq, inArray, type SQL, sql } from 'drizzle-orm';

export type GroupScope = { kind: 'all' } | { kind: 'groups'; ids: string[] };

/**
 * Row scope for anything hanging off a group (students, attendance, marks, send queue), derived from
 * the grant the permission guard resolved for this route (`c.get('grant')`) — never from roles, so
 * a route's matrix row is the single source of truth (PLAN §5.4). Applied in the data layer so a
 * forgotten UI check cannot leak rows.
 *   all / all_except_owner -> every group (all_except_owner narrows payroll, not groups)
 *   own_groups             -> groups where the user's staff row is class teacher or subject teacher
 *   own_subjects           -> groups where they teach a subject
 *   anything else          -> no groups (parents get child scope via their magic link later)
 */
export async function scopeToGroups(db: AppDb, userId: string, grant: Grant): Promise<GroupScope> {
  if (grant === 'all' || grant === 'all_except_owner') return { kind: 'all' };
  if (grant !== 'own_groups' && grant !== 'own_subjects') return { kind: 'groups', ids: [] };
  const mine = db.select({ id: staff.id }).from(staff).where(eq(staff.userId, userId));
  const asClassTeacher =
    grant === 'own_groups'
      ? await db.select({ id: grp.id }).from(grp).where(inArray(grp.classTeacherId, mine))
      : [];
  const asSubjectTeacher = await db
    .select({ id: grpSubject.grpId })
    .from(grpSubject)
    .where(inArray(grpSubject.teacherId, mine));
  const ids = [...new Set([...asClassTeacher, ...asSubjectTeacher].map((r) => r.id))].sort();
  return { kind: 'groups', ids };
}

/**
 * WHERE fragment for a group-id column; `undefined` means no filter (drizzle drops it).
 * Binds one parameter per group: fine for a teacher's handful, but D1 caps a statement at 100, so
 * bulk paths should pass ids through json_each instead (PLAN §8).
 */
export function groupFilter(column: Column, scope: GroupScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  if (scope.ids.length === 0) return sql`0`;
  return inArray(column, scope.ids);
}

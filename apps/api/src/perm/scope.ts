import { type AppDb, grp, grpSubject, staff } from '@maktab/db';
import { type Column, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Principal } from '../auth/principal';

export type GroupScope = { kind: 'all' } | { kind: 'groups'; ids: string[] };

const SEES_ALL_GROUPS = new Set(['owner', 'admin', 'accountant']);

/**
 * Row scope for anything hanging off a group (students, attendance, marks, send queue).
 * Teachers see groups where they are class teacher or teach a subject (PLAN §5.4). Applied in the
 * data layer so a forgotten UI check cannot leak rows.
 */
export async function scopeToGroups(db: AppDb, principal: Principal): Promise<GroupScope> {
  if (principal.roles.some((r) => SEES_ALL_GROUPS.has(r))) return { kind: 'all' };
  if (!principal.roles.includes('teacher')) return { kind: 'groups', ids: [] };
  const mine = db.select({ id: staff.id }).from(staff).where(eq(staff.userId, principal.user.id));
  const asClassTeacher = await db
    .select({ id: grp.id })
    .from(grp)
    .where(inArray(grp.classTeacherId, mine));
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

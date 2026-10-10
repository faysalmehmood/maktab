import { type AppDb, grp, grpSubject, staff } from '@maktab/db';
import type { Grant } from '@maktab/shared';
import { type Column, eq, inArray, type SQL, sql } from 'drizzle-orm';

export type GroupScope =
  | { kind: 'all' }
  | {
      kind: 'groups';
      ids: string[];
      /**
       * Groups the user reaches only as a subject teacher -> the grp_subject ids they teach there.
       * Absent when there are none. Writes to such a group are limited to those subjects' registers
       * (a subject teacher never takes the class teacher's whole-day register).
       */
      subjectsOnly?: Record<string, string[]>;
    };

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
    .select({ id: grpSubject.grpId, gs: grpSubject.id })
    .from(grpSubject)
    .where(inArray(grpSubject.teacherId, mine));
  const ids = [...new Set([...asClassTeacher, ...asSubjectTeacher].map((r) => r.id))].sort();
  const classIds = new Set(asClassTeacher.map((r) => r.id));
  const subjectsOnly: Record<string, string[]> = {};
  for (const r of asSubjectTeacher) {
    if (classIds.has(r.id)) continue;
    const list = subjectsOnly[r.id] ?? [];
    list.push(r.gs);
    subjectsOnly[r.id] = list;
  }
  for (const list of Object.values(subjectsOnly)) list.sort();
  return Object.keys(subjectsOnly).length
    ? { kind: 'groups', ids, subjectsOnly }
    : { kind: 'groups', ids };
}

/**
 * May this scope write the register (group, subject)? Everyone in `all`; a class teacher any register
 * of their group; a teacher who reaches the group only through a subject, only that subject's.
 */
export function mayWriteRegister(scope: GroupScope, grpId: string, grpSubjectId: string): boolean {
  if (scope.kind === 'all') return true;
  if (!scope.ids.includes(grpId)) return false;
  const only = scope.subjectsOnly?.[grpId];
  return !only || only.includes(grpSubjectId);
}

/**
 * WHERE fragment over a register key (group and subject columns) for what a scope may read in
 * per-register lists: whole groups, plus single subjects of subject-only groups. json_each keeps it
 * to two parameters however many groups.
 */
export function registerFilter(grpCol: SQL, subjectCol: SQL, scope: GroupScope): SQL {
  if (scope.kind === 'all') return sql`1`;
  const only = scope.subjectsOnly ?? {};
  const whole = scope.ids.filter((id) => !only[id]);
  const pairs = Object.entries(only).flatMap(([g, list]) => list.map((gs) => `${g}|${gs}`));
  return sql`(${grpCol} IN (SELECT value FROM json_each(${JSON.stringify(whole)}))
    OR (${grpCol} || '|' || ${subjectCol}) IN (SELECT value FROM json_each(${JSON.stringify(pairs)})))`;
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

/**
 * Students a scope may see: everyone for `all`; otherwise students with an *active* enrolment in
 * one of the scope's groups (a teacher's current classes, not last year's). Ids go through
 * json_each so a long list never hits D1's 100-parameter cap.
 */
export function studentFilter(column: Column | SQL, scope: GroupScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  if (scope.ids.length === 0) return sql`0`;
  return sql`${column} IN (SELECT e.student_id FROM enrolment e WHERE e.status = 'active'
    AND e.grp_id IN (SELECT value FROM json_each(${JSON.stringify(scope.ids)})))`;
}

import { grp, session } from '@maktab/db';
import type {
  TeacherGroupRef,
  TeacherRowDto,
  TeacherSubjectRef,
  TeachersDto,
} from '@maktab/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { notFoundError } from '../lib/http';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { loadGroups } from './groups';
import { staffRows } from './staff';

/**
 * The Teachers page (owner/admin): who is class teacher of which group and who teaches which
 * subject, for one session. Read-only: assignments are written through the group endpoints
 * (PATCH /api/groups/:id, PUT /api/groups/:id/subjects), the same path as the class side.
 * Same grant as those writes and the staff list (settings.manage), so teachers and accountants
 * never see it.
 */
export function teacherRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const manage = requires('settings', 'manage');

  defineRoute(app, table, { method: 'GET', path: '/api/teachers', access: manage }, async (c) => {
    const db = c.get('db');
    const asked = c.req.query('session_id');
    let sessionId: string | null = asked || null;
    if (sessionId) {
      const [known] = await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.id, sessionId));
      if (!known) throw notFoundError('Session');
    } else {
      const [cur] = await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.isCurrent, true));
      sessionId = cur?.id ?? null;
    }
    // loadGroups reads the groups' subjects with json_each (one parameter however many groups).
    // No session at all (an academy that never set one): every live group, as GET /api/groups.
    const [groups, staff] = await Promise.all([
      loadGroups(
        db,
        and(isNull(grp.archivedAt), sessionId ? eq(grp.sessionId, sessionId) : undefined),
      ),
      staffRows(db),
    ]);

    const ref = (g: (typeof groups)[number]): TeacherGroupRef => ({
      grp_id: g.id,
      name: `${g.programme_name} ${g.name}`,
    });
    const classOf = new Map<string, TeacherGroupRef[]>();
    const subjectsOf = new Map<string, TeacherSubjectRef[]>();
    const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
      const list = m.get(k);
      if (list) list.push(v);
      else m.set(k, [v]);
    };
    const warnings: TeachersDto['warnings'] = {
      groups_without_class_teacher: [],
      subjects_without_teacher: [],
      double_class_teachers: [],
    };
    const closed = new Set(groups.filter((g) => g.status === 'closed').map((g) => g.id));
    const primary = new Set(groups.filter((g) => g.is_primary).map((g) => g.id));
    for (const g of groups) {
      const live = !closed.has(g.id);
      if (g.class_teacher_id) push(classOf, g.class_teacher_id, ref(g));
      else if (live) warnings.groups_without_class_teacher.push(ref(g));
      for (const s of g.subjects) {
        const sub: TeacherSubjectRef = {
          grp_id: g.id,
          grp_name: ref(g).name,
          programme_name: g.programme_name,
          group_name: g.name,
          grp_subject_id: s.id,
          subject_name: s.subject_name,
        };
        if (s.teacher_id) push(subjectsOf, s.teacher_id, sub);
        else if (live) warnings.subjects_without_teacher.push(sub);
      }
    }

    const items: TeacherRowDto[] = [];
    for (const p of staff) {
      if (!p.staff_id || !p.staff_status) continue;
      const classes = classOf.get(p.staff_id) ?? [];
      const subjects = subjectsOf.get(p.staff_id) ?? [];
      const assigned = classes.length > 0 || subjects.length > 0;
      // Every active staff profile that may teach: teachers, owners, and profiles with no login
      // yet (so the owner can give them their first class here), but not someone who is only
      // office staff (accountant and/or admin). Plus anyone still holding an assignment,
      // including someone who has left: their classes still need a new teacher.
      const officeOnly =
        p.roles.length > 0 && p.roles.every((r) => r === 'accountant' || r === 'admin');
      if (!assigned && (p.staff_status !== 'active' || officeOnly)) continue;
      items.push({
        staff_id: p.staff_id,
        name: p.name,
        roles: p.roles,
        staff_status: p.staff_status,
        class_teacher_of: classes,
        subjects,
        load: {
          groups: new Set([...classes, ...subjects].map((x) => x.grp_id)).size,
          subjects: new Set(subjects.map((s) => s.subject_name)).size,
        },
      });
      // Two school classes (primary groups) is the slip to flag; an academy teacher leading
      // several batches is normal.
      const liveClasses = classes.filter((x) => !closed.has(x.grp_id) && primary.has(x.grp_id));
      if (liveClasses.length > 1)
        warnings.double_class_teachers.push({
          staff_id: p.staff_id,
          name: p.name,
          groups: liveClasses,
        });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    const body: TeachersDto = { session_id: sessionId, items, warnings };
    return c.json(body);
  });
}

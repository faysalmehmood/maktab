import {
  type AppDb,
  enrolment,
  grp,
  grpSubject,
  programme,
  session,
  staff,
  student,
  subject,
} from '@maktab/db';
import {
  type GroupDetailDto,
  type GroupDto,
  groupInputSchema,
  groupPatchSchema,
  groupSubjectsInputSchema,
  newId,
} from '@maktab/shared';
import { and, asc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { idParam, jsonBody, notFoundError, userId } from '../lib/http';
import { auditSql, changed, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { groupFilter, scopeToGroups } from '../perm/scope';

const inJson = (col: SQL | typeof grp.id | typeof grpSubject.grpId, ids: string[]) =>
  sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;

/** Groups with programme, class teacher, live seat count and subjects — one shape for every list. */
export async function loadGroups(db: AppDb, where: SQL | undefined): Promise<GroupDto[]> {
  const rows = await db
    .select({
      g: grp,
      programmeName: programme.name,
      programmeKind: programme.kind,
      teacherName: staff.name,
      active: sql<number>`(SELECT count(*) FROM enrolment e
                           WHERE e.grp_id = ${grp.id} AND e.status = 'active')`,
    })
    .from(grp)
    .innerJoin(programme, eq(programme.id, grp.programmeId))
    .leftJoin(staff, eq(staff.id, grp.classTeacherId))
    .where(where)
    .orderBy(asc(programme.kind), asc(programme.seq), asc(grp.name));
  const ids = rows.map((r) => r.g.id);
  const subs = ids.length
    ? await db
        .select({
          id: grpSubject.id,
          grpId: grpSubject.grpId,
          subjectId: grpSubject.subjectId,
          subjectName: subject.name,
          teacherId: grpSubject.teacherId,
          teacherName: staff.name,
        })
        .from(grpSubject)
        .innerJoin(subject, eq(subject.id, grpSubject.subjectId))
        .leftJoin(staff, eq(staff.id, grpSubject.teacherId))
        .where(inJson(grpSubject.grpId, ids))
        .orderBy(asc(subject.name))
    : [];
  return rows.map(({ g, programmeName, programmeKind, teacherName, active }) => ({
    id: g.id,
    programme_id: g.programmeId,
    programme_name: programmeName,
    programme_kind: programmeKind,
    session_id: g.sessionId,
    name: g.name,
    is_primary: g.isPrimary,
    class_teacher_id: g.classTeacherId,
    class_teacher_name: teacherName,
    start_date: g.startDate,
    end_date: g.endDate,
    capacity: g.capacity,
    days: g.days,
    start_time: g.startTime,
    end_time: g.endTime,
    room: g.room,
    next_grp_id: g.nextGrpId,
    status: g.status,
    active_count: Number(active),
    seats_left: g.capacity == null ? null : g.capacity - Number(active),
    subjects: subs
      .filter((s) => s.grpId === g.id)
      .map((s) => ({
        id: s.id,
        subject_id: s.subjectId,
        subject_name: s.subjectName,
        teacher_id: s.teacherId,
        teacher_name: s.teacherName,
      })),
  }));
}

async function oneGroup(db: AppDb, id: string): Promise<GroupDto> {
  const [g] = await loadGroups(db, eq(grp.id, id));
  if (!g) throw notFoundError('Group');
  return g;
}

/** References are checked up front so a typo is a 400, not an opaque foreign-key failure. */
async function assertStaff(db: AppDb, ids: (string | null | undefined)[]): Promise<void> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return;
  const found = await db.select({ id: staff.id }).from(staff).where(inArray(staff.id, want));
  if (found.length !== want.length)
    throw new ApiError(400, 'invalid', 'Unknown teacher (staff id)');
}

async function assertSubjects(db: AppDb, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const found = await db.select({ id: subject.id }).from(subject).where(inArray(subject.id, ids));
  if (found.length !== new Set(ids).size) throw new ApiError(400, 'invalid', 'Unknown subject');
}

/** Promotion target (`next_grp_id`): a live group, never one in the recycle bin. */
async function assertNextGroup(db: AppDb, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const [g] = await db
    .select({ id: grp.id })
    .from(grp)
    .where(and(eq(grp.id, id), isNull(grp.archivedAt)));
  if (!g) throw new ApiError(400, 'invalid', 'next_grp_id: unknown or archived group');
}

export async function groupScope(c: Context<AppEnv>) {
  return scopeToGroups(c.get('db'), userId(c), c.get('grant'));
}

export function groupRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const read = requires('student', 'read');
  const manage = requires('settings', 'manage');

  // A teacher's list is "My groups": only groups they are class or subject teacher of.
  defineRoute(app, table, { method: 'GET', path: '/api/groups', access: read }, async (c) => {
    const db = c.get('db');
    const scope = await groupScope(c);
    const q = c.req.query();
    // `mine=1`: only groups the caller is class or subject teacher of (a teacher who also holds an
    // office role sees every group otherwise). Always inside the read scope above.
    const own = q.mine === '1' ? await scopeToGroups(db, userId(c), 'own_groups') : null;
    const mine = own?.kind === 'groups' ? own.ids : undefined;
    if (mine && !mine.length) return c.json({ items: [] });
    const where = and(
      groupFilter(grp.id, scope),
      mine ? inArray(grp.id, mine) : undefined,
      // Archived groups (recycle bin, M6) are out of every list unless asked for.
      q.archived === '1' ? undefined : isNull(grp.archivedAt),
      q.session_id ? eq(grp.sessionId, q.session_id) : undefined,
      q.programme_id ? eq(grp.programmeId, q.programme_id) : undefined,
      q.status === 'open' || q.status === 'running' || q.status === 'closed'
        ? eq(grp.status, q.status)
        : undefined,
    );
    return c.json({ items: await loadGroups(db, where) });
  });

  defineRoute(app, table, { method: 'GET', path: '/api/groups/:id', access: read }, async (c) => {
    const db = c.get('db');
    const id = idParam(c);
    const scope = await groupScope(c);
    if (scope.kind === 'groups' && !scope.ids.includes(id)) throw notFoundError('Group');
    const g = await oneGroup(db, id);
    const roster = await db
      .select({
        enrolmentId: enrolment.id,
        studentId: student.id,
        name: student.name,
        fatherName: student.fatherName,
        admissionNo: student.admissionNo,
        rollNo: enrolment.rollNo,
        startDate: enrolment.startDate,
        photoKey: student.photoKey,
      })
      .from(enrolment)
      .innerJoin(student, eq(student.id, enrolment.studentId))
      .where(and(eq(enrolment.grpId, id), eq(enrolment.status, 'active')))
      .orderBy(sql`CAST(${enrolment.rollNo} AS INTEGER)`, asc(student.name));
    const body: GroupDetailDto = {
      ...g,
      roster: roster.map((r) => ({
        enrolment_id: r.enrolmentId,
        student_id: r.studentId,
        name: r.name,
        father_name: r.fatherName,
        admission_no: r.admissionNo,
        roll_no: r.rollNo,
        start_date: r.startDate,
        has_photo: !!r.photoKey,
      })),
    };
    return c.json(body);
  });

  defineRoute(app, table, { method: 'POST', path: '/api/groups', access: manage }, async (c) => {
    const input = await jsonBody(c, groupInputSchema);
    const db = c.get('db');
    const uid = userId(c);
    const [prog] = await db.select().from(programme).where(eq(programme.id, input.programme_id));
    if (!prog || prog.deletedAt) throw new ApiError(400, 'invalid', 'Unknown programme');
    const subjects = input.subjects ?? [];
    await assertStaff(db, [input.class_teacher_id, ...subjects.map((s) => s.teacher_id)]);
    await assertSubjects(
      db,
      subjects.map((s) => s.subject_id),
    );
    await assertNextGroup(db, input.next_grp_id);
    let sessionId = input.session_id;
    if (sessionId === undefined) {
      // Default: the current academic year (a school class always belongs to one).
      const [cur] = await db
        .select({ id: session.id })
        .from(session)
        .where(eq(session.isCurrent, true));
      sessionId = cur?.id ?? null;
    }
    const id = input.id ?? newId();
    const values = {
      programmeId: input.programme_id,
      sessionId,
      name: input.name,
      // School classes are primary (the one-active-class rule applies); academy batches are not.
      isPrimary: input.is_primary ?? prog.kind === 'grade',
      classTeacherId: input.class_teacher_id ?? null,
      startDate: input.start_date ?? null,
      endDate: input.end_date ?? null,
      capacity: input.capacity ?? null,
      days: input.days ?? null,
      startTime: input.start_time ?? null,
      endTime: input.end_time ?? null,
      room: input.room ?? null,
      nextGrpId: input.next_grp_id ?? null,
      status: input.status ?? 'open',
    };
    await tx(db, [
      db.insert(grp).values({ id, ...values, createdBy: uid }),
      ...subjects.map((s) =>
        db.insert(grpSubject).values({
          id: newId(),
          grpId: id,
          subjectId: s.subject_id,
          teacherId: s.teacher_id ?? null,
          createdBy: uid,
        }),
      ),
      auditSql({
        id: newId(),
        userId: uid,
        entity: 'grp',
        entityId: id,
        action: 'create',
        after: { ...values, subjects },
      }),
    ]);
    return c.json(await oneGroup(db, id), 201);
  });

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/groups/:id', access: manage },
    async (c) => {
      const input = await jsonBody(c, groupPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(grp).where(eq(grp.id, id));
      if (!before) throw notFoundError('Group');
      await assertStaff(db, [input.class_teacher_id]);
      if (input.next_grp_id === id)
        throw new ApiError(400, 'invalid', 'next_grp_id: cannot point to itself');
      await assertNextGroup(db, input.next_grp_id);
      const values = {
        programmeId: input.programme_id,
        sessionId: input.session_id,
        name: input.name,
        isPrimary: input.is_primary,
        classTeacherId: input.class_teacher_id,
        startDate: input.start_date,
        endDate: input.end_date,
        capacity: input.capacity,
        days: input.days,
        startTime: input.start_time,
        endTime: input.end_time,
        room: input.room,
        nextGrpId: input.next_grp_id,
        status: input.status,
      };
      // Flipping primary/non-primary under live enrolments would desync enrolment.is_primary.
      if (values.isPrimary !== undefined && values.isPrimary !== before.isPrimary) {
        const [live] = await db
          .select({ n: sql<number>`count(*)` })
          .from(enrolment)
          .where(eq(enrolment.grpId, id));
        if (Number(live?.n ?? 0) > 0) {
          throw new ApiError(409, 'in_use', 'Group has enrolments; primary cannot change');
        }
      }
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(grp).set(values).where(eq(grp.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'grp',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      return c.json(await oneGroup(db, id));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/groups/:id/subjects', access: manage },
    async (c) => {
      const input = await jsonBody(c, groupSubjectsInputSchema);
      const db = c.get('db');
      const uid = userId(c);
      const id = idParam(c);
      const [g] = await db.select({ id: grp.id }).from(grp).where(eq(grp.id, id));
      if (!g) throw notFoundError('Group');
      await assertStaff(
        db,
        input.subjects.map((s) => s.teacher_id),
      );
      await assertSubjects(
        db,
        input.subjects.map((s) => s.subject_id),
      );
      const current = await db.select().from(grpSubject).where(eq(grpSubject.grpId, id));
      const bySubject = new Map(current.map((r) => [r.subjectId, r]));
      const wanted = new Set(input.subjects.map((s) => s.subject_id));
      const items: SQL[] = [];
      for (const r of current) {
        if (!wanted.has(r.subjectId)) items.push(sql`DELETE FROM grp_subject WHERE id = ${r.id}`);
      }
      for (const s of input.subjects) {
        const have = bySubject.get(s.subject_id);
        const teacher = s.teacher_id ?? null;
        if (!have) {
          items.push(sql`INSERT INTO grp_subject (id, grp_id, subject_id, teacher_id, created_by)
                         VALUES (${newId()}, ${id}, ${s.subject_id}, ${teacher}, ${uid})`);
        } else if (have.teacherId !== teacher) {
          items.push(sql`UPDATE grp_subject SET teacher_id = ${teacher} WHERE id = ${have.id}`);
        }
      }
      if (items.length) {
        await tx(db, [
          ...items,
          auditSql({
            id: newId(),
            userId: uid,
            entity: 'grp',
            entityId: id,
            action: 'subjects',
            before: {
              subjects: current.map((r) => ({ subject_id: r.subjectId, teacher_id: r.teacherId })),
            },
            after: { subjects: input.subjects },
          }),
        ]);
      }
      return c.json(await oneGroup(db, id));
    },
  );
}

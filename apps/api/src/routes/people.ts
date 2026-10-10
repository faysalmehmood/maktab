import {
  type AppDb,
  customField,
  enrolment,
  family,
  grp,
  guardian,
  programme,
  student,
} from '@maktab/db';
import {
  customValueError,
  type EnrolmentDto,
  type FamilyDetailDto,
  type FamilySearchHit,
  familyInputSchema,
  familyPatchSchema,
  guardianInputSchema,
  guardianPatchSchema,
  MAX_PHOTO_BYTES,
  newId,
  normalizePkPhone,
  type Paged,
  STUDENTS_PAGE_SIZE,
  type StudentDetailDto,
  type StudentListItem,
  studentListQuerySchema,
  studentPatchSchema,
  studentStatusSchema,
  toLatinDigits,
} from '@maktab/shared';
import { and, asc, desc, eq, inArray, like, or, type SQL, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { bucket, deleteReplaced, readImageUpload, serveObject } from '../lib/files';
import { idParam, jsonBody, notFoundError, queryParams, userId } from '../lib/http';
import { auditSql, changed, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { type GroupScope, studentFilter } from '../perm/scope';
import { familyDto, guardianDto, studentDto } from './dto';
import { groupScope } from './groups';

type Extra = Record<string, string | number | boolean | null>;

/** Identity numbers (CNIC, B-form) only for roles that write student records (PLAN §5.4). */
const fullAccess = (c: Context<AppEnv>) => c.get('grant') === 'all';

/** Escapes LIKE wildcards in user input (`ESCAPE '\'`). */
const likeArg = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Guardian-phone condition for a typed fragment: an exact match on the normalised number when it
 * normalises, else a suffix match once there are enough digits to be meaningful.
 */
function phoneMatch(input: string): SQL | null {
  const p = normalizePkPhone(input);
  if (p) return sql`(g.phone = ${p.number} OR g.whatsapp = ${p.number})`;
  const digits = toLatinDigits(input).replace(/\D/g, '');
  if (digits.length < 7) return null;
  return sql`(g.phone LIKE ${`%${digits}`} OR g.whatsapp LIKE ${`%${digits}`})`;
}

/** Validates custom-field values against the `custom_field` rows (PLAN §5.1: values in extra). */
export async function validateExtra(
  db: AppDb,
  extra: Extra | undefined,
): Promise<Extra | undefined> {
  if (!extra) return undefined;
  const fields = await db.select().from(customField).where(eq(customField.entity, 'student'));
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const problems: string[] = [];
  for (const [k, v] of Object.entries(extra)) {
    const f = byKey.get(k);
    if (!f) problems.push(`extra.${k}: unknown_field`);
    else {
      const err = customValueError(f.type, v);
      if (err) problems.push(`extra.${k}: ${err}`);
    }
  }
  if (problems.length) throw new ApiError(400, 'invalid', problems.join('; '));
  return extra;
}

const STUDENT_ITEM = {
  s: student,
  familyName: family.name,
  groupId: sql<string | null>`(SELECT e.grp_id FROM enrolment e
    WHERE e.student_id = ${student.id} AND e.status = 'active'
    ORDER BY e.is_primary DESC, e.start_date LIMIT 1)`,
  groupName: sql<string | null>`(SELECT g.name FROM enrolment e JOIN grp g ON g.id = e.grp_id
    WHERE e.student_id = ${student.id} AND e.status = 'active'
    ORDER BY e.is_primary DESC, e.start_date LIMIT 1)`,
  rollNo: sql<string | null>`(SELECT e.roll_no FROM enrolment e
    WHERE e.student_id = ${student.id} AND e.status = 'active'
    ORDER BY e.is_primary DESC, e.start_date LIMIT 1)`,
  guardianPhone: sql<string | null>`(SELECT g.phone FROM guardian g
    WHERE g.family_id = ${student.familyId} ORDER BY g.priority, g.created_at LIMIT 1)`,
};

type ItemRow = {
  s: typeof student.$inferSelect;
  familyName: string;
  groupId: string | null;
  groupName: string | null;
  rollNo: string | null;
  guardianPhone: string | null;
};

const toItem = (r: ItemRow): StudentListItem => ({
  id: r.s.id,
  family_id: r.s.familyId,
  family_name: r.familyName,
  admission_no: r.s.admissionNo,
  name: r.s.name,
  father_name: r.s.fatherName,
  gender: r.s.gender,
  status: r.s.status,
  has_photo: !!r.s.photoKey,
  group_id: r.groupId,
  group_name: r.groupName,
  roll_no: r.rollNo,
  guardian_phone: r.guardianPhone,
});

async function studentItems(
  db: AppDb,
  where: SQL | undefined,
  page?: { limit: number; offset: number },
): Promise<StudentListItem[]> {
  const q = db
    .select(STUDENT_ITEM)
    .from(student)
    .innerJoin(family, eq(family.id, student.familyId))
    .where(where)
    .orderBy(asc(student.name), asc(student.admissionNo));
  const rows = page ? await q.limit(page.limit).offset(page.offset) : await q;
  return rows.map(toItem);
}

async function visibleOr404(c: Context<AppEnv>, id: string): Promise<GroupScope> {
  const scope = await groupScope(c);
  const [row] = await c
    .get('db')
    .select({ id: student.id })
    .from(student)
    .where(and(eq(student.id, id), studentFilter(student.id, scope)));
  if (!row) throw notFoundError('Student');
  return scope;
}

export async function studentDetail(
  db: AppDb,
  id: string,
  full: boolean,
): Promise<StudentDetailDto> {
  const [s] = await db.select().from(student).where(eq(student.id, id));
  if (!s) throw notFoundError('Student');
  const [f] = await db.select().from(family).where(eq(family.id, s.familyId));
  if (!f) throw notFoundError('Family');
  const guardians = await db
    .select()
    .from(guardian)
    .where(eq(guardian.familyId, f.id))
    .orderBy(asc(guardian.priority), asc(guardian.createdAt));
  const enrolments = await db
    .select({
      e: enrolment,
      grpName: grp.name,
      sessionId: grp.sessionId,
      programmeName: programme.name,
    })
    .from(enrolment)
    .innerJoin(grp, eq(grp.id, enrolment.grpId))
    .innerJoin(programme, eq(programme.id, grp.programmeId))
    .where(eq(enrolment.studentId, id))
    .orderBy(desc(enrolment.startDate), desc(enrolment.createdAt));
  return {
    ...studentDto(s, full),
    family: familyDto(f),
    guardians: guardians.map((g) => guardianDto(g, full)),
    enrolments: enrolments.map(({ e, grpName, sessionId, programmeName }) =>
      enrolmentDto(e, grpName, programmeName, sessionId),
    ),
  };
}

export const enrolmentDto = (
  e: typeof enrolment.$inferSelect,
  grpName: string,
  programmeName: string,
  sessionId: string | null,
): EnrolmentDto => ({
  id: e.id,
  student_id: e.studentId,
  grp_id: e.grpId,
  grp_name: grpName,
  programme_name: programmeName,
  session_id: sessionId,
  is_primary: e.isPrimary,
  roll_no: e.rollNo,
  start_date: e.startDate,
  end_date: e.endDate,
  status: e.status,
  end_reason: e.endReason,
  prev_enrolment_id: e.prevEnrolmentId,
});

/** Next guardian priority in a family: 1 for the first, then max + 1. */
export const nextPrioritySql = (familyId: string) =>
  sql`(SELECT COALESCE(MAX(priority), 0) + 1 FROM guardian WHERE family_id = ${familyId})`;

export function peopleRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const read = requires('student', 'read');
  const write = requires('student', 'write');

  // ---- Families -------------------------------------------------------------------------------
  // Phone-first sibling lookup (PLAN §14.2): any spelling of the guardian's number finds the family.
  defineRoute(app, table, { method: 'GET', path: '/api/families', access: read }, async (c) => {
    const db = c.get('db');
    const scope = await groupScope(c);
    const phone = c.req.query('phone')?.trim() ?? '';
    const q = c.req.query('q')?.trim() ?? '';
    let match: SQL | null = null;
    if (phone) match = phoneMatch(phone);
    else if (q.length >= 2) {
      const pat = `%${likeArg(q)}%`;
      match = sql`(f.name LIKE ${pat} ESCAPE '\\' OR g.name LIKE ${pat} ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM student s WHERE s.family_id = f.id
                     AND (s.name LIKE ${pat} ESCAPE '\\' OR s.admission_no = ${q})))`;
      const byPhone = phoneMatch(q);
      if (byPhone) match = sql`(${match} OR ${byPhone})`;
    }
    if (!match) return c.json({ items: [] });
    const visible =
      scope.kind === 'all'
        ? sql`1`
        : sql`EXISTS (SELECT 1 FROM student s WHERE s.family_id = f.id AND ${studentFilter(sql`s.id`, scope) ?? sql`1`})`;
    const ids = await db.all<{ id: string }>(
      sql`SELECT DISTINCT f.id AS id FROM family f LEFT JOIN guardian g ON g.family_id = f.id
          WHERE f.deleted_at IS NULL AND ${match} AND ${visible}
          ORDER BY f.name LIMIT 20`,
    );
    const familyIds = ids.map((r) => r.id);
    if (!familyIds.length) return c.json({ items: [] });
    const [fams, gs, ss] = await Promise.all([
      db.select().from(family).where(inArray(family.id, familyIds)).orderBy(asc(family.name)),
      db
        .select()
        .from(guardian)
        .where(inArray(guardian.familyId, familyIds))
        .orderBy(asc(guardian.priority)),
      db
        .select()
        .from(student)
        .where(and(inArray(student.familyId, familyIds), studentFilter(student.id, scope)))
        .orderBy(asc(student.name)),
    ]);
    const items: FamilySearchHit[] = fams.map((f) => ({
      ...familyDto(f),
      guardians: gs
        .filter((g) => g.familyId === f.id)
        .map((g) => ({ id: g.id, name: g.name, relation: g.relation, phone: g.phone })),
      students: ss
        .filter((s) => s.familyId === f.id)
        .map((s) => ({ id: s.id, name: s.name, admission_no: s.admissionNo, status: s.status })),
    }));
    return c.json({ items });
  });

  defineRoute(app, table, { method: 'GET', path: '/api/families/:id', access: read }, async (c) => {
    const db = c.get('db');
    const id = idParam(c);
    const scope = await groupScope(c);
    const [f] = await db.select().from(family).where(eq(family.id, id));
    if (!f) throw notFoundError('Family');
    const students = await studentItems(
      db,
      and(eq(student.familyId, id), studentFilter(student.id, scope)),
    );
    // A teacher sees a family only through a student they teach.
    if (scope.kind !== 'all' && !students.length) throw notFoundError('Family');
    const gs = await db
      .select()
      .from(guardian)
      .where(eq(guardian.familyId, id))
      .orderBy(asc(guardian.priority), asc(guardian.createdAt));
    const body: FamilyDetailDto = {
      ...familyDto(f),
      guardians: gs.map((g) => guardianDto(g, fullAccess(c))),
      students,
    };
    return c.json(body);
  });

  defineRoute(app, table, { method: 'POST', path: '/api/families', access: write }, async (c) => {
    const input = await jsonBody(c, familyInputSchema);
    const db = c.get('db');
    const id = input.id ?? newId();
    const values = { name: input.name, address: input.address ?? null, area: input.area ?? null };
    await tx(db, [
      db.insert(family).values({ id, ...values, createdBy: userId(c) }),
      auditSql({
        id: newId(),
        userId: userId(c),
        entity: 'family',
        entityId: id,
        action: 'create',
        after: values,
      }),
    ]);
    const [row] = await db.select().from(family).where(eq(family.id, id));
    if (!row) throw notFoundError('Family');
    return c.json(familyDto(row), 201);
  });

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/families/:id', access: write },
    async (c) => {
      const input = await jsonBody(c, familyPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(family).where(eq(family.id, id));
      if (!before) throw notFoundError('Family');
      const values = { name: input.name, address: input.address, area: input.area };
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(family).set(values).where(eq(family.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'family',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      const [row] = await db.select().from(family).where(eq(family.id, id));
      return c.json(familyDto(row ?? before));
    },
  );

  // ---- Guardians ------------------------------------------------------------------------------
  defineRoute(app, table, { method: 'POST', path: '/api/guardians', access: write }, async (c) => {
    const input = await jsonBody(c, guardianInputSchema);
    const db = c.get('db');
    const [f] = await db
      .select({ id: family.id })
      .from(family)
      .where(eq(family.id, input.family_id));
    if (!f) throw new ApiError(400, 'invalid', 'Unknown family');
    const id = input.id ?? newId();
    const values = guardianValues(input);
    await tx(db, [
      sql`INSERT INTO guardian (id, family_id, name, relation, cnic, phone, whatsapp, priority,
            consent_whatsapp, consent_sms, lang, created_by)
          VALUES (${id}, ${input.family_id}, ${values.name}, ${values.relation}, ${values.cnic},
            ${values.phone}, ${values.whatsapp}, ${input.priority ?? nextPrioritySql(input.family_id)},
            ${values.consentWhatsapp ? 1 : 0}, ${values.consentSms ? 1 : 0}, ${values.lang}, ${userId(c)})`,
      auditSql({
        id: newId(),
        userId: userId(c),
        entity: 'guardian',
        entityId: id,
        action: 'create',
        after: { family_id: input.family_id, ...values },
      }),
    ]);
    const [row] = await db.select().from(guardian).where(eq(guardian.id, id));
    if (!row) throw notFoundError('Guardian');
    return c.json(guardianDto(row, true), 201);
  });

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/guardians/:id', access: write },
    async (c) => {
      const input = await jsonBody(c, guardianPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(guardian).where(eq(guardian.id, id));
      if (!before) throw notFoundError('Guardian');
      const values = {
        name: input.name,
        relation: input.relation,
        cnic: input.cnic,
        phone: input.phone,
        whatsapp: input.whatsapp,
        priority: input.priority,
        consentWhatsapp: input.consent_whatsapp,
        consentSms: input.consent_sms,
        lang: input.lang,
      };
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(guardian).set(values).where(eq(guardian.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'guardian',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      const [row] = await db.select().from(guardian).where(eq(guardian.id, id));
      return c.json(guardianDto(row ?? before, true));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'DELETE', path: '/api/guardians/:id', access: write },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(guardian).where(eq(guardian.id, id));
      if (!before) throw notFoundError('Guardian');
      const [n] = await db
        .select({ n: sql<number>`count(*)` })
        .from(guardian)
        .where(eq(guardian.familyId, before.familyId));
      if (Number(n?.n ?? 0) <= 1) {
        throw new ApiError(409, 'last_guardian', 'A family keeps at least one guardian');
      }
      // Messages (M5) will reference guardians; then the FK refuses and this becomes 409 in_use.
      await tx(db, [
        db.delete(guardian).where(eq(guardian.id, id)),
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'guardian',
          entityId: id,
          action: 'delete',
          before: guardianDto(before, true),
        }),
      ]);
      return c.json({ ok: true });
    },
  );

  // ---- Students -------------------------------------------------------------------------------
  defineRoute(app, table, { method: 'GET', path: '/api/students', access: read }, async (c) => {
    const db = c.get('db');
    const query = queryParams(c, studentListQuerySchema);
    const scope = await groupScope(c);
    const conds: (SQL | undefined)[] = [studentFilter(student.id, scope)];
    if (query.status) conds.push(eq(student.status, query.status));
    if (query.family) conds.push(eq(student.familyId, query.family));
    if (query.group) {
      conds.push(sql`${student.id} IN (SELECT student_id FROM enrolment
                       WHERE grp_id = ${query.group} AND status = 'active')`);
    }
    if (query.q) {
      const pat = `%${likeArg(query.q)}%`;
      const byPhone = phoneMatch(query.q);
      conds.push(
        or(
          sql`${student.name} LIKE ${pat} ESCAPE '\\'`,
          sql`${student.fatherName} LIKE ${pat} ESCAPE '\\'`,
          like(student.admissionNo, `${likeArg(query.q)}%`),
          byPhone
            ? sql`${student.familyId} IN (SELECT g.family_id FROM guardian g WHERE ${byPhone})`
            : undefined,
        ),
      );
    }
    const where = and(...conds);
    const [count] = await db.select({ n: sql<number>`count(*)` }).from(student).where(where);
    const items = await studentItems(db, where, {
      limit: STUDENTS_PAGE_SIZE,
      offset: (query.page - 1) * STUDENTS_PAGE_SIZE,
    });
    const body: Paged<StudentListItem> = {
      items,
      total: Number(count?.n ?? 0),
      page: query.page,
      page_size: STUDENTS_PAGE_SIZE,
    };
    return c.json(body);
  });

  defineRoute(app, table, { method: 'GET', path: '/api/students/:id', access: read }, async (c) => {
    const id = idParam(c);
    await visibleOr404(c, id);
    return c.json(await studentDetail(c.get('db'), id, fullAccess(c)));
  });

  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/students/:id/photo', access: read },
    async (c) => {
      const id = idParam(c);
      await visibleOr404(c, id);
      const [s] = await c
        .get('db')
        .select({ key: student.photoKey })
        .from(student)
        .where(eq(student.id, id));
      return serveObject(c, s?.key ?? null);
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PATCH', path: '/api/students/:id', access: write },
    async (c) => {
      const input = await jsonBody(c, studentPatchSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(student).where(eq(student.id, id));
      if (!before) throw notFoundError('Student');
      const extra = await validateExtra(db, input.extra);
      const values = {
        name: input.name,
        fatherName: input.father_name,
        dob: input.dob,
        gender: input.gender,
        bFormNo: input.b_form_no,
        // Blank keeps the number (it is NOT NULL); a new value must still be unique (409).
        admissionNo: input.admission_no ?? undefined,
        admissionDate: input.admission_date,
        extra: extra ? { ...(before.extra as Extra | null), ...extra } : undefined,
      };
      const diff = changed(before, values);
      if (diff) {
        await tx(db, [
          db.update(student).set(values).where(eq(student.id, id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'student',
            entityId: id,
            action: 'update',
            ...diff,
          }),
        ]);
      }
      return c.json(await studentDetail(db, id, true));
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/students/:id/photo', access: write },
    async (c) => {
      const files = bucket(c);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(student).where(eq(student.id, id));
      if (!before) throw notFoundError('Student');
      const { bytes, type } = await readImageUpload(c, MAX_PHOTO_BYTES);
      const key = `students/${id}/${newId()}`;
      await files.put(key, bytes, { httpMetadata: { contentType: type } });
      await tx(db, [
        db.update(student).set({ photoKey: key }).where(eq(student.id, id)),
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'student',
          entityId: id,
          action: 'photo',
          before: { photo_key: before.photoKey },
          after: { photo_key: key, bytes: bytes.byteLength },
        }),
      ]);
      await deleteReplaced(files, before.photoKey, key);
      return c.json({ has_photo: true });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/students/:id/status', access: write },
    async (c) => {
      const input = await jsonBody(c, studentStatusSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [before] = await db.select().from(student).where(eq(student.id, id));
      if (!before) throw notFoundError('Student');
      if (before.status !== 'active') {
        throw new ApiError(409, 'invalid_transition', `Student is already ${before.status}`);
      }
      // Leaving ends every live enrolment on the same date (fees stop there in M3).
      const endStatus = input.status === 'left' ? 'withdrawn' : 'completed';
      await tx(db, [
        // Audit first: it lists the enrolments the UPDATE below is about to end, read in-batch.
        auditSql(
          {
            id: newId(),
            userId: userId(c),
            entity: 'student',
            entityId: id,
            action: 'status',
            before: { status: before.status },
            after: {
              status: input.status,
              date: input.date,
              reason: input.reason,
              enrolment_status: endStatus,
            },
          },
          {
            ended_enrolment_ids: sql`json((SELECT json_group_array(id) FROM enrolment
                                           WHERE student_id = ${id} AND status = 'active'))`,
          },
        ),
        sql`UPDATE enrolment SET status = ${endStatus}, end_date = ${input.date}, end_reason = ${input.reason}
            WHERE student_id = ${id} AND status = 'active'`,
        db
          .update(student)
          .set({ status: input.status, leftDate: input.date, leftReason: input.reason })
          .where(eq(student.id, id)),
      ]);
      return c.json(await studentDetail(db, id, true));
    },
  );
}

/** Guardian columns from validated input; WhatsApp defaults to the phone when it is a mobile. */
export function guardianValues(input: {
  name: string;
  relation?: string | null;
  cnic?: string | null;
  phone: string;
  whatsapp?: string | null;
  consent_whatsapp: boolean;
  consent_sms: boolean;
  lang: 'en' | 'ur';
}) {
  const mobile = /^923\d{9}$/.test(input.phone);
  return {
    name: input.name,
    relation: input.relation ?? null,
    cnic: input.cnic ?? null,
    phone: input.phone,
    whatsapp: input.whatsapp ?? (mobile ? input.phone : null),
    consentWhatsapp: input.consent_whatsapp,
    consentSms: input.consent_sms,
    lang: input.lang,
  };
}

import { type AppDb, enrolment, family, grp, programme, session, student } from '@maktab/db';
import {
  type AdmissionFeesDto,
  type AdmissionResult,
  admissionFeesSchema,
  admissionInputSchema,
  enrolmentEndSchema,
  enrolmentInputSchema,
  enrolmentTransferSchema,
  newId,
  previewFeesQuerySchema,
} from '@maktab/shared';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { planAdmissionFees } from '../lib/fees';
import { idParam, jsonBody, notFoundError, queryParams, todayPk, userId } from '../lib/http';
import { auditSql, readBack, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { enrolmentDto, guardianValues, nextPrioritySql, validateExtra } from './people';

type GroupRow = typeof grp.$inferSelect & { sessionStart: string | null };

/**
 * The group to enrol into: must exist, not be archived and not be closed. Capacity is a planning number, never
 * enforced (a school squeezes in one more child); the admission form shows seats left and warns.
 */
export async function openGroup(db: AppDb, id: string): Promise<GroupRow> {
  const [row] = await db
    .select({ g: grp, sessionStart: session.startDate })
    .from(grp)
    .leftJoin(session, eq(session.id, grp.sessionId))
    .where(eq(grp.id, id));
  // An archived group (recycle bin) is gone as far as enrolling goes; the DB trigger
  // enrolment_grp_archived refuses it too.
  if (!row || row.g.archivedAt) throw new ApiError(400, 'invalid', 'Unknown group');
  if (row.g.status === 'closed') throw new ApiError(409, 'group_closed', 'This group is closed');
  return { ...row.g, sessionStart: row.sessionStart };
}

/**
 * Admission-number series `YYYY`: the group's session start year, else the current session's, else
 * the admission date's. Sessions are yearly (PLAN §2), so "per session" = per start year.
 */
async function seriesYear(db: AppDb, g: GroupRow, admissionDate: string): Promise<string> {
  if (g.sessionStart) return g.sessionStart.slice(0, 4);
  const [cur] = await db
    .select({ start: session.startDate })
    .from(session)
    .where(eq(session.isCurrent, true));
  return (cur?.start ?? admissionDate).slice(0, 4);
}

/**
 * Bumps the series inside the batch. The new value also skips past any hand-typed `YYYY-NNNN`
 * already used, so an editable number never makes the next automatic one collide.
 */
export const bumpAdmissionSeries = (year: string, by = 1): SQL => {
  const highest = sql`(SELECT COALESCE(MAX(CAST(substr(admission_no, 6) AS INTEGER)), 0)
                       FROM student WHERE admission_no LIKE ${`${year}-%`})`;
  return sql`INSERT INTO admission_series (series, last_no) VALUES (${year}, ${highest} + ${by})
             ON CONFLICT(series) DO UPDATE SET last_no = MAX(last_no + ${by}, ${highest} + ${by})`;
};

/** `YYYY-NNNN` for the k-th of n numbers just reserved by `bumpAdmissionSeries(year, n)` (k ≥ 1). */
export const reservedAdmissionNo = (year: string, n = 1, k: SQL | number = 1): SQL =>
  sql`(SELECT printf('%s-%04d', series, last_no - ${n} + ${k}) FROM admission_series WHERE series = ${year})`;

/** Roll number: the typed one, else max + 1 over the group's enrolments (all statuses: no reuse). */
const rollSql = (grpId: string, roll: string | null | undefined): SQL =>
  roll
    ? sql`${roll}`
    : sql`(SELECT CAST(COALESCE(MAX(CAST(roll_no AS INTEGER)), 0) + 1 AS TEXT)
           FROM enrolment WHERE grp_id = ${grpId})`;

/** is_primary is copied from the group, so the one-active-primary index sees school classes only. */
export const insertEnrolment = (e: {
  id: string;
  studentId: string;
  grpId: string;
  startDate: string;
  roll: string | null | undefined;
  prevId?: string | null;
  by: string;
}): SQL =>
  sql`INSERT INTO enrolment (id, student_id, grp_id, is_primary, roll_no, start_date, status,
        prev_enrolment_id, created_by)
      SELECT ${e.id}, ${e.studentId}, g.id, g.is_primary, ${rollSql(e.grpId, e.roll)}, ${e.startDate},
        'active', ${e.prevId ?? null}, ${e.by}
      FROM grp g WHERE g.id = ${e.grpId}`;

async function enrolmentOut(db: AppDb, id: string) {
  const [row] = await db
    .select({
      e: enrolment,
      grpName: grp.name,
      sessionId: grp.sessionId,
      programmeName: programme.name,
    })
    .from(enrolment)
    .innerJoin(grp, eq(grp.id, enrolment.grpId))
    .innerJoin(programme, eq(programme.id, grp.programmeId))
    .where(eq(enrolment.id, id));
  if (!row) throw notFoundError('Enrolment');
  return enrolmentDto(row.e, row.grpName, row.programmeName, row.sessionId);
}

async function admissionResult(
  db: AppDb,
  enrolmentId: string,
  guardianIds: string[],
  readmitted: boolean,
  fees: AdmissionFeesDto | null = null,
): Promise<AdmissionResult> {
  const [row] = await db
    .select({ e: enrolment, s: student })
    .from(enrolment)
    .innerJoin(student, eq(student.id, enrolment.studentId))
    .where(eq(enrolment.id, enrolmentId));
  if (!row) throw notFoundError('Enrolment');
  return {
    family_id: row.s.familyId,
    student_id: row.s.id,
    enrolment_id: row.e.id,
    guardian_ids: guardianIds,
    admission_no: row.s.admissionNo,
    roll_no: row.e.rollNo,
    readmitted,
    fees,
  };
}

const feeOptions = (f: unknown) => admissionFeesSchema.parse(f ?? {});

export function admissionRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const write = requires('student', 'write');

  /**
   * PLAN §14.2 step 5: what admission will bill (first period + admission fee, sibling concession
   * suggested by the rule), without writing anything. Same planner as the admission batch.
   */
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/admissions/preview-fees', access: write },
    async (c) => {
      const q = queryParams(c, previewFeesQuerySchema);
      const db = c.get('db');
      const g = await openGroup(db, q.grp_id);
      let familyId = q.family_id ?? null;
      if (q.student_id) {
        const [s] = await db.select().from(student).where(eq(student.id, q.student_id));
        if (!s) throw notFoundError('Student');
        familyId = s.familyId;
      }
      if (familyId) {
        const [f] = await db.select({ id: family.id }).from(family).where(eq(family.id, familyId));
        if (!f) throw notFoundError('Family');
      }
      const today = todayPk();
      const { dto } = await planAdmissionFees(db, {
        enrolmentId: 'preview',
        studentId: q.student_id ?? 'preview',
        familyId: familyId ?? 'preview',
        existingFamily: !!familyId,
        grpId: g.id,
        startDate: q.start_date ?? today,
        today,
        by: userId(c),
        proRata: q.pro_rata ?? false,
        sibling: q.sibling_concession ?? true,
      });
      return c.json({ fees: dto });
    },
  );

  /**
   * PLAN §14.2 as one batch: family (reuse or new) → guardians → student (numbered in the batch)
   * → enrolment → audit. Or a re-admission: reactivate a left student and enrol, same family.
   */
  defineRoute(app, table, { method: 'POST', path: '/api/admissions', access: write }, async (c) => {
    const input = await jsonBody(c, admissionInputSchema);
    const db = c.get('db');
    const uid = userId(c);
    const enrolmentId = input.enrolment.id ?? newId();

    // A retried request with the same client-minted enrolment id is answered, not re-applied.
    const [replay] = await db
      .select({ id: enrolment.id })
      .from(enrolment)
      .where(eq(enrolment.id, enrolmentId));
    if (replay) {
      return c.json(
        await admissionResult(
          db,
          enrolmentId,
          input.guardians.map((g) => g.id ?? ''),
          !!input.readmit_student_id,
        ),
      );
    }

    const g = await openGroup(db, input.enrolment.grp_id);
    const today = todayPk();

    if (input.readmit_student_id) {
      const sid = input.readmit_student_id;
      const [s] = await db.select().from(student).where(eq(student.id, sid));
      if (!s) throw notFoundError('Student');
      if (s.status === 'active') {
        throw new ApiError(
          409,
          'not_readmittable',
          'Student is active; enrol them in a group instead',
        );
      }
      const startDate = input.enrolment.start_date ?? today;
      const fees = feeOptions(input.fees);
      const billed = fees.charge
        ? await planAdmissionFees(db, {
            enrolmentId,
            studentId: sid,
            familyId: s.familyId,
            existingFamily: true,
            grpId: g.id,
            startDate,
            today,
            by: uid,
            proRata: fees.pro_rata,
            sibling: fees.sibling_concession,
          })
        : null;
      await tx(db, [
        sql`UPDATE student SET status = 'active', left_date = NULL, left_reason = NULL WHERE id = ${sid}`,
        insertEnrolment({
          id: enrolmentId,
          studentId: sid,
          grpId: g.id,
          startDate,
          roll: input.enrolment.roll_no,
          by: uid,
        }),
        auditSql(
          {
            id: newId(),
            userId: uid,
            entity: 'student',
            entityId: sid,
            action: 'readmit',
            before: { status: s.status, left_date: s.leftDate, left_reason: s.leftReason },
            after: {
              status: 'active',
              enrolment_id: enrolmentId,
              grp_id: g.id,
              start_date: startDate,
            },
          },
          { roll_no: readBack('enrolment', 'roll_no', enrolmentId) },
        ),
        // First-period charges in the same batch (M1 note: both admission paths bill).
        ...(billed?.statements ?? []),
      ]);
      return c.json(await admissionResult(db, enrolmentId, [], true, billed?.dto ?? null), 201);
    }

    // superRefine guarantees student + exactly one of family_id / family here.
    const st = input.student;
    if (!st) throw new ApiError(400, 'invalid', 'student: required');
    let familyId: string;
    const items: SQL[] = [];
    if (input.family_id) {
      const [f] = await db
        .select({ id: family.id })
        .from(family)
        .where(eq(family.id, input.family_id));
      if (!f) throw new ApiError(400, 'invalid', 'Unknown family');
      familyId = f.id;
    } else {
      const fam = input.family;
      if (!fam) throw new ApiError(400, 'invalid', 'family: required');
      familyId = fam.id ?? newId();
      const values = { name: fam.name, address: fam.address ?? null, area: fam.area ?? null };
      items.push(
        sql`INSERT INTO family (id, name, address, area, created_by)
            VALUES (${familyId}, ${values.name}, ${values.address}, ${values.area}, ${uid})`,
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'family',
          entityId: familyId,
          action: 'create',
          after: values,
        }),
      );
    }
    const guardianIds: string[] = [];
    for (const gd of input.guardians) {
      const gid = gd.id ?? newId();
      guardianIds.push(gid);
      const v = guardianValues(gd);
      items.push(
        sql`INSERT INTO guardian (id, family_id, name, relation, cnic, phone, whatsapp, priority,
              consent_whatsapp, consent_sms, lang, created_by)
            VALUES (${gid}, ${familyId}, ${v.name}, ${v.relation}, ${v.cnic}, ${v.phone}, ${v.whatsapp},
              ${gd.priority ?? nextPrioritySql(familyId)}, ${v.consentWhatsapp ? 1 : 0},
              ${v.consentSms ? 1 : 0}, ${v.lang}, ${uid})`,
        auditSql({
          id: newId(),
          userId: uid,
          entity: 'guardian',
          entityId: gid,
          action: 'create',
          after: { family_id: familyId, ...v },
        }),
      );
    }

    const studentId = input.student_id ?? newId();
    const extra = await validateExtra(db, st.extra);
    const admissionDate = st.admission_date;
    let admissionNo: SQL;
    if (st.admission_no) admissionNo = sql`${st.admission_no}`;
    else {
      const year = await seriesYear(db, g, admissionDate);
      items.push(bumpAdmissionSeries(year));
      admissionNo = reservedAdmissionNo(year);
    }
    const startDate = input.enrolment.start_date ?? admissionDate;
    items.push(
      sql`INSERT INTO student (id, family_id, admission_no, name, father_name, dob, gender, b_form_no,
            admission_date, status, extra, created_by)
          VALUES (${studentId}, ${familyId}, ${admissionNo}, ${st.name}, ${st.father_name ?? null},
            ${st.dob ?? null}, ${st.gender ?? null}, ${st.b_form_no ?? null}, ${admissionDate}, 'active',
            ${extra ? JSON.stringify(extra) : null}, ${uid})`,
      insertEnrolment({
        id: enrolmentId,
        studentId,
        grpId: g.id,
        startDate,
        roll: input.enrolment.roll_no,
        by: uid,
      }),
      // Written after the inserts, so the numbers allocated inside the batch are read back.
      auditSql(
        {
          id: newId(),
          userId: uid,
          entity: 'student',
          entityId: studentId,
          action: 'admit',
          after: {
            family_id: familyId,
            name: st.name,
            father_name: st.father_name ?? null,
            admission_date: admissionDate,
            enrolment_id: enrolmentId,
            grp_id: g.id,
            is_primary: g.isPrimary,
          },
        },
        {
          admission_no: readBack('student', 'admission_no', studentId),
          roll_no: readBack('enrolment', 'roll_no', enrolmentId),
        },
      ),
    );
    const fees = feeOptions(input.fees);
    const billed = fees.charge
      ? await planAdmissionFees(db, {
          enrolmentId,
          studentId,
          familyId,
          existingFamily: !!input.family_id,
          grpId: g.id,
          startDate,
          today,
          by: uid,
          proRata: fees.pro_rata,
          sibling: fees.sibling_concession,
        })
      : null;
    items.push(...(billed?.statements ?? []));
    await tx(db, items);
    return c.json(
      await admissionResult(db, enrolmentId, guardianIds, false, billed?.dto ?? null),
      201,
    );
  });

  defineRoute(app, table, { method: 'POST', path: '/api/enrolments', access: write }, async (c) => {
    const input = await jsonBody(c, enrolmentInputSchema);
    const db = c.get('db');
    const uid = userId(c);
    const [s] = await db.select().from(student).where(eq(student.id, input.student_id));
    if (!s) throw new ApiError(400, 'invalid', 'Unknown student');
    if (s.status !== 'active') {
      throw new ApiError(409, 'student_not_active', 'Re-admit the student first');
    }
    const g = await openGroup(db, input.grp_id);
    const id = input.id ?? newId();
    // A second active primary enrolment is refused by the one_primary index → 409 already_enrolled.
    await tx(db, [
      insertEnrolment({
        id,
        studentId: s.id,
        grpId: g.id,
        startDate: input.start_date,
        roll: input.roll_no,
        by: uid,
      }),
      auditSql(
        {
          id: newId(),
          userId: uid,
          entity: 'enrolment',
          entityId: id,
          action: 'create',
          after: {
            student_id: s.id,
            grp_id: g.id,
            is_primary: g.isPrimary,
            start_date: input.start_date,
          },
        },
        { roll_no: readBack('enrolment', 'roll_no', id) },
      ),
    ]);
    return c.json(await enrolmentOut(db, id), 201);
  });

  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/enrolments/:id/end', access: write },
    async (c) => {
      const input = await jsonBody(c, enrolmentEndSchema);
      const db = c.get('db');
      const id = idParam(c);
      const [e] = await db.select().from(enrolment).where(eq(enrolment.id, id));
      if (!e) throw notFoundError('Enrolment');
      if (e.status !== 'active')
        throw new ApiError(409, 'invalid_transition', 'Enrolment already ended');
      if (input.end_date < e.startDate)
        throw new ApiError(400, 'invalid', 'end_date: before start');
      await tx(db, [
        sql`UPDATE enrolment SET status = ${input.status}, end_date = ${input.end_date},
              end_reason = ${input.reason} WHERE id = ${id} AND status = 'active'`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'enrolment',
          entityId: id,
          action: 'end',
          before: { status: e.status },
          after: { status: input.status, end_date: input.end_date, reason: input.reason },
        }),
      ]);
      return c.json(await enrolmentOut(db, id));
    },
  );

  /**
   * Section change mid-year: the old row becomes `transferred` (not `withdrawn`, which means the
   * student left) and the new one links back to it, in one batch.
   */
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/enrolments/:id/transfer', access: write },
    async (c) => {
      const input = await jsonBody(c, enrolmentTransferSchema);
      const db = c.get('db');
      const uid = userId(c);
      const id = idParam(c);
      const [e] = await db.select().from(enrolment).where(eq(enrolment.id, id));
      if (!e) throw notFoundError('Enrolment');
      if (e.status !== 'active')
        throw new ApiError(409, 'invalid_transition', 'Enrolment already ended');
      if (input.grp_id === e.grpId) throw new ApiError(400, 'invalid', 'grp_id: same group');
      if (input.date < e.startDate) throw new ApiError(400, 'invalid', 'date: before start');
      const g = await openGroup(db, input.grp_id);
      const newEnrolmentId = input.new_id ?? newId();
      await tx(db, [
        // Ending first frees the one-active-primary slot for the new row in the same batch.
        sql`UPDATE enrolment SET status = 'transferred', end_date = ${input.date},
              end_reason = ${input.reason} WHERE id = ${id} AND status = 'active'`,
        insertEnrolment({
          id: newEnrolmentId,
          studentId: e.studentId,
          grpId: g.id,
          startDate: input.date,
          roll: input.roll_no,
          prevId: id,
          by: uid,
        }),
        auditSql(
          {
            id: newId(),
            userId: uid,
            entity: 'enrolment',
            entityId: id,
            action: 'transfer',
            before: { grp_id: e.grpId, status: e.status, roll_no: e.rollNo },
            after: {
              status: 'transferred',
              grp_id: g.id,
              new_enrolment_id: newEnrolmentId,
              date: input.date,
              reason: input.reason,
            },
          },
          { roll_no: readBack('enrolment', 'roll_no', newEnrolmentId) },
        ),
      ]);
      return c.json(await enrolmentOut(db, newEnrolmentId), 201);
    },
  );
}

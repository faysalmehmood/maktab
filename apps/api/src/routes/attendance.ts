import { type AppDb, failingGroups, holiday, school } from '@maktab/db';
import {
  type AbsenteeDto,
  type AttendanceReport,
  type AttendanceSyncResult,
  attendanceCorrectionSchema,
  attendanceSettingsSchema,
  attendanceSubmissionSchema,
  attendanceSyncRequestSchema,
  countMarks,
  type DashboardTodayResponse,
  type HolidayDto,
  holidayInputSchema,
  isoDateSchema,
  MARK_CODE,
  MARK_STATUSES,
  MAX_MARKS_PER_SYNC,
  type MarkCounts,
  type MarkStatus,
  monthSchema,
  newId,
  presentPct,
  type RegisterResponse,
  type ReportDay,
  type StudentAttendanceResponse,
  type TodayItem,
  type TodayResponse,
  toCsvLine,
  WHOLE_DAY,
  weekdayOf,
} from '@maktab/shared';
import { asc, eq, type SQL, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import {
  applySubmissions,
  dayOff,
  emptyCounts,
  groupLabel,
  holidaysIn,
  type SchoolAttendance,
  schoolAttendance,
} from '../lib/attendance';
import { ApiError } from '../lib/errors';
import { idParam, jsonBody, notFoundError, queryParams, todayPk, userId } from '../lib/http';
import { messageScopeSql } from '../lib/messaging';
import { auditSql, changed, tx } from '../lib/tx';
import { defineRoute, type RouteTable, requires } from '../perm/routes';
import { type GroupScope, registerFilter, scopeToGroups, studentFilter } from '../perm/scope';
import { schoolDto } from './dto';

const scopeOf = (c: Context<AppEnv>) => scopeToGroups(c.get('db'), userId(c), c.get('grant'));

const inJson = (col: SQL, values: string[]) =>
  sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

/** Enrolment `e` covers date `d`: started by then, not ended before, and not an orphaned row. */
const covers = (d: SQL | string) =>
  sql`e.start_date <= ${d} AND (e.end_date IS NULL OR e.end_date >= ${d})
      AND (e.status = 'active' OR e.end_date IS NOT NULL)`;

const countsSql = (registerCol: SQL) => sql`
  (SELECT count(*) FROM att_mark m WHERE m.register_id = ${registerCol} AND m.status = 'P') AS p,
  (SELECT count(*) FROM att_mark m WHERE m.register_id = ${registerCol} AND m.status = 'A') AS a,
  (SELECT count(*) FROM att_mark m WHERE m.register_id = ${registerCol} AND m.status = 'L') AS l,
  (SELECT count(*) FROM att_mark m WHERE m.register_id = ${registerCol} AND m.status = 'E') AS e`;

type CountCols = { p: number; a: number; l: number; e: number };
const toCounts = (r: CountCols): MarkCounts => ({
  P: Number(r.p),
  A: Number(r.a),
  L: Number(r.l),
  E: Number(r.e),
});

function assertInScope(scope: GroupScope, grpId: string): void {
  // Out of scope looks exactly like "does not exist" (no probing other teachers' groups).
  if (scope.kind === 'groups' && !scope.ids.includes(grpId)) throw notFoundError('Group');
}

type GroupRow = {
  id: string;
  name: string;
  programme_name: string;
  class_teacher_name: string | null;
};

async function groupRow(db: AppDb, grpId: string): Promise<GroupRow> {
  const [g] = await db.all<GroupRow>(
    sql`SELECT g.id, g.name, p.name AS programme_name, s.name AS class_teacher_name
        FROM grp g JOIN programme p ON p.id = g.programme_id
        LEFT JOIN staff s ON s.id = g.class_teacher_id WHERE g.id = ${grpId}`,
  );
  if (!g) throw notFoundError('Group');
  return g;
}

/**
 * The "today" list for a scope: one item per register key (group, or group × subject in
 * per-subject mode) for groups with at least one student enrolled on that date.
 */
async function todayItems(
  db: AppDb,
  scope: GroupScope,
  date: string,
  settings: SchoolAttendance,
): Promise<TodayItem[]> {
  if (scope.kind === 'groups' && !scope.ids.length) return [];
  const where = scope.kind === 'groups' ? inJson(sql`g.id`, scope.ids) : sql`1`;
  const groups = await db.all<GroupRow & { students: number }>(
    sql`SELECT g.id, g.name, p.name AS programme_name, s.name AS class_teacher_name,
          (SELECT count(*) FROM enrolment e WHERE e.grp_id = g.id AND ${covers(date)}) AS students
        FROM grp g JOIN programme p ON p.id = g.programme_id
        LEFT JOIN staff s ON s.id = g.class_teacher_id
        WHERE ${where} AND g.status <> 'closed' AND g.archived_at IS NULL
        ORDER BY p.kind, p.seq, g.name`,
  );
  const live = groups.filter((g) => Number(g.students) > 0);
  if (!live.length) return [];
  const ids = live.map((g) => g.id);
  const subjects =
    settings.mode === 'per_subject'
      ? await db.all<{ id: string; grp_id: string; name: string }>(
          sql`SELECT gs.id, gs.grp_id, sb.name FROM grp_subject gs
              JOIN subject sb ON sb.id = gs.subject_id
              WHERE ${inJson(sql`gs.grp_id`, ids)} ORDER BY sb.name`,
        )
      : [];
  const current = await db.all<
    CountCols & {
      grp_id: string;
      grp_subject_id: string;
      register_id: string;
      taken_at: string;
      taken_by_name: string | null;
    }
  >(
    sql`SELECT c.grp_id, c.grp_subject_id, c.register_id, c.taken_at, u.name AS taken_by_name,
          ${countsSql(sql`c.register_id`)}
        FROM current_register c JOIN att_register r ON r.id = c.register_id
        LEFT JOIN "user" u ON u.id = r.taken_by
        WHERE c.date = ${date} AND ${inJson(sql`c.grp_id`, ids)}`,
  );
  const byKey = new Map(current.map((r) => [`${r.grp_id}|${r.grp_subject_id}`, r]));
  const items: TodayItem[] = [];
  for (const g of live) {
    const subs = subjects.filter((s) => s.grp_id === g.id);
    const keys = subs.length
      ? subs.map((s) => ({ id: s.id, name: s.name as string | null }))
      : [{ id: WHOLE_DAY, name: null }];
    // A teacher who reaches this group only through a subject sees only that subject's register.
    const only = scope.kind === 'groups' ? scope.subjectsOnly?.[g.id] : undefined;
    for (const k of keys) {
      if (only && !only.includes(k.id)) continue;
      const r = byKey.get(`${g.id}|${k.id}`);
      items.push({
        grp_id: g.id,
        grp_name: g.name,
        programme_name: g.programme_name,
        grp_subject_id: k.id,
        subject_name: k.name,
        class_teacher_name: g.class_teacher_name,
        student_count: Number(g.students),
        status: r ? 'taken' : 'not_taken',
        register_id: r?.register_id ?? null,
        counts: r ? toCounts(r) : emptyCounts(),
        taken_by_name: r?.taken_by_name ?? null,
        taken_at: r?.taken_at ?? null,
      });
    }
  }
  return items;
}

const dateQuery = z.object({ date: isoDateSchema.optional() });
const registerQuery = z.object({
  grp_id: z.string().min(1),
  date: isoDateSchema,
  grp_subject_id: z.string().optional(),
});
const rangeQuery = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() });
const reportQuery = z.object({
  grp_id: z.string().min(1),
  month: monthSchema,
  grp_subject_id: z.string().optional(),
  format: z.enum(['json', 'csv']).optional(),
});

function monthDays(month: string): string[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export function attendanceRoutes(app: Hono<AppEnv>, table: RouteTable): void {
  const mark = requires('attendance', 'mark');
  const correct = requires('attendance', 'correct');
  const read = requires('attendance', 'read');
  const manage = requires('settings', 'manage');

  // ---- Sync (teacher phones, offline outbox) ---------------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/attendance/sync', access: mark },
    async (c) => {
      const raw = await jsonBody(c, attendanceSyncRequestSchema);
      // Whole-request budget (PLAN §15): ≤ 200 marks, however they are spread over the registers.
      // The outbox packs requests to fit; anything bigger is refused as a whole, not half-applied.
      const marks = countMarks(raw);
      if (marks > MAX_MARKS_PER_SYNC)
        throw new ApiError(
          400,
          'too_many_marks',
          `${marks} marks in one request; at most ${MAX_MARKS_PER_SYNC}`,
        );
      const db = c.get('db');
      const parsed = raw.map((item) => attendanceSubmissionSchema.safeParse(item));
      const valid = parsed.flatMap((p) => (p.success ? [p.data] : []));
      const applied = await applySubmissions(db, valid, {
        uid: userId(c),
        scope: await scopeOf(c),
        kind: 'sync',
      });
      let k = 0;
      const results: AttendanceSyncResult[] = parsed.map((p, i) => {
        if (p.success) return applied[k++] as AttendanceSyncResult;
        const cid = (raw[i] as { client_id?: unknown } | null)?.client_id;
        const issue = p.error.issues[0];
        return {
          client_id: typeof cid === 'string' ? cid : null,
          status: 'rejected',
          error: 'invalid',
          message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid',
        };
      });
      return c.json({ results });
    },
  );

  // ---- Office correction ------------------------------------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'POST', path: '/api/attendance/correct', access: correct },
    async (c) => {
      const input = await jsonBody(c, attendanceCorrectionSchema);
      const [result] = await applySubmissions(
        c.get('db'),
        [{ ...input, taken_at: input.taken_at ?? new Date().toISOString() }],
        { uid: userId(c), scope: { kind: 'all' }, kind: 'correct' },
      );
      if (!result) throw new ApiError(500, 'internal', 'No result');
      if (result.status === 'rejected') {
        const code = result.error ?? 'invalid';
        throw new ApiError(code === 'db_error' ? 409 : 400, code, result.message ?? code);
      }
      return c.json(result);
    },
  );

  // ---- Today --------------------------------------------------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/attendance/today', access: read },
    async (c) => {
      const db = c.get('db');
      const date = queryParams(c, dateQuery).date ?? todayPk();
      const settings = await schoolAttendance(db);
      const body: TodayResponse = {
        date,
        mode: settings.mode,
        day_off: await dayOff(db, date, settings),
        items: await todayItems(db, await scopeOf(c), date, settings),
      };
      return c.json(body);
    },
  );

  // ---- One register: roster + current marks + history ------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/attendance/register', access: read },
    async (c) => {
      const db = c.get('db');
      const q = queryParams(c, registerQuery);
      const subj = q.grp_subject_id ?? WHOLE_DAY;
      assertInScope(await scopeOf(c), q.grp_id);
      const g = await groupRow(db, q.grp_id);
      const settings = await schoolAttendance(db);
      const [cur] = await db.all<{
        register_id: string;
        taken_at: string;
        taken_by_name: string | null;
      }>(
        sql`SELECT c.register_id, c.taken_at, u.name AS taken_by_name
            FROM current_register c JOIN att_register r ON r.id = c.register_id
            LEFT JOIN "user" u ON u.id = r.taken_by
            WHERE c.grp_id = ${q.grp_id} AND c.date = ${q.date} AND c.grp_subject_id = ${subj}`,
      );
      const roster = await db.all<{
        student_id: string;
        name: string;
        roll_no: string | null;
        admission_no: string;
        photo_key: string | null;
        status: MarkStatus | null;
        note: string | null;
      }>(
        sql`SELECT st.id AS student_id, st.name, x.roll_no, st.admission_no, st.photo_key,
                   m.status, m.note
            FROM (
              -- Only students enrolled on that date: the roster is what the next save submits, and
              -- the server refuses marks for anyone else (not_enrolled). A student who has since
              -- left keeps their old marks in history and reports.
              SELECT e.student_id, max(e.roll_no) AS roll_no FROM enrolment e
              WHERE e.grp_id = ${q.grp_id} AND ${covers(q.date)} GROUP BY e.student_id
            ) x
            JOIN student st ON st.id = x.student_id
            LEFT JOIN att_mark m ON m.register_id = ${cur?.register_id ?? ''} AND m.student_id = st.id
            ORDER BY CAST(x.roll_no AS INTEGER), x.roll_no IS NULL, st.name`,
      );
      const history = await db.all<
        CountCols & {
          register_id: string;
          taken_at: string;
          received_at: string;
          taken_by_name: string | null;
          kind: string | null;
          reason: string | null;
        }
      >(
        sql`SELECT r.id AS register_id, r.taken_at, r.received_at, u.name AS taken_by_name,
              a.action AS kind, json_extract(a.diff, '$.after.reason') AS reason,
              ${countsSql(sql`r.id`)}
            FROM att_register r LEFT JOIN "user" u ON u.id = r.taken_by
            LEFT JOIN audit a ON a.entity = 'att_register' AND a.entity_id = r.id
            WHERE r.grp_id = ${q.grp_id} AND r.date = ${q.date} AND r.grp_subject_id = ${subj}
            ORDER BY r.taken_at DESC, r.received_at DESC`,
      );
      const body: RegisterResponse = {
        grp_id: g.id,
        grp_name: g.name,
        programme_name: g.programme_name,
        date: q.date,
        grp_subject_id: subj,
        day_off: await dayOff(db, q.date, settings),
        rows: roster.map((r) => ({
          student_id: r.student_id,
          name: r.name,
          roll_no: r.roll_no,
          admission_no: r.admission_no,
          has_photo: !!r.photo_key,
          status: r.status,
          note: r.note,
        })),
        current: cur
          ? {
              register_id: cur.register_id,
              taken_at: cur.taken_at,
              taken_by_name: cur.taken_by_name,
            }
          : null,
        history: history.map((h) => ({
          register_id: h.register_id,
          taken_by_name: h.taken_by_name,
          taken_at: h.taken_at,
          received_at: h.received_at,
          is_current: h.register_id === cur?.register_id,
          kind: h.kind === 'correct' ? 'correct' : 'sync',
          reason: h.reason,
          counts: toCounts(h),
        })),
      };
      return c.json(body);
    },
  );

  // ---- One student's days and % -------------------------------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/attendance/student/:id', access: read },
    async (c) => {
      const db = c.get('db');
      const id = idParam(c);
      const scope = await scopeOf(c);
      const [st] = await db.all<{ id: string }>(
        sql`SELECT s.id FROM student s WHERE s.id = ${id} AND ${studentFilter(sql`s.id`, scope) ?? sql`1`}`,
      );
      if (!st) throw notFoundError('Student');
      const q = queryParams(c, rangeQuery);
      const today = todayPk();
      const to = q.to ?? today;
      const from = q.from ?? `${to.slice(0, 7)}-01`;
      if (from > to) throw new ApiError(400, 'invalid', 'from: after to');
      // Only registers of groups (or subjects) in the caller's scope: a teacher sees their own
      // class's days, not the student's other batches.
      const days = await db.all<{
        date: string;
        grp_id: string;
        grp_subject_id: string;
        status: MarkStatus;
        note: string | null;
      }>(
        sql`SELECT c.date, c.grp_id, c.grp_subject_id, m.status, m.note
            FROM current_register c JOIN att_mark m ON m.register_id = c.register_id
            WHERE m.student_id = ${id} AND c.date BETWEEN ${from} AND ${to}
              AND ${registerFilter(sql`c.grp_id`, sql`c.grp_subject_id`, scope)}
            ORDER BY c.date, c.grp_subject_id`,
      );
      const counts = emptyCounts();
      for (const d of days) counts[d.status]++;
      const body: StudentAttendanceResponse = {
        student_id: id,
        from,
        to,
        days,
        counts,
        pct: presentPct(counts),
      };
      return c.json(body);
    },
  );

  // ---- Monthly register (JSON or CSV) ------------------------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/attendance/report', access: read },
    async (c) => {
      const db = c.get('db');
      const q = queryParams(c, reportQuery);
      const subj = q.grp_subject_id ?? WHOLE_DAY;
      assertInScope(await scopeOf(c), q.grp_id);
      const g = await groupRow(db, q.grp_id);
      const dates = monthDays(q.month);
      const first = dates[0] ?? '';
      const last = dates.at(-1) ?? '';
      const settings = await schoolAttendance(db);
      const holidays = await holidaysIn(db, dates);
      const students = await db.all<{ student_id: string; name: string; roll_no: string | null }>(
        sql`SELECT st.id AS student_id, st.name, max(e.roll_no) AS roll_no
            FROM enrolment e JOIN student st ON st.id = e.student_id
            WHERE e.grp_id = ${q.grp_id} AND e.start_date <= ${last}
              AND (e.end_date IS NULL OR e.end_date >= ${first})
              AND (e.status = 'active' OR e.end_date IS NOT NULL)
            GROUP BY st.id ORDER BY CAST(max(e.roll_no) AS INTEGER), st.name`,
      );
      const marks = await db.all<{ date: string; student_id: string; status: MarkStatus }>(
        sql`SELECT c.date, m.student_id, m.status
            FROM current_register c JOIN att_mark m ON m.register_id = c.register_id
            WHERE c.grp_id = ${q.grp_id} AND c.grp_subject_id = ${subj}
              AND c.date BETWEEN ${first} AND ${last}`,
      );
      const taken = new Set(marks.map((m) => m.date));
      const cell = new Map(marks.map((m) => [`${m.student_id}|${m.date}`, m.status]));
      const days: ReportDay[] = dates.map((d) => ({
        date: d,
        day_off: holidays.has(d)
          ? 'holiday'
          : settings.weeklyOff.includes(weekdayOf(d))
            ? 'weekly_off'
            : null,
        taken: taken.has(d),
      }));
      const nonSchool = days.filter((d) => d.day_off).map((d) => d.date);
      const now = todayPk();
      const report: AttendanceReport = {
        grp_id: g.id,
        grp_name: g.name,
        programme_name: g.programme_name,
        month: q.month,
        grp_subject_id: subj,
        class_teacher_name: g.class_teacher_name,
        days,
        non_school_days: nonSchool,
        working_days: days.filter((d) => !d.day_off && d.date <= now).length,
        rows: students.map((s) => {
          const counts = emptyCounts();
          const cells = dates.map((d) => {
            const st = cell.get(`${s.student_id}|${d}`);
            if (st) counts[st]++;
            return st ?? '–';
          });
          return { ...s, cells, counts, pct: presentPct(counts) };
        }),
      };
      if (q.format !== 'csv') return c.json(report);
      const label = groupLabel(g.programme_name, g.name);
      const lines = [
        toCsvLine([label, q.month]),
        toCsvLine([
          'Roll',
          'Name',
          ...dates.map((d) => d.slice(8)),
          ...MARK_STATUSES.map((st) => MARK_CODE[st]),
          '%',
        ]),
        // A day with no mark is a blank cell (not '–'), so the sheet sums and filters cleanly.
        ...report.rows.map((r) =>
          toCsvLine([
            r.roll_no,
            r.name,
            ...r.cells.map((x) => MARK_CODE[x as MarkStatus] ?? ''),
            r.counts.P,
            r.counts.A,
            r.counts.L,
            r.counts.E,
            r.pct,
          ]),
        ),
      ];
      const file = `attendance-${label.replace(/[^\w-]+/g, '_')}-${q.month}.csv`;
      return c.body(`﻿${lines.join('\r\n')}\r\n`, 200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${file}"`,
      });
    },
  );

  // ---- Dashboard "today" (PLAN §14.11) ------------------------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/dashboard/today', access: read },
    async (c) => {
      const db = c.get('db');
      const date = todayPk();
      const scope = await scopeOf(c);
      const settings = await schoolAttendance(db);
      const items = await todayItems(db, scope, date, settings);
      const ids = [...new Set(items.map((i) => i.grp_id))];
      const absentees = ids.length
        ? await db.all<AbsenteeDto & { programme_name: string }>(
            sql`SELECT st.id AS student_id, st.family_id, st.name, g.id AS grp_id, g.name AS grp_name,
                  p.name AS programme_name, m.status,
                  gd.name AS guardian_name, COALESCE(gd.whatsapp, gd.phone) AS guardian_phone
                FROM current_register c
                JOIN att_mark m ON m.register_id = c.register_id AND m.status = 'A'
                JOIN student st ON st.id = m.student_id
                JOIN grp g ON g.id = c.grp_id JOIN programme p ON p.id = g.programme_id
                LEFT JOIN guardian gd ON gd.id = (
                  SELECT g2.id FROM guardian g2 WHERE g2.family_id = st.family_id
                  ORDER BY g2.priority, g2.created_at, g2.id LIMIT 1)
                WHERE c.date = ${date} AND ${inJson(sql`c.grp_id`, ids)}
                GROUP BY st.id ORDER BY p.seq, g.name, st.name`,
          )
        : [];
      const [queued] = await db.all<{ n: number }>(
        sql`SELECT count(*) AS n FROM message msg
            WHERE msg.status = 'queued' AND msg.template_key = 'absence'
              AND json_extract(msg.payload, '$.date') = ${date} AND ${messageScopeSql(scope)}`,
      );
      const body: DashboardTodayResponse = {
        date,
        day_off: await dayOff(db, date, settings),
        registers: {
          total: items.length,
          taken: items.filter((i) => i.status === 'taken').length,
          not_taken: items.filter((i) => i.status === 'not_taken'),
        },
        absentees: absentees.map(({ programme_name, ...a }) => ({
          ...a,
          grp_name: groupLabel(programme_name, a.grp_name),
        })),
        queued_absence_messages: Number(queued?.n ?? 0),
        billing_alerts: (await failingGroups(db, date.slice(0, 7))).filter(
          (f) => f.attention_required,
        ).length,
      };
      return c.json(body);
    },
  );

  // ---- Holidays and the weekly day off (settings) ---------------------------------------------
  defineRoute(
    app,
    table,
    { method: 'GET', path: '/api/holidays', access: requires('catalog', 'read') },
    async (c) => {
      const rows = await c.get('db').select().from(holiday).orderBy(asc(holiday.date));
      const items: HolidayDto[] = rows.map((h) => ({
        date: h.date,
        name_en: h.nameEn,
        name_ur: h.nameUr,
      }));
      return c.json({ items });
    },
  );

  defineRoute(app, table, { method: 'POST', path: '/api/holidays', access: manage }, async (c) => {
    const input = await jsonBody(c, holidayInputSchema);
    const db = c.get('db');
    const [before] = await db.select().from(holiday).where(eq(holiday.date, input.date));
    const values = { nameEn: input.name_en, nameUr: input.name_ur ?? null };
    // Saving the same date again renames it (one holiday per date).
    await tx(db, [
      sql`INSERT INTO holiday (date, name_en, name_ur, created_by)
          VALUES (${input.date}, ${values.nameEn}, ${values.nameUr}, ${userId(c)})
          ON CONFLICT (date) DO UPDATE SET name_en = excluded.name_en, name_ur = excluded.name_ur`,
      auditSql({
        id: newId(),
        userId: userId(c),
        entity: 'holiday',
        entityId: input.date,
        action: before ? 'update' : 'create',
        before: before ? { nameEn: before.nameEn, nameUr: before.nameUr } : null,
        after: values,
      }),
    ]);
    const body: HolidayDto = { date: input.date, name_en: values.nameEn, name_ur: values.nameUr };
    return c.json(body, before ? 200 : 201);
  });

  defineRoute(
    app,
    table,
    { method: 'DELETE', path: '/api/holidays/:date', access: manage },
    async (c) => {
      const date = c.req.param('date') ?? '';
      const db = c.get('db');
      const [before] = await db.select().from(holiday).where(eq(holiday.date, date));
      if (!before) throw notFoundError('Holiday');
      await tx(db, [
        sql`DELETE FROM holiday WHERE date = ${date}`,
        auditSql({
          id: newId(),
          userId: userId(c),
          entity: 'holiday',
          entityId: date,
          action: 'delete',
          before: { nameEn: before.nameEn, nameUr: before.nameUr },
        }),
      ]);
      return c.json({ ok: true });
    },
  );

  defineRoute(
    app,
    table,
    { method: 'PUT', path: '/api/school/attendance', access: manage },
    async (c) => {
      const input = await jsonBody(c, attendanceSettingsSchema);
      const db = c.get('db');
      const [row] = await db.select().from(school).orderBy(asc(school.createdAt)).limit(1);
      if (!row) throw new ApiError(409, 'no_school', 'Save the school profile first');
      if (input.weekly_off.length > 6)
        throw new ApiError(400, 'invalid', 'weekly_off: at least one school day');
      const values = {
        attendanceMode: input.attendance_mode,
        weeklyOff: JSON.stringify(input.weekly_off),
      };
      const diff = changed(row, values);
      if (diff) {
        await tx(db, [
          db.update(school).set(values).where(eq(school.id, row.id)),
          auditSql({
            id: newId(),
            userId: userId(c),
            entity: 'school',
            entityId: row.id,
            action: 'attendance_settings',
            ...diff,
          }),
        ]);
      }
      const [after] = await db.select().from(school).where(eq(school.id, row.id));
      return c.json({ school: after ? schoolDto(after) : null });
    },
  );
}

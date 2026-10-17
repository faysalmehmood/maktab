import { type AppDb, holiday, school } from '@maktab/db';
import {
  type AttendanceMode,
  type AttendanceSyncResult,
  type attendanceSubmissionSchema,
  type DayOff,
  groupLabel,
  MAX_CLOCK_SKEW_MS,
  MAX_MARKS_PER_SYNC,
  type MarkCounts,
  newId,
  PK_MOBILE_GLOB,
  type SyncRejectCode,
  weekdayOf,
} from '@maktab/shared';
import { asc, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type GroupScope, mayWriteRegister } from '../perm/scope';
import { dbConflict } from './errors';
import { todayPk } from './http';
import { isTransientD1Error } from './retry';
import { tx } from './tx';

/** A constant (not a bound parameter: the request budget counts those). */
const MOBILE = sql.raw(`'${PK_MOBILE_GLOB}'`);

/**
 * The attendance write path (PLAN §5.1, §12 exp6, §14.3). One function serves the teacher's sync
 * and the office correction, so both obey the same validation, pointer rule and absence queue.
 *
 * Per submission, inside the request's batch:
 *   1. INSERT OR IGNORE the register by client_id, stamped with this request's nonce
 *   2. marks via json_each slices of ≤ 100 (only if step 1 created the row; the guard is repeated
 *      on every slice)
 *   3. pointer upsert that moves only when the new taken_at is later (client time, not arrival;
 *      clamped to server now, and a clock more than 5 min ahead is refused as clock_skew)
 *   4. the audit row, whose `after.status` records what happened; it is read back afterwards
 *   5. the absence queue for today's absentees, one row per family per day (reminder_state):
 *      `wa_manual` to the first consenting guardian with a number, otherwise `call`
 * The nonce is what lets a statement tell "this call created the register" from "a replay already
 * did" without read-then-write, and it makes the transient-error retry replay byte-identical.
 *
 * Budget (PLAN §15): a request carries ≤ 200 marks. Marks + absentee rows above 200 put step 5 of
 * every register into a second batch of the same request (never more than two). That batch is
 * best-effort: the register is already saved, and the queue is a prompt for the office — M5 rebuilds
 * each absence message from the current registers at send time anyway (see absenceStatements).
 */

type Submission = z.output<typeof attendanceSubmissionSchema>;

export type ApplyInput = Submission & { reason?: string | null };

export type SchoolAttendance = { mode: AttendanceMode; weeklyOff: number[] };

export async function schoolAttendance(db: AppDb): Promise<SchoolAttendance> {
  const [row] = await db
    .select({ mode: school.attendanceMode, weeklyOff: school.weeklyOff })
    .from(school)
    .orderBy(asc(school.createdAt))
    .limit(1);
  return { mode: row?.mode ?? 'daily', weeklyOff: parseWeeklyOff(row?.weeklyOff) };
}

export function parseWeeklyOff(raw: string | null | undefined): number[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[0]');
    return Array.isArray(v) ? v.filter((d): d is number => Number.isInteger(d)) : [0];
  } catch {
    return [0];
  }
}

export async function holidaysIn(db: AppDb, dates: string[]): Promise<Map<string, DayOff>> {
  if (!dates.length) return new Map();
  const rows = await db
    .select()
    .from(holiday)
    .where(sql`${holiday.date} IN (SELECT value FROM json_each(${JSON.stringify(dates)}))`);
  return new Map(
    rows.map((h) => [h.date, { kind: 'holiday', name_en: h.nameEn, name_ur: h.nameUr }]),
  );
}

export async function dayOff(
  db: AppDb,
  date: string,
  settings: SchoolAttendance,
): Promise<DayOff | null> {
  const h = (await holidaysIn(db, [date])).get(date);
  if (h) return h;
  return settings.weeklyOff.includes(weekdayOf(date)) ? { kind: 'weekly_off' } : null;
}

export const emptyCounts = (): MarkCounts => ({ P: 0, A: 0, L: 0, E: 0 });

const inJson = (col: SQL, values: string[]) =>
  sql`${col} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;

type Rejection = { code: SyncRejectCode; message: string };

type GroupInfo = { id: string; label: string };

/** Everything that can be decided before writing, for all submissions at once (≈6 reads). */
async function validate(
  db: AppDb,
  subs: ApplyInput[],
  scope: GroupScope,
  today: string,
  clock: { kind: 'sync' | 'correct'; nowMs: number },
): Promise<{ rejections: Map<number, Rejection>; groups: Map<string, GroupInfo> }> {
  const rejections = new Map<number, Rejection>();
  if (!subs.length) return { rejections, groups: new Map() };
  const reject = (i: number, code: SyncRejectCode, message: string) => {
    if (!rejections.has(i)) rejections.set(i, { code, message });
  };
  const grpIds = [...new Set(subs.map((s) => s.grp_id))];
  const groupRows = await db.all<{ id: string; name: string; programme_name: string }>(
    sql`SELECT g.id, g.name, p.name AS programme_name FROM grp g
        JOIN programme p ON p.id = g.programme_id WHERE ${inJson(sql`g.id`, grpIds)}`,
  );
  const groups = new Map(
    groupRows.map((g) => [g.id, { id: g.id, label: groupLabel(g.programme_name, g.name) }]),
  );
  const subjectRows = await db.all<{ id: string; grp_id: string }>(
    sql`SELECT id, grp_id FROM grp_subject WHERE ${inJson(sql`grp_id`, grpIds)}`,
  );
  const subjectsOf = new Map<string, Set<string>>();
  for (const r of subjectRows) {
    const set = subjectsOf.get(r.grp_id) ?? new Set<string>();
    set.add(r.id);
    subjectsOf.set(r.grp_id, set);
  }
  const settings = await schoolAttendance(db);
  const holidays = await holidaysIn(db, [...new Set(subs.map((s) => s.date))]);

  /** The first rule a submission breaks, in the order a teacher would want to hear it. */
  const firstProblem = (s: ApplyInput): Rejection | null => {
    if (!groups.has(s.grp_id)) return { code: 'unknown_group', message: 'Group not found' };
    if (scope.kind === 'groups' && !scope.ids.includes(s.grp_id))
      return { code: 'forbidden', message: 'Not one of your groups' };
    if (!mayWriteRegister(scope, s.grp_id, s.grp_subject_id))
      return { code: 'forbidden', message: 'Only the register of a subject you teach' };
    const subjects = subjectsOf.get(s.grp_id) ?? new Set<string>();
    if (s.grp_subject_id && !subjects.has(s.grp_subject_id))
      return { code: 'unknown_subject', message: 'Subject is not taught in this group' };
    if (settings.mode === 'daily' && s.grp_subject_id)
      return { code: 'wrong_mode', message: 'The school takes one register per day' };
    if (settings.mode === 'per_subject' && !s.grp_subject_id && subjects.size)
      return { code: 'wrong_mode', message: 'The school takes one register per subject' };
    // future_date before holiday / weekly_off on purpose: it is the stronger rule (a register for
    // tomorrow is wrong whatever tomorrow is), so a future holiday answers future_date.
    if (s.date > today)
      return { code: 'future_date', message: `${s.date} is after today (${today})` };
    // The office correction is stamped by the server; only a phone's clock can be wrong.
    if (clock.kind === 'sync' && Date.parse(s.taken_at) > clock.nowMs + MAX_CLOCK_SKEW_MS)
      return { code: 'clock_skew', message: "The phone's clock is ahead of the school's; fix it" };
    const h = holidays.get(s.date);
    if (h?.kind === 'holiday') return { code: 'holiday', message: `Holiday: ${h.name_en}` };
    if (settings.weeklyOff.includes(weekdayOf(s.date)))
      return { code: 'weekly_off', message: 'School is closed on this weekday' };
    return null;
  };
  subs.forEach((s, i) => {
    const problem = firstProblem(s);
    if (problem) reject(i, problem.code, problem.message);
  });

  // Every marked student must have an enrolment in that group covering that date.
  const triples = subs.flatMap((s, i) =>
    rejections.has(i) ? [] : s.marks.map((m) => ({ i, g: s.grp_id, s: m.student_id, d: s.date })),
  );
  if (triples.length) {
    const rows = await db.all<{ k: number; covering: number; first_start: string | null }>(
      sql`SELECT j.key AS k,
            (SELECT count(*) FROM enrolment e
              WHERE e.grp_id = json_extract(j.value, '$.g') AND e.student_id = json_extract(j.value, '$.s')
                AND e.start_date <= json_extract(j.value, '$.d')
                AND (e.end_date IS NULL OR e.end_date >= json_extract(j.value, '$.d'))
                AND (e.status = 'active' OR e.end_date IS NOT NULL)) AS covering,
            (SELECT min(e.start_date) FROM enrolment e
              WHERE e.grp_id = json_extract(j.value, '$.g')
                AND e.student_id = json_extract(j.value, '$.s')) AS first_start
          FROM json_each(${JSON.stringify(triples)}) j`,
    );
    for (const r of rows) {
      if (Number(r.covering) > 0) continue;
      const t = triples[Number(r.k)];
      if (!t) continue;
      if (r.first_start && r.first_start > t.d)
        reject(t.i, 'before_enrolment', `Student ${t.s} joined this group on ${r.first_start}`);
      else reject(t.i, 'not_enrolled', `Student ${t.s} is not enrolled in this group on ${t.d}`);
    }
  }
  return { rejections, groups };
}

type Planned = {
  index: number;
  sub: ApplyInput;
  regId: string;
  auditId: string;
  /** Register, marks, pointer, audit: always one batch. */
  core: SQL[];
  /** Absence queue rows (step 5); a second batch when the request is over the row budget. */
  alerts: SQL[];
  /** Message ids reserved for this register's absentees (one per absent student, min per family). */
  messageIds: string[];
  /** Rows this register writes: marks + absentees (the PLAN §15 budget). */
  rows: number;
};

/** Marks per json_each statement: half the request budget, so a 200-mark register is two slices. */
const MARK_SLICE = 100;

/**
 * Absence queue rows for one register (PLAN §14.3, §14.9): one per family per day, whichever group
 * or register its children were marked absent in first.
 *   wa_manual  the first guardian (by priority) with WhatsApp consent and a number
 *   call       no such guardian (no consent, or consent but no number): the office phones the first
 *              guardian with a number (guardian_id NULL if the family has no guardian at all)
 *
 * The row is a prompt, not the message text. M5 MUST rebuild each queued absence message from the
 * current registers at send time: skip it if none of the family's children is still absent (a later
 * register or a correction may have marked them present) and merge siblings absent in other groups
 * the same day into one message — the payload here only records the first register that queued it.
 */
function absenceStatements(
  s: ApplyInput,
  ctx: { uid: string; regId: string; groupLabel: string; mine: SQL },
  absentJson: string,
): SQL[] {
  const firstWith = (cond: SQL) => sql`(SELECT g2.id FROM guardian g2
      WHERE g2.family_id = st.family_id AND ${cond}
      ORDER BY g2.priority, g2.created_at, g2.id LIMIT 1)`;
  const hasNumber = sql`COALESCE(NULLIF(g2.whatsapp, ''), NULLIF(g2.phone, '')) IS NOT NULL`;
  // WhatsApp only to a mobile (shared isPkMobile's SQL twin); a landline-only guardian is a call row.
  const hasMobile = sql`(g2.whatsapp GLOB ${MOBILE} OR g2.phone GLOB ${MOBILE})`;
  return [
    sql`INSERT INTO message (id, family_id, guardian_id, channel, template_key, lang, payload,
                             status, created_by)
        SELECT x.mid, x.family_id, COALESCE(x.wa, x.callg),
               CASE WHEN x.wa IS NOT NULL THEN 'wa_manual' ELSE 'call' END, 'absence',
               COALESCE((SELECT lang FROM guardian WHERE id = COALESCE(x.wa, x.callg)), 'ur'),
               x.payload, 'queued', ${ctx.uid}
        FROM (
          SELECT min(json_extract(j.value, '$.m')) AS mid, st.family_id,
                 ${firstWith(sql`g2.consent_whatsapp = 1 AND ${hasMobile}`)} AS wa,
                 COALESCE(${firstWith(hasNumber)}, ${firstWith(sql`1`)}) AS callg,
                 json_object('student_ids', json_group_array(st.id),
                             'student_names', json_group_array(st.name),
                             'date', ${s.date}, 'grp_id', ${s.grp_id},
                             'grp_name', ${ctx.groupLabel}, 'register_id', ${ctx.regId}) AS payload
          FROM json_each(${absentJson}) j
          JOIN student st ON st.id = json_extract(j.value, '$.s')
          WHERE ${ctx.mine}
            AND EXISTS (SELECT 1 FROM current_register c WHERE c.register_id = ${ctx.regId})
            AND NOT EXISTS (SELECT 1 FROM reminder_state rs WHERE rs.family_id = st.family_id
                            AND rs.template_key = 'absence' AND rs.last_sent_on >= ${s.date})
          GROUP BY st.family_id
        ) x`,
    sql`INSERT INTO reminder_state (family_id, template_key, last_sent_on)
        SELECT DISTINCT family_id, 'absence', ${s.date} FROM message
        WHERE id IN (SELECT json_extract(value, '$.m') FROM json_each(${absentJson}))
        ON CONFLICT (family_id, template_key) DO UPDATE SET last_sent_on = excluded.last_sent_on
          WHERE excluded.last_sent_on > reminder_state.last_sent_on`,
  ];
}

/** The statements for one submission (see the header comment for the order and why). */
function plan(
  index: number,
  s: ApplyInput & { client_taken_at: string },
  ctx: {
    uid: string;
    nonce: string;
    today: string;
    group: GroupInfo;
    kind: 'sync' | 'correct';
    now: string;
  },
): Planned {
  const regId = newId();
  const auditId = newId();
  const key = sql`grp_id = ${s.grp_id} AND date = ${s.date} AND grp_subject_id = ${s.grp_subject_id}`;
  // A correction is stamped by the server and must become current even if a phone with a fast
  // clock submitted "later": max(now, current + 1 ms). A sync's taken_at was already clamped to now.
  const takenAt =
    ctx.kind === 'correct'
      ? sql`(SELECT CASE WHEN max(taken_at) >= ${ctx.now}
                 THEN strftime('%Y-%m-%dT%H:%M:%fZ', max(taken_at), '+0.001 seconds')
                 ELSE ${ctx.now} END
             FROM current_register WHERE ${key})`
      : sql`${s.taken_at}`;
  const mine = sql`EXISTS (SELECT 1 FROM att_register WHERE id = ${regId} AND batch_token = ${ctx.nonce})`;
  const absent = s.marks
    .filter((m) => m.status === 'A')
    .map((m) => ({ s: m.student_id, m: newId() }));
  const absentJson = JSON.stringify(absent);

  const core: SQL[] = [
    sql`INSERT OR IGNORE INTO att_register
          (id, client_id, grp_id, date, grp_subject_id, taken_by, taken_at, batch_token)
        VALUES (${regId}, ${s.client_id}, ${s.grp_id}, ${s.date}, ${s.grp_subject_id}, ${ctx.uid},
                ${takenAt}, ${ctx.nonce})`,
  ];
  for (let i = 0; i < s.marks.length; i += MARK_SLICE) {
    const slice = JSON.stringify(
      s.marks
        .slice(i, i + MARK_SLICE)
        .map((m) => ({ s: m.student_id, st: m.status, n: m.note ?? null })),
    );
    core.push(
      sql`INSERT OR IGNORE INTO att_mark (register_id, student_id, status, note)
          SELECT ${regId}, json_extract(j.value, '$.s'), json_extract(j.value, '$.st'),
                 json_extract(j.value, '$.n')
          FROM json_each(${slice}) j WHERE ${mine}`,
    );
  }
  core.push(
    sql`INSERT INTO current_register (grp_id, date, grp_subject_id, register_id, taken_at)
        SELECT grp_id, date, grp_subject_id, id, taken_at FROM att_register
        WHERE id = ${regId} AND batch_token = ${ctx.nonce}
        ON CONFLICT (grp_id, date, grp_subject_id) DO UPDATE
          SET register_id = excluded.register_id, taken_at = excluded.taken_at
          WHERE excluded.taken_at > current_register.taken_at`,
    sql`INSERT OR IGNORE INTO audit (id, user_id, entity, entity_id, action, diff)
        SELECT ${auditId}, ${ctx.uid}, 'att_register', r.id, ${ctx.kind},
          json_object('before', NULL, 'after', json_object(
            'status', CASE
              WHEN NOT EXISTS (SELECT 1 FROM current_register c WHERE c.register_id = r.id) THEN 'stale'
              WHEN EXISTS (SELECT 1 FROM att_register o WHERE o.grp_id = r.grp_id AND o.date = r.date
                           AND o.grp_subject_id = r.grp_subject_id AND o.id <> r.id) THEN 'replaced'
              ELSE 'applied' END,
            'client_id', r.client_id, 'grp_id', r.grp_id, 'date', r.date,
            'grp_subject_id', r.grp_subject_id, 'taken_at', r.taken_at,
            'client_taken_at', ${s.client_taken_at},
            'marks', ${s.marks.length}, 'absent', ${absent.length},
            'reason', ${s.reason ?? null}))
        FROM att_register r WHERE r.id = ${regId} AND r.batch_token = ${ctx.nonce}`,
  );

  // Absence alerts only for today's register, only when it became current, and at most one row
  // per family per day across every register and group (reminder_state is the cooldown).
  const alerts =
    s.date === ctx.today && absent.length
      ? absenceStatements(s, { uid: ctx.uid, regId, groupLabel: ctx.group.label, mine }, absentJson)
      : [];
  return {
    index,
    sub: s,
    regId,
    auditId,
    core,
    alerts,
    messageIds: alerts.length ? absent.map((a) => a.m) : [],
    rows: s.marks.length + absent.length,
  };
}

/**
 * Writes planned registers in at most two batches (PLAN §15): everything in one when marks +
 * absentee rows fit in 200, else the registers first and every absence queue row second. Throws
 * only what the caller must see (transient errors and a failed register batch).
 */
async function writePlanned(db: AppDb, planned: Planned[]): Promise<void> {
  const rows = planned.reduce((n, p) => n + p.rows, 0);
  const alerts = planned.flatMap((p) => p.alerts);
  if (rows <= MAX_MARKS_PER_SYNC || !alerts.length) {
    await tx(
      db,
      planned.flatMap((p) => [...p.core, ...p.alerts]),
    );
    return;
  }
  await tx(
    db,
    planned.flatMap((p) => p.core),
  );
  try {
    await tx(db, alerts);
  } catch (err) {
    // The registers are saved; a lost queue row is recovered by M5's rebuild-at-send-time and the
    // dashboard's absentee list (computed from registers). Never turn a saved register into a 5xx.
    console.warn('attendance: absence queue batch failed', describe(err));
  }
}

type Outcome = { status: 'applied' | 'replaced' | 'stale'; queued: number };

/** What each planned register became (its audit row) and how many queue rows it added. */
async function readOutcomes(db: AppDb, planned: Planned[]): Promise<Map<string, Outcome>> {
  if (!planned.length) return new Map();
  const rows = await db.all<{ id: string; status: Outcome['status'] }>(
    sql`SELECT id, json_extract(diff, '$.after.status') AS status
        FROM audit WHERE ${inJson(
          sql`id`,
          planned.map((p) => p.auditId),
        )}`,
  );
  const messageIds = planned.flatMap((p) => p.messageIds);
  const queued = messageIds.length
    ? await db.all<{ register_id: string; n: number }>(
        sql`SELECT json_extract(payload, '$.register_id') AS register_id, count(*) AS n
            FROM message WHERE ${inJson(sql`id`, messageIds)} GROUP BY 1`,
      )
    : [];
  const queuedBy = new Map(queued.map((q) => [q.register_id, Number(q.n)]));
  const regOf = new Map(planned.map((p) => [p.auditId, p.regId]));
  return new Map(
    rows.map((r) => [r.id, { status: r.status, queued: queuedBy.get(regOf.get(r.id) ?? '') ?? 0 }]),
  );
}

async function registersByClientId(db: AppDb, clientIds: string[]) {
  if (!clientIds.length) return new Map<string, string>();
  const rows = await db.all<{ id: string; client_id: string }>(
    sql`SELECT id, client_id FROM att_register WHERE ${inJson(sql`client_id`, clientIds)}`,
  );
  return new Map(rows.map((r) => [r.client_id, r.id]));
}

/**
 * Applies already-parsed submissions; returns one result per input, in order. Only throws on a
 * transient database failure (the caller answers 5xx and the outbox retries).
 */
export async function applySubmissions(
  db: AppDb,
  subs: ApplyInput[],
  opts: { uid: string; scope: GroupScope; kind: 'sync' | 'correct'; now?: Date },
): Promise<AttendanceSyncResult[]> {
  const nowDate = opts.now ?? new Date();
  const today = todayPk(nowDate);
  const now = nowDate.toISOString();
  // Comparable strings: "08:00:00Z" sorts after "08:00:00.500Z", so normalise to milliseconds.
  // The raw client value is kept for the audit row.
  const normalised = subs.map((s) => ({
    ...s,
    client_taken_at: s.taken_at,
    taken_at: new Date(s.taken_at).toISOString(),
  }));
  const results: (AttendanceSyncResult | undefined)[] = normalised.map(() => undefined);

  // Replays are answered before validation: a register accepted yesterday stays accepted even if
  // the date has since been made a holiday.
  const existing = await registersByClientId(
    db,
    normalised.map((s) => s.client_id),
  );
  const firstIndex = new Map<string, number>();
  normalised.forEach((s, i) => {
    const reg = existing.get(s.client_id);
    if (reg) results[i] = { client_id: s.client_id, status: 'duplicate', register_id: reg };
    else if (firstIndex.has(s.client_id))
      results[i] = { client_id: s.client_id, status: 'duplicate' };
    else firstIndex.set(s.client_id, i);
  });

  const todo = normalised.map((s, i) => ({ s, i })).filter(({ i }) => !results[i]);
  const nowMs = nowDate.getTime();
  const { rejections, groups } = await validate(
    db,
    todo.map((t) => t.s),
    opts.scope,
    today,
    { kind: opts.kind, nowMs },
  );
  // A phone clock a little ahead (within MAX_CLOCK_SKEW_MS) is clamped to server now. Several
  // clamped registers in one request keep their client order 1 ms apart, so the later one still wins.
  const ahead = todo
    .filter(({ s }, j) => !rejections.has(j) && s.taken_at > now)
    .sort((a, b) => (a.s.taken_at < b.s.taken_at ? -1 : a.s.taken_at > b.s.taken_at ? 1 : 0));
  const clamped = new Map(
    ahead.map(({ i }, rank) => [i, new Date(nowMs - (ahead.length - 1 - rank)).toISOString()]),
  );
  const nonce = newId();
  const planned: Planned[] = [];
  todo.forEach(({ s, i }, j) => {
    const r = rejections.get(j);
    const group = groups.get(s.grp_id);
    if (r || !group) {
      results[i] = {
        client_id: s.client_id,
        status: 'rejected',
        error: r?.code ?? 'unknown_group',
        message: r?.message ?? 'Group not found',
      };
      return;
    }
    const sub = { ...s, taken_at: clamped.get(i) ?? s.taken_at };
    planned.push(plan(i, sub, { uid: opts.uid, nonce, today, group, kind: opts.kind, now }));
  });

  // Normal case: one request = one batch (two when over the row budget, see writePlanned). If it
  // fails for a non-transient reason, apply one by one so a single bad register cannot block the
  // others.
  const failedAt = new Map<number, string>();
  if (planned.length) {
    try {
      await writePlanned(db, planned);
    } catch (err) {
      if (isTransientD1Error(err)) throw err;
      if (planned.length === 1) failedAt.set(planned[0]?.index ?? -1, describe(err));
      else
        for (const p of planned) {
          try {
            await writePlanned(db, [p]);
          } catch (e) {
            if (isTransientD1Error(e)) throw e;
            failedAt.set(p.index, describe(e));
          }
        }
    }
  }

  const outcomes = await readOutcomes(db, planned);
  for (const p of planned) {
    const fail = failedAt.get(p.index);
    const o = outcomes.get(p.auditId);
    // No audit row = the register INSERT OR IGNORE wrote nothing although the batch succeeded: a
    // constraint swallowed it, or another request stored this client_id between our duplicate
    // check and our batch. Either way this request did not save it; say so (the outbox keeps the
    // entry as failed, and its Retry answers `duplicate` if the other request did store it).
    results[p.index] = fail
      ? { client_id: p.sub.client_id, status: 'rejected', error: 'db_error', message: fail }
      : o
        ? {
            client_id: p.sub.client_id,
            status: o.status,
            register_id: p.regId,
            queued_messages: o.queued,
          }
        : {
            client_id: p.sub.client_id,
            status: 'rejected',
            error: 'db_error',
            message: 'The register was not stored',
          };
  }
  // In-request repeats point at whatever their first copy became.
  normalised.forEach((s, i) => {
    const r = results[i];
    if (r?.status === 'duplicate' && !r.register_id) {
      const first = results[firstIndex.get(s.client_id) ?? -1];
      if (first?.register_id) results[i] = { ...r, register_id: first.register_id };
    }
  });
  return results.map(
    (r, i) =>
      r ?? { client_id: normalised[i]?.client_id ?? null, status: 'rejected', error: 'invalid' },
  );
}

function describe(err: unknown): string {
  return dbConflict(err)?.message ?? 'Could not save this register';
}

// A group's display label ("Class 5 A") lives in @maktab/shared, shared with the printed register.
export { groupLabel };

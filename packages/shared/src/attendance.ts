import { z } from 'zod';
import { idSchema } from './user';

/**
 * Per-request budget (PLAN §8, §15 standing rules): ≤ 200 rows per request. One register carries at
 * most 200 marks (a class bigger than that is split into sections before the pilot); one sync
 * request carries at most 3 registers AND at most 200 marks in total, so the outbox packs requests
 * greedily (a 150-mark register goes alone) and sends a backlog as several requests in one pass.
 */
export const MAX_MARKS_PER_REGISTER = 200;
export const MAX_MARKS_PER_SYNC = 200;
export const MAX_SUBMISSIONS_PER_SYNC = 3;

/**
 * A phone clock more than this far ahead of the server is refused (`clock_skew`), not trusted: the
 * current-register pointer moves by taken_at, so a phone set to 2099 would otherwise win forever.
 * Within the window the server stores min(client taken_at, server now).
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Whole-day registers use this instead of NULL so the (grp, date, subject) key stays unique. */
export const WHOLE_DAY = '';

export const MARK_STATUSES = ['P', 'A', 'L', 'E'] as const;
export const markStatusSchema = z.enum(MARK_STATUSES);
export type MarkStatus = z.infer<typeof markStatusSchema>;

export const isoDateSchema = z.iso.date();
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');

export const attendanceMarkSchema = z.object({
  student_id: idSchema,
  status: markStatusSchema,
  note: z.string().trim().max(200).nullable().optional(),
});

const submissionShape = {
  client_id: idSchema,
  grp_id: idSchema,
  date: isoDateSchema,
  grp_subject_id: z.union([idSchema, z.literal(WHOLE_DAY)]).default(WHOLE_DAY),
  /** Client clock; the current-register pointer only moves forward by this. */
  taken_at: z.iso.datetime(),
  marks: z.array(attendanceMarkSchema).min(1).max(MAX_MARKS_PER_REGISTER),
};

const uniqueStudents = (s: { marks: { student_id: string }[] }) =>
  new Set(s.marks.map((m) => m.student_id)).size === s.marks.length;

export const attendanceSubmissionSchema = z
  .object(submissionShape)
  .refine(uniqueStudents, { message: 'duplicate student in marks', path: ['marks'] });
export type AttendanceSubmission = z.input<typeof attendanceSubmissionSchema>;

/**
 * Office correction (attendance.correct): same register shape, a mandatory reason, and no client
 * clock — the server stamps it so the correction becomes the current register (PLAN §14.3).
 */
export const attendanceCorrectionSchema = z
  .object({
    ...submissionShape,
    taken_at: z.iso.datetime().optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .refine(uniqueStudents, { message: 'duplicate student in marks', path: ['marks'] });
export type AttendanceCorrection = z.input<typeof attendanceCorrectionSchema>;

export const attendanceSyncRequestSchema = z.array(z.unknown()).max(MAX_SUBMISSIONS_PER_SYNC);

/** Marks in a raw sync body (before per-item validation), for the whole-request budget check. */
export const countMarks = (items: readonly unknown[]): number =>
  items.reduce<number>((n, item) => {
    const marks = (item as { marks?: unknown } | null)?.marks;
    return n + (Array.isArray(marks) ? marks.length : 0);
  }, 0);

/** Why a submission was rejected; the web maps each to a translated sentence. */
export const SYNC_REJECT_CODES = [
  'invalid',
  'unknown_group',
  'forbidden',
  'unknown_subject',
  'wrong_mode',
  'future_date',
  'holiday',
  'weekly_off',
  'not_enrolled',
  'before_enrolment',
  'clock_skew',
  'db_error',
] as const;
export type SyncRejectCode = (typeof SYNC_REJECT_CODES)[number];

export const attendanceSyncResultSchema = z.object({
  client_id: z.string().nullable(),
  status: z.enum(['applied', 'replaced', 'duplicate', 'stale', 'rejected']),
  register_id: z.string().optional(),
  /** A SyncRejectCode when rejected. */
  error: z.string().optional(),
  message: z.string().optional(),
  /** Absence messages this submission put in the queue (0 when none or not today). */
  queued_messages: z.number().optional(),
});
export type AttendanceSyncResult = z.infer<typeof attendanceSyncResultSchema>;

export const attendanceSyncResponseSchema = z.object({
  results: z.array(attendanceSyncResultSchema),
});
export type AttendanceSyncResponse = z.infer<typeof attendanceSyncResponseSchema>;

// ---- Settings -----------------------------------------------------------------------------------

export const ATTENDANCE_MODES = ['daily', 'per_subject'] as const;
export const attendanceModeSchema = z.enum(ATTENDANCE_MODES);
export type AttendanceMode = z.infer<typeof attendanceModeSchema>;

/** 0 = Sunday … 6 = Saturday (JS getUTCDay). */
export const weekdaySchema = z.number().int().min(0).max(6);

export const attendanceSettingsSchema = z.object({
  attendance_mode: attendanceModeSchema,
  weekly_off: z
    .array(weekdaySchema)
    .max(6)
    .transform((d) => [...new Set(d)].sort()),
});
export type AttendanceSettingsInput = z.input<typeof attendanceSettingsSchema>;

export const holidayInputSchema = z.object({
  date: isoDateSchema,
  name_en: z.string().trim().min(1).max(80),
  name_ur: z
    .string()
    .trim()
    .max(80)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
});
export type HolidayInput = z.input<typeof holidayInputSchema>;
export type HolidayDto = { date: string; name_en: string; name_ur: string | null };

/** Weekday of an ISO date, independent of the device's timezone. */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Present % (late counts as present; excused is left out of the denominator). Null when no days. */
export function presentPct(c: Record<MarkStatus, number>): number | null {
  const days = c.P + c.A + c.L;
  return days ? Math.round(((c.P + c.L) * 1000) / days) / 10 : null;
}

// ---- Responses ----------------------------------------------------------------------------------

export type MarkCounts = Record<MarkStatus, number>;

/** Why a date has no register to take: a listed holiday or the school's weekly day off. */
export type DayOff =
  | { kind: 'holiday'; name_en: string; name_ur: string | null }
  | { kind: 'weekly_off' };

export type TodayItem = {
  grp_id: string;
  grp_name: string;
  programme_name: string;
  grp_subject_id: string;
  subject_name: string | null;
  class_teacher_name: string | null;
  student_count: number;
  status: 'taken' | 'not_taken';
  register_id: string | null;
  counts: MarkCounts;
  taken_by_name: string | null;
  taken_at: string | null;
};
export type TodayResponse = {
  date: string;
  mode: AttendanceMode;
  day_off: DayOff | null;
  items: TodayItem[];
};

export type RegisterRow = {
  student_id: string;
  name: string;
  roll_no: string | null;
  admission_no: string;
  has_photo: boolean;
  /** Status in the current register; null when not taken yet. */
  status: MarkStatus | null;
  note: string | null;
};
export type RegisterHistoryItem = {
  register_id: string;
  taken_by_name: string | null;
  taken_at: string;
  received_at: string;
  is_current: boolean;
  /** 'sync' (teacher/office save) or 'correct' (office correction with reason). */
  kind: 'sync' | 'correct';
  reason: string | null;
  counts: MarkCounts;
};
export type RegisterResponse = {
  grp_id: string;
  grp_name: string;
  programme_name: string;
  date: string;
  grp_subject_id: string;
  day_off: DayOff | null;
  rows: RegisterRow[];
  current: { register_id: string; taken_by_name: string | null; taken_at: string } | null;
  history: RegisterHistoryItem[];
};

export type StudentAttendanceDay = {
  date: string;
  grp_id: string;
  grp_subject_id: string;
  status: MarkStatus;
  note: string | null;
};
export type StudentAttendanceResponse = {
  student_id: string;
  from: string;
  to: string;
  days: StudentAttendanceDay[];
  counts: MarkCounts;
  pct: number | null;
};

export type ReportDay = { date: string; day_off: 'holiday' | 'weekly_off' | null; taken: boolean };
export type ReportRow = {
  student_id: string;
  roll_no: string | null;
  name: string;
  /** One per day: P/A/L/E, or '–' when no mark (not taken, not enrolled yet, or a day off). */
  cells: string[];
  counts: MarkCounts;
  pct: number | null;
};
export type AttendanceReport = {
  grp_id: string;
  grp_name: string;
  programme_name: string;
  month: string;
  grp_subject_id: string;
  days: ReportDay[];
  rows: ReportRow[];
};

export type MessageDto = {
  id: string;
  family_id: string;
  family_name: string;
  guardian_id: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  channel: string;
  template_key: string;
  lang: 'en' | 'ur';
  status: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export type AbsenteeDto = {
  student_id: string;
  name: string;
  grp_id: string;
  grp_name: string;
  status: MarkStatus;
  guardian_name: string | null;
  guardian_phone: string | null;
};
export type DashboardTodayResponse = {
  date: string;
  day_off: DayOff | null;
  registers: { total: number; taken: number; not_taken: TodayItem[] };
  absentees: AbsenteeDto[];
  queued_absence_messages: number;
};

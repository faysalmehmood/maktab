import { z } from 'zod';
import { idSchema } from './user';

/** Limits proven in experiment 6: one request carries at most 50 registers, a register at most 500 marks. */
export const MAX_SUBMISSIONS_PER_SYNC = 50;
export const MAX_MARKS_PER_REGISTER = 500;

/** Whole-day registers use this instead of NULL so the (grp, date, subject) key stays unique. */
export const WHOLE_DAY = '';

export const markStatusSchema = z.enum(['P', 'A', 'L', 'E']);
export type MarkStatus = z.infer<typeof markStatusSchema>;

export const isoDateSchema = z.iso.date();

export const attendanceMarkSchema = z.object({
  student_id: idSchema,
  status: markStatusSchema,
  note: z.string().max(200).nullable().optional(),
});

export const attendanceSubmissionSchema = z
  .object({
    client_id: idSchema,
    grp_id: idSchema,
    date: isoDateSchema,
    grp_subject_id: z.union([idSchema, z.literal(WHOLE_DAY)]).default(WHOLE_DAY),
    /** Client clock; the current-register pointer only moves forward by this. */
    taken_at: z.iso.datetime(),
    marks: z.array(attendanceMarkSchema).min(1).max(MAX_MARKS_PER_REGISTER),
  })
  .refine((s) => new Set(s.marks.map((m) => m.student_id)).size === s.marks.length, {
    message: 'duplicate student in marks',
    path: ['marks'],
  });
export type AttendanceSubmission = z.input<typeof attendanceSubmissionSchema>;

export const attendanceSyncRequestSchema = z.array(z.unknown()).max(MAX_SUBMISSIONS_PER_SYNC);

export const attendanceSyncResultSchema = z.object({
  client_id: z.string().nullable(),
  status: z.enum(['applied', 'replaced', 'duplicate', 'stale', 'rejected']),
  register_id: z.string().optional(),
  error: z.string().optional(),
});
export type AttendanceSyncResult = z.infer<typeof attendanceSyncResultSchema>;

export const attendanceSyncResponseSchema = z.object({
  results: z.array(attendanceSyncResultSchema),
});
export type AttendanceSyncResponse = z.infer<typeof attendanceSyncResponseSchema>;

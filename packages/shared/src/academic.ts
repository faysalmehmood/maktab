import { z } from 'zod';
import { isoDateSchema } from './attendance';
import { BRAND_COLOR_KEYS, type BrandColor, SHORT_NAME_RE } from './brand';
import { admissionFeesSchema } from './fees';
import { normalizePkMobile, normalizePkPhone } from './phone';
import { idSchema, staffRoleSchema } from './user';

/**
 * Request schemas for milestone 1 (PLAN §5.1, §14.1, §14.2). The API validates every body with
 * these and the web forms use the same ones, so a rule lives in one place. JSON is snake_case.
 * Ids are optional on create: a client may mint the ULID itself so a retried request is a no-op.
 */

/** Trimmed text; empty becomes null so "" never lands in the database. */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();
const reqText = (max: number) => z.string().trim().min(1).max(max);
const optDate = isoDateSchema.nullable().optional();
const optId = idSchema.nullable().optional();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const SCHOOL_MODES = ['school', 'academy', 'both'] as const;
export const schoolModeSchema = z.enum(SCHOOL_MODES);
export type SchoolMode = z.infer<typeof schoolModeSchema>;
export const langSchema = z.enum(['en', 'ur']);

/** Any PK phone (mobile or landline), stored normalised (`923001234567`). */
export const phoneSchema = z.string().transform((s, ctx) => {
  const p = normalizePkPhone(s);
  if (!p) {
    ctx.addIssue({ code: 'custom', message: 'invalid_phone' });
    return z.NEVER;
  }
  return p.number;
});
/** Optional phone: blank → null, otherwise must normalise. */
export const optPhoneSchema = z
  .string()
  .trim()
  .transform((s, ctx) => {
    if (s === '') return null;
    const p = normalizePkPhone(s);
    if (!p) {
      ctx.addIssue({ code: 'custom', message: 'invalid_phone' });
      return z.NEVER;
    }
    return p.number;
  })
  .nullable()
  .optional();

/** Optional PK mobile (WhatsApp needs one; landlines are "call only", exp4). */
export const optMobileSchema = z
  .string()
  .trim()
  .transform((s, ctx) => {
    if (s === '') return null;
    const m = normalizePkMobile(s);
    if (!m) {
      ctx.addIssue({ code: 'custom', message: 'invalid_mobile' });
      return z.NEVER;
    }
    return m;
  })
  .nullable()
  .optional();

export const schoolInputSchema = z.object({
  name: reqText(120),
  name_ur: optText(120),
  mode: schoolModeSchema,
  address: optText(300),
  phone: optPhoneSchema,
  default_lang: langSchema.default('ur'),
  /**
   * Identity (M7b, UI plan §6.1). Omitted (undefined) keeps the saved value, so an older client
   * that PUTs the profile without them never blanks them; null or "" clears.
   */
  short_name: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => s === '' || SHORT_NAME_RE.test(s), 'short_name')
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  city: optText(60),
  brand_color: z
    .enum(BRAND_COLOR_KEYS as [BrandColor, ...BrandColor[]])
    .nullable()
    .optional(),
  /** Placeholder for M3 receipts; stored, not used yet. */
  receipt_prefix: z
    .string()
    .trim()
    .max(8)
    .regex(/^[A-Za-z0-9-]*$/)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  /**
   * Finishing setup is its own action (POST /api/school/complete-setup, owner), never a side
   * effect of saving the profile; a PUT that still carries this flag is refused, not ignored.
   */
  setup_completed: z
    .never({ message: 'use POST /api/school/complete-setup to finish setup' })
    .optional(),
});
export type SchoolInput = z.input<typeof schoolInputSchema>;

const sessionBase = z.object({
  id: idSchema.optional(),
  name: reqText(40),
  start_date: isoDateSchema,
  end_date: isoDateSchema,
  is_current: z.boolean().optional(),
});
export const sessionInputSchema = sessionBase.refine((s) => s.end_date > s.start_date, {
  message: 'end_before_start',
  path: ['end_date'],
});
export const sessionPatchSchema = sessionBase.omit({ id: true }).partial();
export type SessionInput = z.input<typeof sessionInputSchema>;

const termBase = z.object({
  id: idSchema.optional(),
  session_id: idSchema,
  name: reqText(40),
  seq: z.number().int().min(1).max(12),
  start_date: isoDateSchema,
  end_date: isoDateSchema,
});
export const termInputSchema = termBase.refine((s) => s.end_date > s.start_date, {
  message: 'end_before_start',
  path: ['end_date'],
});
export const termPatchSchema = termBase.omit({ id: true, session_id: true }).partial();

export const PROGRAMME_KINDS = ['grade', 'course'] as const;
export const programmeInputSchema = z.object({
  id: idSchema.optional(),
  name: reqText(80),
  kind: z.enum(PROGRAMME_KINDS),
  seq: z.number().int().min(0).max(1000).optional(),
  next_programme_id: optId,
  duration_weeks: z.number().int().min(1).max(520).nullable().optional(),
});
export const programmePatchSchema = programmeInputSchema.omit({ id: true }).partial();
export type ProgrammeInput = z.input<typeof programmeInputSchema>;

export const subjectInputSchema = z.object({
  id: idSchema.optional(),
  name: reqText(80),
  short_name: optText(20),
});
export const subjectPatchSchema = subjectInputSchema.omit({ id: true }).partial();

export const GRP_STATUSES = ['open', 'running', 'closed'] as const;
export const groupSubjectInputSchema = z.object({
  subject_id: idSchema,
  teacher_id: optId,
});
export const groupSubjectsInputSchema = z.object({
  subjects: z
    .array(groupSubjectInputSchema)
    .max(30)
    .refine((a) => new Set(a.map((s) => s.subject_id)).size === a.length, 'duplicate_subject'),
});
const groupBase = z.object({
  id: idSchema.optional(),
  programme_id: idSchema,
  session_id: optId,
  name: reqText(60),
  /** Default: grade programmes are primary (school classes), courses are not (batches). */
  is_primary: z.boolean().optional(),
  class_teacher_id: optId,
  start_date: optDate,
  end_date: optDate,
  capacity: z.number().int().min(1).max(10000).nullable().optional(),
  days: optText(40),
  start_time: time.nullable().optional(),
  end_time: time.nullable().optional(),
  room: optText(40),
  next_grp_id: optId,
  status: z.enum(GRP_STATUSES).optional(),
});
export const groupInputSchema = groupBase.extend({
  subjects: groupSubjectsInputSchema.shape.subjects.optional(),
});
export const groupPatchSchema = groupBase.omit({ id: true }).partial();
export type GroupInput = z.input<typeof groupInputSchema>;

export const staffInviteSchema = z.object({
  email: z
    .email()
    .max(200)
    .transform((e) => e.trim().toLowerCase()),
  role: staffRoleSchema,
  name: optText(100),
  phone: optPhoneSchema,
  /** Job title shown on the staff list ("Maths teacher"); not a permission. */
  title: optText(60),
  /** Create a staff profile too (default yes); class/subject teachers need one. */
  with_profile: z.boolean().default(true),
});
export type StaffInviteInput = z.input<typeof staffInviteSchema>;

export const STAFF_STATUSES = ['active', 'left'] as const;
export const staffInputSchema = z.object({
  id: idSchema.optional(),
  user_id: optId,
  name: reqText(100),
  phone: optPhoneSchema,
  title: optText(60),
  joined: optDate,
  status: z.enum(STAFF_STATUSES).optional(),
});
export const staffPatchSchema = staffInputSchema.omit({ id: true, user_id: true }).partial();

export const rolesInputSchema = z.object({
  roles: z
    .array(staffRoleSchema)
    .max(4)
    .transform((r) => [...new Set(r)]),
});

export const familyInputSchema = z.object({
  id: idSchema.optional(),
  name: reqText(100),
  address: optText(300),
  area: optText(80),
});
export const familyPatchSchema = familyInputSchema.omit({ id: true }).partial();
export type FamilyInput = z.input<typeof familyInputSchema>;

export const guardianFieldsSchema = z.object({
  id: idSchema.optional(),
  name: reqText(100),
  relation: optText(30),
  cnic: z
    .string()
    .trim()
    .transform((s) => s.replace(/-/g, ''))
    .refine((s) => s === '' || /^\d{13}$/.test(s), 'invalid_cnic')
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  phone: phoneSchema,
  /** Blank = same as phone when that is a mobile (PLAN §14.2). */
  whatsapp: optMobileSchema,
  priority: z.number().int().min(1).max(9).optional(),
  consent_whatsapp: z.boolean().default(false),
  consent_sms: z.boolean().default(false),
  lang: langSchema.default('ur'),
});
export const guardianInputSchema = guardianFieldsSchema.extend({ family_id: idSchema });
export const guardianPatchSchema = guardianFieldsSchema.omit({ id: true }).partial();
export type GuardianFields = z.input<typeof guardianFieldsSchema>;

export const STUDENT_STATUSES = ['active', 'left', 'graduated'] as const;
export const customValueSchema = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
export const studentFieldsSchema = z.object({
  name: reqText(100),
  father_name: optText(100),
  dob: optDate,
  gender: z.enum(['m', 'f']).nullable().optional(),
  b_form_no: z
    .string()
    .trim()
    .transform((s) => s.replace(/-/g, ''))
    .refine((s) => s === '' || /^\d{13}$/.test(s), 'invalid_b_form')
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  /** Blank = next `YYYY-NNNN` for the session (PLAN §14.2: auto, editable). */
  admission_no: z
    .string()
    .trim()
    .max(20)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
  admission_date: isoDateSchema,
  /** Values for `custom_field` rows (entity 'student'), keyed by field key. */
  extra: z.record(z.string(), customValueSchema).optional(),
});
export const studentPatchSchema = studentFieldsSchema.partial();
export type StudentFields = z.input<typeof studentFieldsSchema>;

export const studentStatusSchema = z.object({
  status: z.enum(['left', 'graduated']),
  date: isoDateSchema,
  reason: reqText(200),
});

export const enrolmentFieldsSchema = z.object({
  id: idSchema.optional(),
  grp_id: idSchema,
  start_date: isoDateSchema.optional(),
  /** Blank = max + 1 within the group. */
  roll_no: z
    .string()
    .trim()
    .max(10)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional(),
});

/**
 * One admission = one batch (PLAN §14.2): reuse a family (`family_id`, found by guardian phone) or
 * create one (`family`), add guardians, create the student — or re-admit a `left` one
 * (`readmit_student_id`) — and enrol, and bill the first period (`fees`).
 */
export const admissionInputSchema = z
  .object({
    family_id: idSchema.optional(),
    family: familyInputSchema.optional(),
    guardians: z.array(guardianFieldsSchema).max(4).default([]),
    student_id: idSchema.optional(),
    student: studentFieldsSchema.optional(),
    readmit_student_id: idSchema.optional(),
    enrolment: enrolmentFieldsSchema,
    /** First-period charges in the same batch (PLAN §14.2 step 5; M3). */
    fees: admissionFeesSchema.optional(),
  })
  .superRefine((a, ctx) => {
    if (a.readmit_student_id) {
      if (a.student || a.family || a.family_id)
        ctx.addIssue({
          code: 'custom',
          message: 'readmit_takes_only_enrolment',
          path: ['student'],
        });
      return;
    }
    if (!a.student) ctx.addIssue({ code: 'custom', message: 'required', path: ['student'] });
    if (!!a.family_id === !!a.family)
      ctx.addIssue({ code: 'custom', message: 'family_or_family_id', path: ['family'] });
    if (a.family && a.guardians.length === 0)
      ctx.addIssue({ code: 'custom', message: 'guardian_required', path: ['guardians'] });
  });
export type AdmissionInput = z.input<typeof admissionInputSchema>;

export const enrolmentInputSchema = enrolmentFieldsSchema.extend({
  student_id: idSchema,
  start_date: isoDateSchema,
});
export const enrolmentEndSchema = z.object({
  status: z.enum(['withdrawn', 'completed']),
  end_date: isoDateSchema,
  reason: reqText(200),
});
export const enrolmentTransferSchema = z.object({
  new_id: idSchema.optional(),
  grp_id: idSchema,
  date: isoDateSchema,
  reason: reqText(200),
  roll_no: enrolmentFieldsSchema.shape.roll_no,
});

export const CUSTOM_FIELD_ENTITIES = ['student'] as const;
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'bool'] as const;
export const customFieldInputSchema = z.object({
  id: idSchema.optional(),
  entity: z.enum(CUSTOM_FIELD_ENTITIES).default('student'),
  key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/, 'snake_case key'),
  label_en: reqText(60),
  label_ur: optText(60),
  type: z.enum(CUSTOM_FIELD_TYPES),
});
export const customFieldPatchSchema = customFieldInputSchema
  .pick({ label_en: true, label_ur: true })
  .partial();

export const STUDENTS_PAGE_SIZE = 50;
export const studentListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  group: idSchema.optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  family: idSchema.optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});

/** Checks one custom value against its field type; returns an error code or null. */
export function customValueError(
  type: (typeof CUSTOM_FIELD_TYPES)[number],
  value: z.infer<typeof customValueSchema>,
): string | null {
  if (value === null) return null;
  switch (type) {
    case 'text':
      return typeof value === 'string' ? null : 'expected_text';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'expected_number';
    case 'date':
      return typeof value === 'string' && isoDateSchema.safeParse(value).success
        ? null
        : 'expected_date';
    case 'bool':
      return typeof value === 'boolean' ? null : 'expected_bool';
  }
}

/** Server-side cap for uploaded photos; the client resizes to ≤ 100 KB first (PLAN §6). */
export const MAX_PHOTO_BYTES = 200 * 1024;
/** The school logo upload limit (API and the hint under the upload field). */
export const MAX_LOGO_BYTES = 512 * 1024;
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

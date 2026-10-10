import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import { user } from './auth';
import { bool, id, nowIso, oneOf, stamps } from './common';

export const SCHOOL_MODES = ['school', 'academy', 'both'] as const;
export const ATTENDANCE_MODES = ['daily', 'per_subject'] as const;

/** Single-row table: one school per installation (PLAN §2). Not in PLAN §5; the setup wizard needs it. */
export const school = sqliteTable(
  'school',
  {
    id: id(),
    name: text('name').notNull(),
    nameUr: text('name_ur'),
    mode: text('mode', { enum: SCHOOL_MODES }).notNull().default('school'),
    address: text('address'),
    phone: text('phone'),
    defaultLang: text('default_lang', { enum: ['en', 'ur'] })
      .notNull()
      .default('ur'),
    /** R2 key of the uploaded logo (FILES bucket); null = none. */
    logoKey: text('logo_key'),
    /** Receipt number prefix; stored by the wizard now, used by receipts in milestone 3. */
    receiptPrefix: text('receipt_prefix'),
    /** Set by the wizard's last step; until then the owner is sent to the wizard (PLAN §14.1). */
    setupCompletedAt: text('setup_completed_at'),
    /**
     * One register per group per day, or one per group subject (PLAN §4). Validated by the API, not
     * a CHECK: adding a CHECK to an existing table rebuilds it (PLAN §15 schema-enum rule).
     */
    attendanceMode: text('attendance_mode', { enum: ATTENDANCE_MODES }).notNull().default('daily'),
    /** JSON array of weekdays with no school (0 = Sunday … 6 = Saturday); Sunday by default. */
    weeklyOff: text('weekly_off').notNull().default('[0]'),
    /**
     * Late fine (PLAN §14.1, §14.5) as JSON `{enabled, grace_day 1–28, type 'fixed'|'pct', value,
     * cap}`; validated by the API (a CHECK would rebuild the table). The grace day is also the
     * monthly due day. NULL = no fines, due on the 10th.
     */
    fineRule: text('fine_rule'),
    /** Sibling auto-concession (PLAN §14.2) as JSON `[{nth, pct}]`: the nth child gets pct off tuition. */
    siblingRule: text('sibling_rule'),
    /** Fee reminder cooldown per family and template, in days (PLAN §14.9). */
    reminderCooldownDays: integer('reminder_cooldown_days').notNull().default(7),
    ...stamps(),
  },
  () => [check('school_mode', oneOf('mode', SCHOOL_MODES))],
);

/** Academic year. The auth table PLAN also calls `session` is named `user_session` instead. */
export const session = sqliteTable('session', {
  id: id(),
  name: text('name').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  isCurrent: bool('is_current').notNull().default(false),
  ...stamps(),
});

export const term = sqliteTable('term', {
  id: id(),
  sessionId: text('session_id')
    .notNull()
    .references(() => session.id),
  name: text('name').notNull(),
  seq: integer('seq').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  ...stamps(),
});

export const PROGRAMME_KINDS = ['grade', 'course'] as const;

export const programme = sqliteTable(
  'programme',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind', { enum: PROGRAMME_KINDS }).notNull(),
    seq: integer('seq').notNull().default(0),
    nextProgrammeId: text('next_programme_id').references((): AnySQLiteColumn => programme.id),
    durationWeeks: integer('duration_weeks'),
    deletedAt: text('deleted_at'),
    ...stamps(),
  },
  () => [check('programme_kind', oneOf('kind', PROGRAMME_KINDS))],
);

export const subject = sqliteTable('subject', {
  id: id(),
  name: text('name').notNull(),
  shortName: text('short_name'),
  deletedAt: text('deleted_at'),
  ...stamps(),
});

export const STAFF_STATUSES = ['active', 'left'] as const;

export const staff = sqliteTable('staff', {
  id: id(),
  userId: text('user_id').references(() => user.id),
  name: text('name').notNull(),
  phone: text('phone'),
  role: text('role'),
  joined: text('joined'),
  status: text('status', { enum: STAFF_STATUSES }).notNull().default('active'),
  extra: text('extra', { mode: 'json' }),
  ...stamps(),
});

export const GRP_STATUSES = ['open', 'running', 'closed'] as const;

/** "Group" is an SQL keyword, hence `grp`. A class section or an academy batch (PLAN §4). */
export const grp = sqliteTable(
  'grp',
  {
    id: id(),
    programmeId: text('programme_id')
      .notNull()
      .references(() => programme.id),
    sessionId: text('session_id').references(() => session.id),
    name: text('name').notNull(),
    isPrimary: bool('is_primary').notNull().default(true),
    classTeacherId: text('class_teacher_id').references(() => staff.id),
    startDate: text('start_date'),
    endDate: text('end_date'),
    capacity: integer('capacity'),
    days: text('days'),
    startTime: text('start_time'),
    endTime: text('end_time'),
    room: text('room'),
    nextGrpId: text('next_grp_id').references((): AnySQLiteColumn => grp.id),
    status: text('status', { enum: GRP_STATUSES }).notNull().default('open'),
    ...stamps(),
  },
  (t) => [
    check('grp_status', oneOf('status', GRP_STATUSES)),
    index('grp_class_teacher').on(t.classTeacherId),
  ],
);

export const grpSubject = sqliteTable(
  'grp_subject',
  {
    id: id(),
    grpId: text('grp_id')
      .notNull()
      .references(() => grp.id),
    subjectId: text('subject_id')
      .notNull()
      .references(() => subject.id),
    teacherId: text('teacher_id').references(() => staff.id),
    ...stamps(),
  },
  (t) => [
    unique('grp_subject_once').on(t.grpId, t.subjectId),
    index('grp_subject_teacher').on(t.teacherId),
  ],
);

export const family = sqliteTable('family', {
  id: id(),
  name: text('name').notNull(),
  address: text('address'),
  area: text('area'),
  deletedAt: text('deleted_at'),
  ...stamps(),
});

export const guardian = sqliteTable(
  'guardian',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => family.id),
    name: text('name').notNull(),
    relation: text('relation'),
    cnic: text('cnic'),
    phone: text('phone'),
    whatsapp: text('whatsapp'),
    priority: integer('priority').notNull().default(1),
    consentWhatsapp: bool('consent_whatsapp').notNull().default(false),
    consentSms: bool('consent_sms').notNull().default(false),
    lang: text('lang', { enum: ['en', 'ur'] })
      .notNull()
      .default('ur'),
    ...stamps(),
  },
  (t) => [index('guardian_phone').on(t.phone), index('guardian_family').on(t.familyId)],
);

export const STUDENT_STATUSES = ['active', 'left', 'graduated'] as const;

export const student = sqliteTable(
  'student',
  {
    id: id(),
    familyId: text('family_id')
      .notNull()
      .references(() => family.id),
    admissionNo: text('admission_no').notNull().unique(),
    name: text('name').notNull(),
    fatherName: text('father_name'),
    dob: text('dob'),
    gender: text('gender', { enum: ['m', 'f'] }),
    bFormNo: text('b_form_no'),
    photoKey: text('photo_key'),
    admissionDate: text('admission_date').notNull(),
    status: text('status', { enum: STUDENT_STATUSES }).notNull().default('active'),
    leftDate: text('left_date'),
    leftReason: text('left_reason'),
    extra: text('extra', { mode: 'json' }),
    ...stamps(),
  },
  (t) => [
    check('student_status', oneOf('status', STUDENT_STATUSES)),
    index('student_family').on(t.familyId),
  ],
);

export const ENROLMENT_STATUSES = [
  'active',
  'promoted',
  'retained',
  'completed',
  'withdrawn',
  // Moved to another group mid-session (the next row links back via prev_enrolment_id); distinct
  // from withdrawn, which means the student left the school.
  'transferred',
] as const;

/** The one-active-primary rule is a partial unique index in sql/10_indexes.sql. */
export const enrolment = sqliteTable(
  'enrolment',
  {
    id: id(),
    studentId: text('student_id')
      .notNull()
      .references(() => student.id),
    grpId: text('grp_id')
      .notNull()
      .references(() => grp.id),
    isPrimary: bool('is_primary').notNull(),
    rollNo: text('roll_no'),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    status: text('status', { enum: ENROLMENT_STATUSES }).notNull().default('active'),
    endReason: text('end_reason'),
    prevEnrolmentId: text('prev_enrolment_id').references((): AnySQLiteColumn => enrolment.id),
    ...stamps(),
  },
  (t) => [
    check('enrolment_status', oneOf('status', ENROLMENT_STATUSES)),
    index('enrolment_grp').on(t.grpId, t.status),
    index('enrolment_student').on(t.studentId),
  ],
);

export const MARK_STATUSES = ['P', 'A', 'L', 'E'] as const;

/**
 * One row per submission ever received (history). `grp_subject_id` is '' for a whole-day register
 * so the key has no NULLs; it therefore carries no foreign key.
 */
export const attRegister = sqliteTable(
  'att_register',
  {
    id: id(),
    clientId: text('client_id').notNull().unique(),
    grpId: text('grp_id')
      .notNull()
      .references(() => grp.id),
    date: text('date').notNull(),
    grpSubjectId: text('grp_subject_id').notNull().default(''),
    takenBy: text('taken_by')
      .notNull()
      .references(() => user.id),
    takenAt: text('taken_at').notNull(),
    receivedAt: text('received_at').notNull().default(nowIso),
    /** Per-request nonce: lets one batch tell "I created this row" from "a retry already did". */
    batchToken: text('batch_token').notNull(),
  },
  (t) => [index('att_register_key').on(t.grpId, t.date, t.grpSubjectId)],
);

export const attMark = sqliteTable(
  'att_mark',
  {
    registerId: text('register_id')
      .notNull()
      .references(() => attRegister.id),
    studentId: text('student_id')
      .notNull()
      .references(() => student.id),
    status: text('status', { enum: MARK_STATUSES }).notNull(),
    note: text('note'),
  },
  (t) => [
    primaryKey({ columns: [t.registerId, t.studentId] }),
    check('att_mark_status', oneOf('status', MARK_STATUSES)),
    index('att_mark_student').on(t.studentId),
  ],
);

export const currentRegister = sqliteTable(
  'current_register',
  {
    grpId: text('grp_id')
      .notNull()
      .references(() => grp.id),
    date: text('date').notNull(),
    grpSubjectId: text('grp_subject_id').notNull().default(''),
    registerId: text('register_id')
      .notNull()
      .references(() => attRegister.id),
    takenAt: text('taken_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.grpId, t.date, t.grpSubjectId] })],
);

/** School holidays: no register can be taken on these dates (PLAN §14.3). */
export const holiday = sqliteTable('holiday', {
  date: text('date').primaryKey(),
  nameEn: text('name_en').notNull(),
  nameUr: text('name_ur'),
  ...stamps(),
});

export const staffAtt = sqliteTable(
  'staff_att',
  {
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    date: text('date').notNull(),
    status: text('status', { enum: MARK_STATUSES }).notNull(),
    note: text('note'),
    ...stamps(),
  },
  (t) => [
    primaryKey({ columns: [t.staffId, t.date] }),
    check('staff_att_status', oneOf('status', MARK_STATUSES)),
  ],
);

export const gradeScale = sqliteTable('grade_scale', {
  id: id(),
  name: text('name').notNull(),
  ...stamps(),
});

export const gradeBand = sqliteTable(
  'grade_band',
  {
    scaleId: text('scale_id')
      .notNull()
      .references(() => gradeScale.id),
    minPct: real('min_pct').notNull(),
    grade: text('grade').notNull(),
    remark: text('remark'),
  },
  (t) => [primaryKey({ columns: [t.scaleId, t.minPct] })],
);

export const EXAM_STATUSES = ['draft', 'published'] as const;

export const exam = sqliteTable(
  'exam',
  {
    id: id(),
    name: text('name').notNull(),
    termId: text('term_id').references(() => term.id),
    grpId: text('grp_id')
      .notNull()
      .references(() => grp.id),
    dateFrom: text('date_from'),
    status: text('status', { enum: EXAM_STATUSES }).notNull().default('draft'),
    ...stamps(),
  },
  () => [check('exam_status', oneOf('status', EXAM_STATUSES))],
);

export const examPaper = sqliteTable('exam_paper', {
  id: id(),
  examId: text('exam_id')
    .notNull()
    .references(() => exam.id),
  subjectId: text('subject_id')
    .notNull()
    .references(() => subject.id),
  maxMarks: real('max_marks').notNull(),
  passMarks: real('pass_marks'),
  weight: real('weight').notNull().default(1),
  ...stamps(),
});

export const mark = sqliteTable(
  'mark',
  {
    paperId: text('paper_id')
      .notNull()
      .references(() => examPaper.id),
    studentId: text('student_id')
      .notNull()
      .references(() => student.id),
    obtained: real('obtained'),
    isAbsent: bool('is_absent').notNull().default(false),
    ...stamps(),
  },
  (t) => [primaryKey({ columns: [t.paperId, t.studentId] })],
);

export const slot = sqliteTable(
  'slot',
  {
    id: id(),
    grpId: text('grp_id')
      .notNull()
      .references(() => grp.id),
    weekday: integer('weekday').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    grpSubjectId: text('grp_subject_id').references(() => grpSubject.id),
    room: text('room'),
    ...stamps(),
  },
  (t) => [
    unique('slot_no_clash').on(t.grpId, t.weekday, t.startTime),
    check('slot_weekday', sql`"weekday" BETWEEN 0 AND 6`),
  ],
);

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'bool'] as const;

export const customField = sqliteTable(
  'custom_field',
  {
    id: id(),
    entity: text('entity').notNull(),
    key: text('key').notNull(),
    labelEn: text('label_en').notNull(),
    labelUr: text('label_ur'),
    type: text('type', { enum: CUSTOM_FIELD_TYPES }).notNull(),
    ...stamps(),
  },
  (t) => [
    unique('custom_field_key').on(t.entity, t.key),
    check('custom_field_type', oneOf('type', CUSTOM_FIELD_TYPES)),
  ],
);

export const audit = sqliteTable(
  'audit',
  {
    id: id(),
    at: text('at').notNull().default(nowIso),
    userId: text('user_id'),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    diff: text('diff', { mode: 'json' }),
  },
  (t) => [index('audit_entity').on(t.entity, t.entityId)],
);

/**
 * Admission numbers `YYYY-NNNN`, one series per session start year (PLAN §14.2). Numbered inside the
 * admission batch (UPSERT then INSERT…SELECT), so two concurrent admissions cannot share a number.
 */
export const admissionSeries = sqliteTable('admission_series', {
  series: text('series').primaryKey(),
  /** The last number issued in this series. */
  lastNo: integer('last_no').notNull(),
});

export const IMPORT_RUN_STATUSES = ['running', 'committed', 'failed'] as const;

/** One committed CSV upload (dry runs write nothing). */
export const importRun = sqliteTable(
  'import_run',
  {
    id: id(),
    kind: text('kind').notNull(),
    fileName: text('file_name'),
    status: text('status', { enum: IMPORT_RUN_STATUSES }).notNull().default('running'),
    total: integer('total').notNull(),
    created: integer('created').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    report: text('report', { mode: 'json' }),
    ...stamps(),
  },
  () => [check('import_run_status', oneOf('status', IMPORT_RUN_STATUSES))],
);

/**
 * One imported CSV row. `row_hash` (sha-256 of the normalised row) is unique across all runs, so
 * re-uploading a file — or retrying a chunk after a dropped connection — creates nothing twice.
 */
export const importRow = sqliteTable(
  'import_row',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => importRun.id),
    rowNo: integer('row_no').notNull(),
    rowHash: text('row_hash').notNull().unique(),
    studentId: text('student_id').references(() => student.id),
    ...stamps(),
  },
  (t) => [index('import_row_run').on(t.runId)],
);

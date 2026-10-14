import type { SchoolMode } from './academic';
import type { AttendanceMode } from './attendance';
import type { PlannedChargeDto } from './fees';
import type { StaffRole, UserStatus } from './roles';

/**
 * Response shapes of the milestone 1 API (snake_case, like the requests). Hand-written so the web
 * app depends on a contract, not on the database schema.
 */

export type Lang = 'en' | 'ur';

export type SchoolDto = {
  id: string;
  name: string;
  name_ur: string | null;
  mode: SchoolMode;
  address: string | null;
  phone: string | null;
  default_lang: Lang;
  receipt_prefix: string | null;
  has_logo: boolean;
  /** Identity (M7b): badge letters, second line under the name, curated colour key. */
  short_name: string | null;
  city: string | null;
  brand_color: string | null;
  setup_completed_at: string | null;
  attendance_mode: AttendanceMode;
  /** Weekdays with no school, 0 = Sunday … 6 = Saturday. */
  weekly_off: number[];
};
/**
 * The public face of the school (M7b, UI plan §6.4): what the sign-in page shows before anyone has
 * a session. Name, city, badge letters, colour, office phone and whether a logo exists; nothing
 * else (no address, mode, ids or settings). `school` is null before setup.
 */
export type SchoolIdentityDto = {
  school: {
    name: string;
    name_ur: string | null;
    city: string | null;
    short_name: string | null;
    brand_color: string | null;
    phone: string | null;
    /** Versioned logo URL key (changes with every upload); null = no logo, draw the badge. */
    logo_v: string | null;
  } | null;
  /** Present (true) only on the public demo installation (DEMO_MODE=1). */
  demo?: true;
};

/** `school` is null until the setup wizard's first step saves it. */
export type SchoolResponse = { school: SchoolDto | null };

export type SessionDto = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
};

export type TermDto = {
  id: string;
  session_id: string;
  name: string;
  seq: number;
  start_date: string;
  end_date: string;
};

export type ProgrammeDto = {
  id: string;
  name: string;
  kind: 'grade' | 'course';
  seq: number;
  next_programme_id: string | null;
  duration_weeks: number | null;
};

export type SubjectDto = { id: string; name: string; short_name: string | null };

export type GroupSubjectDto = {
  id: string;
  subject_id: string;
  subject_name: string;
  teacher_id: string | null;
  teacher_name: string | null;
};

export type GroupDto = {
  id: string;
  programme_id: string;
  programme_name: string;
  programme_kind: 'grade' | 'course';
  session_id: string | null;
  name: string;
  is_primary: boolean;
  class_teacher_id: string | null;
  class_teacher_name: string | null;
  start_date: string | null;
  end_date: string | null;
  capacity: number | null;
  days: string | null;
  start_time: string | null;
  end_time: string | null;
  room: string | null;
  next_grp_id: string | null;
  status: 'open' | 'running' | 'closed';
  /** Active enrolments now. */
  active_count: number;
  /** capacity − active_count; null when the group has no capacity. */
  seats_left: number | null;
  subjects: GroupSubjectDto[];
};

export type RosterRow = {
  enrolment_id: string;
  student_id: string;
  name: string;
  father_name: string | null;
  admission_no: string;
  roll_no: string | null;
  start_date: string;
  has_photo: boolean;
};
export type GroupDetailDto = GroupDto & { roster: RosterRow[] };

export type StaffRowDto = {
  staff_id: string | null;
  user_id: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  staff_status: 'active' | 'left' | null;
  user_status: UserStatus | null;
  roles: StaffRole[];
};

export type FamilyDto = { id: string; name: string; address: string | null; area: string | null };

export type GuardianDto = {
  id: string;
  family_id: string;
  name: string;
  relation: string | null;
  /** Masked (`*********1234`) for roles that do not need it (PLAN §5.4 field scope). */
  cnic: string | null;
  phone: string | null;
  whatsapp: string | null;
  priority: number;
  consent_whatsapp: boolean;
  consent_sms: boolean;
  lang: Lang;
};

export type StudentStatus = 'active' | 'left' | 'graduated';

export type StudentListItem = {
  id: string;
  family_id: string;
  family_name: string;
  admission_no: string;
  name: string;
  father_name: string | null;
  gender: 'm' | 'f' | null;
  status: StudentStatus;
  has_photo: boolean;
  /** The active primary enrolment's group, if any; shown as "Class 2 A" (programme + group). */
  group_id: string | null;
  group_name: string | null;
  programme_name: string | null;
  roll_no: string | null;
  /** First-priority guardian's phone. */
  guardian_phone: string | null;
};

export type FamilySearchHit = FamilyDto & {
  guardians: { id: string; name: string; relation: string | null; phone: string | null }[];
  students: { id: string; name: string; admission_no: string; status: StudentStatus }[];
};

export type FamilyDetailDto = FamilyDto & {
  guardians: GuardianDto[];
  students: StudentListItem[];
};

export type EnrolmentDto = {
  id: string;
  student_id: string;
  grp_id: string;
  grp_name: string;
  programme_name: string;
  session_id: string | null;
  is_primary: boolean;
  roll_no: string | null;
  start_date: string;
  end_date: string | null;
  status: 'active' | 'promoted' | 'retained' | 'completed' | 'withdrawn' | 'transferred';
  end_reason: string | null;
  prev_enrolment_id: string | null;
};

export type StudentDto = {
  id: string;
  family_id: string;
  admission_no: string;
  name: string;
  father_name: string | null;
  dob: string | null;
  gender: 'm' | 'f' | null;
  /** Masked for roles that do not need it. */
  b_form_no: string | null;
  has_photo: boolean;
  admission_date: string;
  status: StudentStatus;
  left_date: string | null;
  left_reason: string | null;
  extra: Record<string, string | number | boolean | null>;
};

export type StudentDetailDto = StudentDto & {
  family: FamilyDto;
  guardians: GuardianDto[];
  enrolments: EnrolmentDto[];
};

export type CustomFieldDto = {
  id: string;
  entity: 'student';
  key: string;
  label_en: string;
  label_ur: string | null;
  type: 'text' | 'number' | 'date' | 'bool';
};

export type Paged<T> = { items: T[]; total: number; page: number; page_size: number };

export type AdmissionResult = {
  family_id: string;
  student_id: string;
  enrolment_id: string;
  guardian_ids: string[];
  admission_no: string;
  roll_no: string | null;
  readmitted: boolean;
  /** First-period charges billed in the admission batch (null when none were billed). */
  fees?: AdmissionFeesDto | null;
};

/** What admission bills (or would bill, for the preview): PLAN §14.2 step 5. */
export type AdmissionFeesDto = {
  period: string;
  charges: PlannedChargeDto[];
  /** The sibling rule's suggestion for this child (0 = none) and whether it was applied. */
  sibling: { nth: number; pct: number; applied: boolean };
  total_family: number;
  total_sponsor: number;
};

export type SeedResult = { created: number; existing: number };

export type ImportRowReport = {
  /** 1-based data row number (the header is row 0). */
  row: number;
  student_name: string;
  errors: string[];
  warnings: string[];
  /** What commit does (dry run) or did (commit) with this row. */
  action: 'create' | 'skip' | 'error';
  family: 'new' | 'existing' | 'csv' | null;
};

export type ImportReport = {
  dry_run: boolean;
  run_id: string | null;
  total: number;
  summary: {
    families: number;
    guardians: number;
    students: number;
    enrolments: number;
    skipped: number;
    errors: number;
  };
  rows: ImportRowReport[];
};

/** One commit chunk (≤ IMPORT_COMMIT_ROWS rows): its report plus the run's progress. */
export type ImportCommitResult = ImportReport & {
  run_id: string;
  /** Rows of this chunk written now. */
  applied: number;
  /** Rows of the file after this chunk (`total` − `offset` − chunk rows); 0 = the run is done. */
  remaining: number;
};

/** GET /api/home/first-week: the owner's first steps, each done or not (M7b-2 home checklist). */
export type FirstWeekDto = {
  setup: boolean;
  admission: boolean;
  fees: boolean;
  register: boolean;
  message: boolean;
};

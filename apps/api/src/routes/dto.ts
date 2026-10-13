import type {
  customField,
  family,
  guardian,
  programme,
  school,
  session,
  student,
  subject,
  term,
} from '@maktab/db';
import type {
  CustomFieldDto,
  FamilyDto,
  GuardianDto,
  ProgrammeDto,
  SchoolDto,
  SessionDto,
  StudentDto,
  SubjectDto,
  TermDto,
} from '@maktab/shared';
import { parseWeeklyOff } from '../lib/attendance';
import { mask } from '../lib/http';

// Row (drizzle, camelCase) → response (snake_case, PLAN contract in packages/shared/src/dto.ts).

export const schoolDto = (r: typeof school.$inferSelect): SchoolDto => ({
  id: r.id,
  name: r.name,
  name_ur: r.nameUr,
  mode: r.mode,
  address: r.address,
  phone: r.phone,
  default_lang: r.defaultLang,
  receipt_prefix: r.receiptPrefix,
  has_logo: !!r.logoKey,
  short_name: r.shortName,
  city: r.city,
  brand_color: r.brandColor,
  setup_completed_at: r.setupCompletedAt,
  attendance_mode: r.attendanceMode,
  weekly_off: parseWeeklyOff(r.weeklyOff),
});

export const sessionDto = (r: typeof session.$inferSelect): SessionDto => ({
  id: r.id,
  name: r.name,
  start_date: r.startDate,
  end_date: r.endDate,
  is_current: r.isCurrent,
});

export const termDto = (r: typeof term.$inferSelect): TermDto => ({
  id: r.id,
  session_id: r.sessionId,
  name: r.name,
  seq: r.seq,
  start_date: r.startDate,
  end_date: r.endDate,
});

export const programmeDto = (r: typeof programme.$inferSelect): ProgrammeDto => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  seq: r.seq,
  next_programme_id: r.nextProgrammeId,
  duration_weeks: r.durationWeeks,
});

export const subjectDto = (r: typeof subject.$inferSelect): SubjectDto => ({
  id: r.id,
  name: r.name,
  short_name: r.shortName,
});

export const customFieldDto = (r: typeof customField.$inferSelect): CustomFieldDto => ({
  id: r.id,
  entity: 'student',
  key: r.key,
  label_en: r.labelEn,
  label_ur: r.labelUr,
  type: r.type,
});

export const familyDto = (r: typeof family.$inferSelect): FamilyDto => ({
  id: r.id,
  name: r.name,
  address: r.address,
  area: r.area,
});

/** `full` = the caller may see identity numbers (student.write holders); teachers get them masked. */
export const guardianDto = (r: typeof guardian.$inferSelect, full: boolean): GuardianDto => ({
  id: r.id,
  family_id: r.familyId,
  name: r.name,
  relation: r.relation,
  cnic: full ? r.cnic : mask(r.cnic),
  phone: r.phone,
  whatsapp: r.whatsapp,
  priority: r.priority,
  consent_whatsapp: r.consentWhatsapp,
  consent_sms: r.consentSms,
  lang: r.lang,
});

type Extra = StudentDto['extra'];
const asExtra = (v: unknown): Extra =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Extra) : {};

export const studentDto = (r: typeof student.$inferSelect, full: boolean): StudentDto => ({
  id: r.id,
  family_id: r.familyId,
  admission_no: r.admissionNo,
  name: r.name,
  father_name: r.fatherName,
  dob: r.dob,
  gender: r.gender,
  b_form_no: full ? r.bFormNo : mask(r.bFormNo),
  has_photo: !!r.photoKey,
  admission_date: r.admissionDate,
  status: r.status,
  left_date: r.leftDate,
  left_reason: r.leftReason,
  extra: asExtra(r.extra),
});

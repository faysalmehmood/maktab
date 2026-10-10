/**
 * Student CSV import columns (PLAN §6 v1.2). The template's single header line carries both
 * languages, `key (اردو)`, so office staff can fill it in either; only the key part is matched.
 * Columns not listed here are matched against student custom-field keys.
 */
export const IMPORT_COLUMNS = [
  { key: 'student_name', ur: 'طالب علم کا نام', required: true },
  { key: 'father_name', ur: 'والد کا نام', required: false },
  { key: 'gender', ur: 'جنس (m/f)', required: false },
  { key: 'dob', ur: 'تاریخ پیدائش (YYYY-MM-DD)', required: false },
  { key: 'b_form_no', ur: 'ب فارم نمبر', required: false },
  { key: 'admission_no', ur: 'داخلہ نمبر', required: false },
  { key: 'admission_date', ur: 'تاریخ داخلہ (YYYY-MM-DD)', required: false },
  { key: 'group', ur: 'جماعت / گروپ', required: true },
  { key: 'roll_no', ur: 'رول نمبر', required: false },
  { key: 'family_name', ur: 'خاندان کا نام', required: false },
  { key: 'address', ur: 'پتہ', required: false },
  { key: 'area', ur: 'علاقہ', required: false },
  { key: 'guardian_name', ur: 'سرپرست کا نام', required: true },
  { key: 'guardian_relation', ur: 'رشتہ', required: false },
  { key: 'guardian_phone', ur: 'سرپرست کا فون', required: true },
  { key: 'guardian_whatsapp', ur: 'واٹس ایپ نمبر', required: false },
  { key: 'consent_whatsapp', ur: 'واٹس ایپ پیغام کی اجازت (yes/no)', required: false },
] as const;

export type ImportColumnKey = (typeof IMPORT_COLUMNS)[number]['key'];

/**
 * Rows per commit request. The free Worker allows 50 subrequests and 10 ms CPU per request (PLAN
 * §8), so a commit is one D1 batch (one json_each statement per table) over at most this many rows;
 * the web page sends a file in chunks of this size, in order, and shows progress. Every row is
 * keyed by its hash, so a dropped chunk is resumed by sending the file again.
 */
export const IMPORT_COMMIT_ROWS = 200;
/** One file (the dry run reads it whole); bigger schools split it. */
export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_MAX_BYTES = 1024 * 1024;

/** `Student_Name (طالب علم کا نام)` → `student_name`. */
export function importHeaderKey(cell: string): string {
  const cut = cell.indexOf('(');
  return (cut >= 0 ? cell.slice(0, cut) : cell).trim().toLowerCase().replace(/\s+/g, '_');
}

export const importTemplateHeader = (customKeys: readonly string[] = []): string[] => [
  ...IMPORT_COLUMNS.map((c) => `${c.key} (${c.ur})`),
  ...customKeys,
];

const YES = new Set(['y', 'yes', '1', 'true', 'ہاں', 'جی']);
const NO = new Set(['', 'n', 'no', '0', 'false', 'نہیں']);

/** yes/no cell → boolean; null when it is neither. */
export function parseYesNo(cell: string): boolean | null {
  const v = cell.trim().toLowerCase();
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return null;
}

/** m/f/male/female/لڑکا/لڑکی → 'm' | 'f'; '' → null; anything else → undefined (an error). */
export function parseGender(cell: string): 'm' | 'f' | null | undefined {
  const v = cell.trim().toLowerCase();
  if (v === '') return null;
  if (['m', 'male', 'boy', 'لڑکا'].includes(v)) return 'm';
  if (['f', 'female', 'girl', 'لڑکی'].includes(v)) return 'f';
  return undefined;
}

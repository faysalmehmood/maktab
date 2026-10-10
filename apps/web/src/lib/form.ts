import type { I18nKey } from '@maktab/shared';

/** Structural subset of a Zod issue, so the web app needs no direct zod import. */
export type Issue = { path: PropertyKey[]; code: string; message: string };
/** path ("student.name", "guardians.0.phone") → error code under `errors.*`. */
export type FieldErrors = Record<string, string>;

/** Messages our shared schemas emit on purpose; anything else becomes required/invalid. */
const KNOWN = new Set([
  'invalid_phone',
  'invalid_cnic',
  'invalid_b_form',
  'end_before_start',
  'guardian_required',
  'family_or_family_id',
  'required',
  'duplicate_subject',
]);

function valueAt(input: unknown, path: PropertyKey[]): unknown {
  let v: unknown = input;
  for (const p of path) {
    if (v == null || typeof v !== 'object') return undefined;
    v = (v as Record<PropertyKey, unknown>)[p];
  }
  return v;
}

export function issuesToErrors(issues: readonly Issue[], input: unknown): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.');
    if (out[key]) continue;
    if (KNOWN.has(issue.message)) out[key] = issue.message;
    else {
      const v = valueAt(input, issue.path);
      out[key] = v === undefined || v === null || v === '' ? 'required' : 'invalid';
    }
  }
  return out;
}

export const errorKey = (code: string): I18nKey => `errors.${code}` as I18nKey;

/** Local calendar date (the school runs on Asia/Karachi; the phone's clock is the best guess). */
export function todayIso(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Pakistani phone numbers, normalised the way experiment 4 settled (PLAN §12 exp4): every accepted
 * spelling of a mobile number becomes `923001234567` (no plus), so a guardian typed as
 * "0300-1234567" on admission is found again as "+92 300 1234567" at the fee counter.
 */

const ARABIC_INDIC = /[٠-٩]/g;
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g;

/** Urdu keyboards type ۰۱۲…; the app stores and shows Latin digits only (PLAN §11). */
export function toLatinDigits(input: string): string {
  return input
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Separators people actually type; anything else (letters, `#`) means it is not a phone number. */
const ALLOWED = /^[\d\s+\-().]*$/;

function digitsWithCountry(input: string): string | null {
  const latin = toLatinDigits(input).trim();
  if (!latin || !ALLOWED.test(latin)) return null;
  // A plus is only meaningful at the very start.
  if (latin.indexOf('+') > 0) return null;
  let d = latin.replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(2);
  else if (d.startsWith('92') && d.length >= 11) {
    // already international
  } else if (d.startsWith('0')) d = `92${d.slice(1)}`;
  else if (d.length === 10 && d.startsWith('3')) d = `92${d}`;
  else return null;
  return d;
}

/** `0300-1234567`, `+92 300 1234567`, `0092…`, `300…`, Urdu digits → `923001234567`; else null. */
export function normalizePkMobile(input: string): string | null {
  const d = digitsWithCountry(input);
  return d && /^923\d{9}$/.test(d) ? d : null;
}

/**
 * A stored (normalised) number WhatsApp can reach: a PK mobile `923xxxxxxxxx`. Landlines and
 * anything else route to "call" — at enqueue (SQL twin: PK_MOBILE_GLOB) and again at open.
 */
export const isPkMobile = (stored: string | null | undefined): boolean =>
  !!stored && normalizePkMobile(stored) !== null;

/** SQLite GLOB matching exactly the normalised mobile form isPkMobile accepts (`923` + 9 digits). */
export const PK_MOBILE_GLOB = `923${'[0-9]'.repeat(9)}`;

export type PkPhone = { number: string; mobile: boolean };

/**
 * Mobile numbers as above; PK landlines (area code + subscriber, e.g. `042-35761234`) are kept as
 * `924235761234` with `mobile: false`: stored for "call", never offered to WhatsApp (exp4).
 */
export function normalizePkPhone(input: string): PkPhone | null {
  const mobile = normalizePkMobile(input);
  if (mobile) return { number: mobile, mobile: true };
  const d = digitsWithCountry(input);
  if (d && /^92[2-9]\d{7,9}$/.test(d) && !d.startsWith('923')) return { number: d, mobile: false };
  return null;
}

/** Groups a landline subscriber number the way it is read aloud: 8 → 4+4, 7 → 3+4, 6 → 3+3. */
const SUBSCRIBER = { 8: [4, 4], 7: [3, 4], 6: [3, 3] } as Record<number, [number, number]>;

/**
 * For display: mobiles `923001234567` → `0300 1234567`; landlines `924235550100` → `042 3555 0100`.
 * Typed spellings (`04235550100`, `+92 42 …`) are normalised first, since older rows (the school's
 * own phone) were stored as typed. A two-digit area code is assumed: it is right for every large
 * city (042, 021, 051, …), and a three-digit one still reads as one number. Anything that is not a
 * PK number is returned unchanged.
 */
export function formatPkPhone(stored: string | null | undefined): string {
  if (!stored) return '';
  const n = normalizePkPhone(stored);
  if (!n) return stored;
  const national = n.number.slice(2);
  if (n.mobile) return `0${national.slice(0, 3)} ${national.slice(3)}`;
  const sub = national.slice(2);
  const split = SUBSCRIBER[sub.length];
  return split
    ? `0${national.slice(0, 2)} ${sub.slice(0, split[0])} ${sub.slice(split[0])}`
    : `0${national}`;
}

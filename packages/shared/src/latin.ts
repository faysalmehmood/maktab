/*
 * Which Latin words may stay in Urdu text. Shared by `npm run i18n:check` (scripts/i18n-check.ts)
 * and the guide's content test, so the UI dictionaries and the Help & guide follow one rule.
 */

/** Latin tokens that are fine to leave untranslated (brand, formats, codes, units, course names). */
export const LATIN_OK =
  /^(?:Maktab|CNIC|PDF|CSV|JSON|ZIP|WhatsApp|SMS|Rs\.?|PKR|KB|MB|GB|mm|cm|JPEG|PNG|WebP|URL|ID|OK|IBAN|JazzCash|EasyPaisa|Google|Chrome|PIN|README|FSc|ICS|FA|[A-Z]\d*|\d+[A-Za-z]*|https?:\/\/\S+)$/;

const DOUBLE = /\{\{\s*(\w+)\s*\}\}/g;
const SINGLE = /\{(\w+)\}/g;

/** The Latin words in a text that are not allowed technical tokens ({{x}} / {x} placeholders ignored). */
export function strayLatin(s: string): string[] {
  return s
    .replace(DOUBLE, ' ')
    .replace(SINGLE, ' ')
    .split(/[\s,.;:()/·%+\-–—|،۔؛]+/)
    .filter((w) => /[A-Za-z]/.test(w) && !LATIN_OK.test(w));
}

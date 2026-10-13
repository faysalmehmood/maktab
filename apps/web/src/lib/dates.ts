/*
 * One display format for dates (UI plan §5.2): "13 Oct 2026", "Tuesday, 13 Oct 2026", "Oct 2026".
 * Latin digits in Urdu too (`-u-nu-latn`); callers still isolate the result (<bdi>/<Num>).
 * ISO dates are calendar days, formatted at noon UTC so no timezone moves them.
 */
const fmt = (lang: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', {
    ...opts,
    timeZone: 'UTC',
  });

const at = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);

/** "Tuesday, 13 Oct 2026". */
export const longDate = (iso: string, lang: string): string =>
  fmt(lang, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }).format(at(iso));

/** "13 Oct 2026". */
export const shortDate = (iso: string, lang: string): string =>
  fmt(lang, { day: 'numeric', month: 'short', year: 'numeric' }).format(at(iso));

/** "Oct 2026" from "2026-10" or a full date. */
export const monthLabel = (period: string, lang: string): string =>
  fmt(lang, { month: 'short', year: 'numeric' }).format(at(`${period.slice(0, 7)}-15`));

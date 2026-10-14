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

/** "October" / "اکتوبر" for month 1–12 (no year), through the same Intl path as every other date. */
export const monthName = (month: number, lang: string): string =>
  fmt(lang, { month: 'long' }).format(new Date(Date.UTC(2026, month - 1, 15, 12)));

/** A UTC instant ("…Z", or SQLite's "YYYY-MM-DD HH:MM:SS", which is UTC without saying so). */
const instant = (s: string): Date => {
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
};

/** "14 Oct 2026, 09:17" on the school's clock (Asia/Karachi, whatever the phone's zone), 24-hour. */
export const dateTime = (at: string, lang: string): string => {
  const d = instant(at);
  if (Number.isNaN(d.getTime())) return at;
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Karachi',
  }).format(d);
};

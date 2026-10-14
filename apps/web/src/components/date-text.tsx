import { useTranslation } from 'react-i18next';
import { dateTime, longDate, monthLabel, shortDate } from '@/lib/dates';
import { cn } from '@/lib/utils';

const FMT = { short: shortDate, long: longDate, month: monthLabel, time: dateTime } as const;

/**
 * A display date ("13 Oct 2026", "Tuesday, 13 Oct 2026", "Oct 2026", or with `time` a UTC instant
 * as "13 Oct 2026, 09:17" school time) in the UI language, or `lang` for a print in its own
 * language, isolated with an explicit direction, so the day, month and year keep their order in
 * Urdu.
 */
export function DateText({
  iso,
  kind = 'short',
  lang,
  className,
}: {
  iso: string;
  kind?: keyof typeof FMT;
  lang?: string;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const language = lang ?? i18n.language;
  const ur = language === 'ur';
  return (
    // A span, not <bdi>: styles.css forces every bdi to LTR (numbers), which is what scrambles it.
    <span dir={ur ? 'rtl' : 'ltr'} className={cn('[unicode-bidi:isolate]', className)}>
      {FMT[kind](iso, language)}
    </span>
  );
}

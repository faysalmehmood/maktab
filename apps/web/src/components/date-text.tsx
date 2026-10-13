import { useTranslation } from 'react-i18next';
import { longDate, monthLabel, shortDate } from '@/lib/dates';
import { cn } from '@/lib/utils';

const FMT = { short: shortDate, long: longDate, month: monthLabel } as const;

/**
 * A display date ("13 Oct 2026", "Tuesday, 13 Oct 2026", "Oct 2026") in the UI language, isolated
 * with an explicit direction, so the day, month and year keep their order in Urdu.
 */
export function DateText({
  iso,
  kind = 'short',
  className,
}: {
  iso: string;
  kind?: keyof typeof FMT;
  className?: string;
}) {
  const { i18n } = useTranslation();
  const ur = i18n.language === 'ur';
  return (
    // A span, not <bdi>: styles.css forces every bdi to LTR (numbers), which is what scrambles it.
    <span dir={ur ? 'rtl' : 'ltr'} className={cn('[unicode-bidi:isolate]', className)}>
      {FMT[kind](iso, i18n.language)}
    </span>
  );
}

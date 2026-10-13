import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { monthName } from '@/lib/dates';
import { cn } from '@/lib/utils';

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * A "YYYY-MM" picker whose month is named by the app's language (Urdu names in ur, Latin digits
 * for the year), where `<input type="month">` follows the browser's own locale and shows
 * "October 2026" even in the Urdu UI. `id` is the month select (so a <label htmlFor> reaches it).
 */
export function MonthInput({
  id,
  value,
  onChange,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const { i18n, t } = useTranslation();
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  const month = m?.[2] ?? '';
  const [year, setYear] = useState(m?.[1] ?? '');
  useEffect(() => {
    if (m?.[1]) setYear(m[1]);
  }, [m?.[1]]);
  const emit = (y: string, mo: string) => {
    if (/^\d{4}$/.test(y) && /^(0[1-9]|1[0-2])$/.test(mo)) onChange(`${y}-${mo}`);
  };
  return (
    <div className={cn('flex gap-2', className)} dir={i18n.dir()}>
      <Select
        id={id}
        className="min-w-0 flex-1"
        value={month}
        onChange={(e) => emit(year, e.target.value)}
      >
        {!month && <option value="" />}
        {MONTHS.map((n) => (
          <option key={n} value={String(n).padStart(2, '0')}>
            {monthName(n, i18n.language)}
          </option>
        ))}
      </Select>
      <Input
        id={`${id}-year`}
        type="number"
        inputMode="numeric"
        dir="ltr"
        className="num w-24 shrink-0"
        aria-label={t('money.common.year')}
        min={2000}
        max={2100}
        value={year}
        onChange={(e) => {
          setYear(e.target.value);
          emit(e.target.value, month || '01');
        }}
      />
    </div>
  );
}

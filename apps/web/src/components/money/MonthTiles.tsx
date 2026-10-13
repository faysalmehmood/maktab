import type { MonthDashboardDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Num } from '@/components/form';
import { Mny, StatStrip } from '@/components/page';
import { getJson } from '@/lib/api';
import { cn } from '@/lib/utils';

export const useMonthDashboard = (enabled = true) =>
  useQuery({
    queryKey: ['dashboard-month'],
    queryFn: () => getJson<MonthDashboardDto>('/api/dashboard/month'),
    enabled,
  });

/** "Oct 2026" from "2026-10" (Latin digits; month name in the UI language). */
function monthName(period: string, lang: string): string {
  return new Intl.DateTimeFormat(lang === 'ur' ? 'ur-PK-u-nu-latn' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${period}-15T12:00:00Z`));
}

/**
 * PLAN §14.11 "Month" as one strip (M7b): income, spending, net and dues outstanding, then the
 * month's defaulters, admissions and leavers on a quieter line.
 */
export function MonthTiles() {
  const { t, i18n } = useTranslation();
  const d = useMonthDashboard().data;
  if (!d) return null;
  const vs = t('shell.compare.vs', {
    month: monthName(d.previous.period, i18n.language),
  });
  const spending = d.expenses + d.salaries;
  return (
    <section
      className="overflow-hidden rounded-xl border bg-card"
      aria-labelledby="month-tiles-title"
    >
      <header className="flex min-h-12 items-center gap-3 border-b px-4 py-2">
        <h2 id="month-tiles-title" className="text-section font-semibold">
          {t('money.dash.month')} <Num>{monthName(d.period, i18n.language)}</Num>
        </h2>
      </header>
      <StatStrip
        className="rounded-none border-0"
        items={[
          {
            id: 'tile-month-income',
            label: t('money.dash.income'),
            value: <Mny paisa={d.income} />,
            to: '/reports/income-expense',
            compare: { now: d.income, before: d.previous.income, label: vs },
          },
          {
            id: 'tile-month-spending',
            // Without owner pay visible the figure leaves management out, and says so (F1).
            label:
              d.salaries_scope === 'excluding_owners'
                ? t('money.dash.spendingExMgmt')
                : t('money.dash.spending'),
            value: <Mny paisa={spending} />,
            to: '/reports/income-expense',
            compare: {
              now: spending,
              before: d.previous.spending,
              label: vs,
              higherIsBetter: false,
            },
          },
          {
            id: 'tile-month-net',
            label: t('money.dash.net'),
            value: <Mny paisa={d.net} className={cn(d.net < 0 && 'text-bad')} />,
            compare: { now: d.net, before: d.previous.net, label: vs },
          },
          {
            id: 'tile-month-dues',
            label: t('money.dash.dues'),
            value: <Mny paisa={d.dues_outstanding} />,
          },
        ]}
      />
      {/* The quieter line: the month's defaulters, admissions and leavers. */}
      <StatStrip
        className="rounded-none border-0 border-t text-sm lg:grid-cols-3 [&_dd]:text-base"
        items={[
          {
            id: 'tile-month-defaulters',
            label: t('money.dash.defaulters'),
            value: <Num>{d.defaulters}</Num>,
            to: '/fees/defaulters',
          },
          {
            id: 'tile-month-admissions',
            label: t('money.dash.admissions'),
            value: <Num>{d.admissions}</Num>,
          },
          { id: 'tile-month-left', label: t('money.dash.left'), value: <Num>{d.left}</Num> },
        ]}
      />
    </section>
  );
}

import type { MonthDashboardDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Num } from '@/components/form';
import { Mny } from '@/components/page';
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

function Stat({
  id,
  title,
  to,
  children,
}: {
  id: string;
  title: string;
  to?: string;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="text-meta text-muted-foreground">{title}</span>
      <span className="text-lg font-bold">{children}</span>
    </>
  );
  return (
    <div id={id} className="flex flex-col border-e border-b px-4 py-3 last:border-e-0">
      {to ? (
        <Link to={to} className="flex min-h-11 flex-col hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * PLAN §14.11 "Month" as one strip (M7b): income, spending, net and dues outstanding, then the
 * month's defaulters, admissions and leavers on a quieter line.
 */
export function MonthTiles() {
  const { t, i18n } = useTranslation();
  const d = useMonthDashboard().data;
  if (!d) return null;
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
      <div className="grid grid-cols-2 lg:grid-cols-4 [&>*:nth-child(2n)]:border-e-0 lg:[&>*:nth-child(2n)]:border-e lg:[&>*:nth-child(4n)]:border-e-0">
        <Stat id="tile-month-income" title={t('money.dash.income')} to="/reports/income-expense">
          <Mny paisa={d.income} />
        </Stat>
        <Stat
          id="tile-month-spending"
          // Without owner pay visible the figure leaves management out, and says so (F1).
          title={
            d.salaries_scope === 'excluding_owners'
              ? t('money.dash.spendingExMgmt')
              : t('money.dash.spending')
          }
          to="/reports/income-expense"
        >
          <Mny paisa={d.expenses + d.salaries} />
        </Stat>
        <Stat id="tile-month-net" title={t('money.dash.net')}>
          <Mny paisa={d.net} className={cn(d.net < 0 && 'text-bad')} />
        </Stat>
        <Stat id="tile-month-dues" title={t('money.dash.dues')}>
          <Mny paisa={d.dues_outstanding} />
        </Stat>
      </div>
      <div className="grid grid-cols-3 text-sm [&>*]:border-b-0">
        <Stat id="tile-month-defaulters" title={t('money.dash.defaulters')} to="/fees/defaulters">
          <Num>{d.defaulters}</Num>
        </Stat>
        <Stat id="tile-month-admissions" title={t('money.dash.admissions')}>
          <Num>{d.admissions}</Num>
        </Stat>
        <Stat id="tile-month-left" title={t('money.dash.left')}>
          <Num>{d.left}</Num>
        </Stat>
      </div>
    </section>
  );
}

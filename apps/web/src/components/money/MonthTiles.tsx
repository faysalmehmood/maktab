import type { MonthDashboardDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Money } from '@/components/fees/common';
import { Num } from '@/components/form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getJson } from '@/lib/api';
import { cn } from '@/lib/utils';

export const useMonthDashboard = (enabled = true) =>
  useQuery({
    queryKey: ['dashboard-month'],
    queryFn: () => getJson<MonthDashboardDto>('/api/dashboard/month'),
    enabled,
  });

function Tile({
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
    <Card className="h-full gap-1 py-3" id={id}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-xl font-semibold">{children}</CardContent>
    </Card>
  );
  return to ? (
    <Link to={to} className="block min-h-11 rounded-xl hover:ring-2 hover:ring-ring/30">
      {body}
    </Link>
  ) : (
    body
  );
}

/** PLAN §14.11 "Month": income vs expense, dues outstanding, defaulters, new admissions, left. */
export function MonthTiles() {
  const { t } = useTranslation();
  const d = useMonthDashboard().data;
  if (!d) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="month-tiles-title">
      <h2 id="month-tiles-title" className="font-semibold">
        {t('money.dash.month')} · <Num>{d.period}</Num>
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile id="tile-month-income" title={t('money.dash.income')} to="/reports/income-expense">
          <Money paisa={d.income} />
        </Tile>
        <Tile
          id="tile-month-spending"
          // Without owner pay visible the figure leaves management out, and says so (F1).
          title={
            d.salaries_scope === 'excluding_owners'
              ? t('money.dash.spendingExMgmt')
              : t('money.dash.spending')
          }
          to="/reports/income-expense"
        >
          <Money paisa={d.expenses + d.salaries} />
        </Tile>
        <Tile id="tile-month-net" title={t('money.dash.net')}>
          <span className={cn(d.net < 0 && 'text-destructive')}>
            <Money paisa={d.net} />
          </span>
        </Tile>
        <Tile id="tile-month-dues" title={t('money.dash.dues')}>
          <Money paisa={d.dues_outstanding} />
        </Tile>
        <Tile id="tile-month-defaulters" title={t('money.dash.defaulters')} to="/fees/defaulters">
          <Num>{d.defaulters}</Num>
        </Tile>
        <Tile id="tile-month-admissions" title={t('money.dash.admissions')}>
          <Num>{d.admissions}</Num>
        </Tile>
        <Tile id="tile-month-left" title={t('money.dash.left')}>
          <Num>{d.left}</Num>
        </Tile>
      </div>
    </section>
  );
}

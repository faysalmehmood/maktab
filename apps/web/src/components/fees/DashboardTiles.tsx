import type { FeeDashboardDto } from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Money } from '@/components/fees/common';
import { Num } from '@/components/form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getJson } from '@/lib/api';
import { canGenerate } from '@/lib/fees';
import { useRoles } from '@/lib/roles';

export const useFeeDashboard = (enabled = true) =>
  useQuery({
    queryKey: ['fee-dashboard'],
    queryFn: () => getJson<FeeDashboardDto>('/api/dashboard/fees'),
    enabled,
  });

/** PLAN M3b: a banner linking to billing when fee generation keeps failing for a group. */
export function BillingAlertBanner({ count }: { count: number }) {
  const { t } = useTranslation();
  const roles = useRoles();
  if (count <= 0) return null;
  return (
    <div
      role="alert"
      id="billing-alert-banner"
      className="flex flex-wrap items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span>
        {t('fee.billing.banner')} · <Num>{count}</Num>
      </span>
      {canGenerate(roles) && (
        <Link
          to="/fees/billing"
          className="ms-auto flex min-h-11 items-center font-medium underline"
        >
          {t('fee.billing.open')}
        </Link>
      )}
    </div>
  );
}

function Tile({
  title,
  to,
  children,
  id,
}: {
  title: string;
  to?: string;
  children: React.ReactNode;
  id: string;
}) {
  const body = (
    <Card className="h-full gap-2 py-4" id={id}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
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

/** Office fee tiles (PLAN §14.11): collection by method, dues, defaulters, alerts, queued messages. */
export function FeeTiles() {
  const { t } = useTranslation();
  const d = useFeeDashboard().data;
  if (!d) return null;
  return (
    <div className="flex flex-col gap-3">
      <BillingAlertBanner count={d.billing_alerts} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile id="tile-collected" title={t('fee.dash.collectedToday')} to="/cash">
          <p className="text-2xl font-semibold">
            <Money paisa={d.collected_total} />
          </p>
          {d.collected.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('fee.dash.nothing')}</p>
          ) : (
            <ul className="text-sm">
              {d.collected.map((c) => (
                <li key={c.method} className="flex gap-2">
                  {t(`fee.methods.${c.method}`)} · <Num>{c.count}</Num>
                  <span className="ms-auto">
                    <Money paisa={c.amount} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Tile>
        <Tile id="tile-dues" title={t('fee.dash.duesOutstanding')}>
          <p className="text-2xl font-semibold">
            <Money paisa={d.dues_outstanding} />
          </p>
        </Tile>
        <Tile id="tile-defaulters" title={t('fee.dash.defaulters')} to="/fees/defaulters">
          <p className="text-2xl font-semibold">
            <Num>{d.defaulters}</Num>
          </p>
        </Tile>
        <Tile id="tile-billing" title={t('fee.dash.billingAlerts')}>
          <p className="text-2xl font-semibold">
            <Num>{d.billing_alerts}</Num>
          </p>
        </Tile>
        <Tile id="tile-queued" title={t('fee.dash.queued')} to="/messages">
          <p className="text-2xl font-semibold">
            <Num>{d.queued_fee_messages}</Num>
          </p>
        </Tile>
      </div>
    </div>
  );
}

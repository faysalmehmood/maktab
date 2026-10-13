import { type DefaultersResponse, formatPkPhone } from '@maktab/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BellRing, PartyPopper, Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { AmountInput, Money } from '@/components/fees/common';
import { FeesTabs } from '@/components/fees/FeesTabs';
import { FilterBar } from '@/components/filter-bar';
import { ErrorNote, Field, Num } from '@/components/form';
import {
  EmptyState,
  Mny,
  Page,
  PageHeader,
  Panel,
  StatStrip,
  StatusBadge,
} from '@/components/page';
import '@/i18n/screens';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getJson, sendJson } from '@/lib/api';
import { canReadMoney, karachiToday, rupeesToPaisa, useFeeSettings } from '@/lib/fees';
import { printWhenReady } from '@/lib/print';
import { useGroups } from '@/lib/queries';
import { useRoles } from '@/lib/roles';

type Filters = { grp: string; months: string; amount: string; excludeSponsored: boolean };
const EMPTY: Filters = { grp: '', months: '', amount: '', excludeSponsored: false };

export function defaultersQuery(f: Filters): string {
  const qs = new URLSearchParams();
  if (f.grp) qs.set('grp_id', f.grp);
  if (Number(f.months) >= 1) qs.set('min_months', String(Number(f.months)));
  const p = rupeesToPaisa(f.amount);
  if (p) qs.set('min_amount', String(p));
  if (f.excludeSponsored) qs.set('exclude_sponsored', '1');
  return qs.toString();
}

/** PLAN §14.5 defaulters: filters, net-of-credit dues, phones (office), remind all, print per group. */
export function DefaultersPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const groups = useGroups().data?.items ?? [];
  const cooldown = useFeeSettings().data?.fees.reminder_cooldown_days;
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(draft);
  const qs = defaultersQuery(filters);
  const list = useQuery({
    queryKey: ['fee-defaulters', qs],
    queryFn: () => getJson<DefaultersResponse>(`/api/fees/defaulters${qs ? `?${qs}` : ''}`),
  });
  const remind = useMutation({
    mutationFn: () =>
      sendJson<{ queued: number; more: boolean; skipped?: number }>(
        'POST',
        '/api/fees/defaulters/remind',
        {
          ...(filters.grp ? { grp_id: filters.grp } : {}),
          ...(Number(filters.months) >= 1 ? { min_months: Number(filters.months) } : {}),
          ...(rupeesToPaisa(filters.amount) ? { min_amount: rupeesToPaisa(filters.amount) } : {}),
          ...(filters.excludeSponsored ? { exclude_sponsored: true } : {}),
          template: 'fee_overdue',
        },
      ),
  });
  const data = list.data;
  const groupName = groups.find((g) => g.id === filters.grp);
  const apply = (f: Filters) => {
    remind.reset();
    setDraft(f);
    setFilters(f);
  };
  const active = [
    ...(filters.grp && groupName
      ? [
          {
            id: 'group',
            label: `${groupName.programme_name} ${groupName.name}`,
            onClear: () => apply({ ...filters, grp: '' }),
          },
        ]
      : []),
    ...(Number(filters.months) >= 1
      ? [
          {
            id: 'months',
            label: `${t('fee.defaulters.minMonths')}: ${filters.months}`,
            onClear: () => apply({ ...filters, months: '' }),
          },
        ]
      : []),
    ...(rupeesToPaisa(filters.amount)
      ? [
          {
            id: 'amount',
            label: `${t('fee.defaulters.minAmount')}: ${filters.amount}`,
            onClear: () => apply({ ...filters, amount: '' }),
          },
        ]
      : []),
    ...(filters.excludeSponsored
      ? [
          {
            id: 'sponsored',
            label: t('fee.defaulters.excludeSponsored'),
            onClear: () => apply({ ...filters, excludeSponsored: false }),
          },
        ]
      : []),
  ];
  type Row = DefaultersResponse['defaulters'][number];
  const summary = !!data?.summary_only;
  const columns: Column<Row>[] = [
    {
      id: 'student',
      header: t('fee.col.student'),
      primary: true,
      cell: (d) => (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {summary || !('family_id' in d) ? (
            <bdi>{d.student_name}</bdi>
          ) : (
            <Link
              to={`/fees/family/${(d as { family_id: string }).family_id}`}
              className="relative z-[2] inline-flex min-h-11 items-center hover:underline"
            >
              <bdi>{d.student_name}</bdi>
            </Link>
          )}
          <span className="text-meta font-normal text-muted-foreground">
            <Num>{d.admission_no}</Num>
          </span>
          {'sponsored' in d && d.sponsored && (
            <StatusBadge tone="info">{t('fee.family.sponsored_badge')}</StatusBadge>
          )}
        </span>
      ),
    },
    { id: 'group', header: t('fee.col.group'), cell: (d) => <bdi>{d.group ?? '—'}</bdi> },
    {
      id: 'months',
      header: t('fee.col.months'),
      numeric: true,
      cell: (d) => (
        <StatusBadge tone={d.months_overdue >= 3 ? 'bad' : 'warn'}>
          <Num>{d.months_overdue}</Num>
        </StatusBadge>
      ),
    },
    {
      id: 'overdue',
      header: t('fee.col.overdue'),
      numeric: true,
      cell: (d) => <Money paisa={d.overdue} />,
    },
    ...(summary
      ? []
      : [
          {
            id: 'due',
            header: t('fee.col.due'),
            numeric: true,
            cell: (d: Row) => (
              <Money paisa={(d as { due: number }).due} className="font-semibold" />
            ),
          },
          {
            id: 'phone',
            header: t('fee.col.phone'),
            cell: (d: Row) => {
              const phone = (d as { guardian_phone?: string | null }).guardian_phone;
              return phone ? (
                <a
                  href={`tel:+${phone}`}
                  className="relative z-[2] inline-flex min-h-11 items-center text-brand underline-offset-4 hover:underline"
                >
                  <bdi className="num">{formatPkPhone(phone)}</bdi>
                </a>
              ) : (
                '—'
              );
            },
          },
        ]),
  ];
  return (
    <Page width="full" className="defaulters-list max-w-[1200px]">
      <PageHeader
        title={
          <>
            {t('fee.defaulters.title')}
            {groupName && (
              <span className="ms-2 font-normal">
                · <bdi>{`${groupName.programme_name} ${groupName.name}`}</bdi>
              </span>
            )}
          </>
        }
        actions={
          <Button
            variant="outline"
            id="defaulters-print"
            onClick={() => void printWhenReady()}
            className="print:hidden"
          >
            <Printer aria-hidden />
            {t('fee.defaulters.print')}
          </Button>
        }
      />
      <FeesTabs />
      <p className="hidden text-sm print:block">
        {t('fee.print.printedOn')} <Num>{karachiToday()}</Num>
      </p>
      <FilterBar id="def-filters" active={active} onClearAll={() => apply(EMPTY)}>
        <Field id="def-group" label="fee.defaulters.group">
          <Select
            id="def-group"
            value={draft.grp}
            onChange={(e) => setDraft({ ...draft, grp: e.target.value })}
          >
            <option value="">{t('fee.defaulters.allGroups')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.programme_name} {g.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="def-months" label="fee.defaulters.minMonths">
          <Input
            id="def-months"
            inputMode="numeric"
            dir="ltr"
            className="num"
            value={draft.months}
            onChange={(e) =>
              setDraft({ ...draft, months: e.target.value.replace(/\D/g, '').slice(0, 2) })
            }
          />
        </Field>
        {canReadMoney(roles) && (
          <Field id="def-amount" label="fee.defaulters.minAmount">
            <AmountInput
              id="def-amount"
              value={draft.amount}
              onChange={(v) => setDraft({ ...draft, amount: v })}
            />
          </Field>
        )}
        <div className="flex flex-col justify-end gap-2">
          <Checkbox
            id="def-exclude"
            checked={draft.excludeSponsored}
            onChange={(e) => setDraft({ ...draft, excludeSponsored: e.target.checked })}
            label={t('fee.defaulters.excludeSponsored')}
          />
          <Button type="button" id="def-filter" onClick={() => apply(draft)}>
            {t('fee.defaulters.filter')}
          </Button>
        </div>
      </FilterBar>

      {data && data.defaulters.length > 0 && (
        <StatStrip
          className="print:hidden"
          items={[
            {
              id: 'def-count',
              label: t('screens.fees.defaultersCount'),
              value: <Num>{data.defaulters.length}</Num>,
            },
            {
              id: 'def-overdue',
              label: t('fee.col.overdue'),
              value: <Mny paisa={data.defaulters.reduce((n, d) => n + d.overdue, 0)} />,
            },
            {
              id: 'def-months-max',
              label: t('screens.fees.oldest'),
              value: <Num>{Math.max(...data.defaulters.map((d) => d.months_overdue))}</Num>,
              note: t('fee.col.months'),
            },
            ...(summary
              ? []
              : [
                  {
                    id: 'def-phones',
                    label: t('screens.fees.noPhone'),
                    value: (
                      <Num>
                        {
                          data.defaulters.filter(
                            (d) => !(d as { guardian_phone?: string | null }).guardian_phone,
                          ).length
                        }
                      </Num>
                    ),
                  },
                ]),
          ]}
        />
      )}

      {/* The office reminds; a teacher's view is a dues summary only (PLAN §14.5). */}
      {canReadMoney(roles) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-3 print:hidden">
          <Button
            id="remind-all"
            onClick={() => remind.mutate()}
            disabled={remind.isPending || !data?.defaulters.length}
          >
            <BellRing aria-hidden />
            {t('fee.defaulters.remindAll')}
          </Button>
          {cooldown !== undefined && (
            <span className="flex-1 text-meta text-muted-foreground" id="remind-cooldown">
              {t('fee.defaulters.cooldown', { n: cooldown })}
              {(remind.data?.skipped ?? 0) > 0 && (
                <> {t('fee.defaulters.skipped', { count: remind.data?.skipped ?? 0 })}</>
              )}
            </span>
          )}
        </div>
      )}
      {remind.data && (
        <p
          role="status"
          id="remind-result"
          className="rounded-lg bg-ok-soft p-3 text-sm font-medium text-ok"
        >
          {t('fee.defaulters.queued', { count: remind.data.queued })}
          {remind.data.more && <> {t('fee.defaulters.more')}</>}{' '}
          <Link className="inline-flex min-h-11 items-center underline" to="/messages">
            {t('attendance.openQueue')}
          </Link>
        </p>
      )}
      <ErrorNote error={remind.error ?? list.error} />
      {data?.summary_only && (
        <p className="rounded-lg bg-info-soft p-3 text-sm text-info">
          {t('fee.defaulters.summaryNote')}
        </p>
      )}
      <Panel>
        <DataTable
          id="defaulters-table"
          caption={t('fee.defaulters.title')}
          columns={columns}
          rows={data?.defaulters}
          rowKey={(d) => d.student_id}
          loading={list.isPending}
          empty={<EmptyState icon={PartyPopper} title={t('fee.defaulters.none')} />}
        />
        {data && !data.summary_only && data.defaulters.length > 0 && (
          <p className="border-t px-4 py-3 text-end font-semibold">
            {t('fee.defaulters.total')}: <Money paisa={data.total_overdue} />
          </p>
        )}
      </Panel>
    </Page>
  );
}

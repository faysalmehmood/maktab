import { type DefaultersResponse, formatPkPhone } from '@maktab/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BellRing, Printer } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AmountInput, Money } from '@/components/fees/common';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getJson, sendJson } from '@/lib/api';
import { canReadMoney, karachiToday, rupeesToPaisa, useFeeSettings } from '@/lib/fees';
import { printWhenReady } from '@/lib/print';
import { useGroups } from '@/lib/queries';
import { useRoles } from '@/lib/roles';

type Filters = { grp: string; months: string; amount: string; excludeSponsored: boolean };

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
  const [draft, setDraft] = useState<Filters>({
    grp: '',
    months: '',
    amount: '',
    excludeSponsored: false,
  });
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    remind.reset();
    setFilters(draft);
  };
  const data = list.data;
  const groupName = groups.find((g) => g.id === filters.grp);
  return (
    <section className="defaulters-list flex max-w-4xl flex-col gap-4">
      <PageTitle
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
      >
        {t('fee.defaulters.title')}
        {groupName && (
          <span className="ms-2 font-normal">
            · <bdi>{`${groupName.programme_name} ${groupName.name}`}</bdi>
          </span>
        )}
      </PageTitle>
      <p className="hidden text-sm print:block">
        {t('fee.print.printedOn')} <Num>{karachiToday()}</Num>
      </p>
      <Card className="gap-3 py-4 print:hidden">
        <CardContent className="px-4">
          <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
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
            <Checkbox
              id="def-exclude"
              checked={draft.excludeSponsored}
              onChange={(e) => setDraft({ ...draft, excludeSponsored: e.target.checked })}
              label={t('fee.defaulters.excludeSponsored')}
            />
            <Button type="submit" id="def-filter" className="sm:col-span-2">
              {t('fee.defaulters.filter')}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* The office reminds; a teacher's view is a dues summary only (PLAN §14.5). */}
      {canReadMoney(roles) && (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <Button
            id="remind-all"
            onClick={() => remind.mutate()}
            disabled={remind.isPending || !data?.defaulters.length}
          >
            <BellRing aria-hidden />
            {t('fee.defaulters.remindAll')}
          </Button>
          {cooldown !== undefined && (
            <span className="text-xs text-muted-foreground" id="remind-cooldown">
              {t('fee.defaulters.cooldown', { n: cooldown })}
              {(remind.data?.skipped ?? 0) > 0 && (
                <> {t('fee.defaulters.skipped', { n: remind.data?.skipped ?? 0 })}</>
              )}
            </span>
          )}
        </div>
      )}
      {remind.data && (
        <p role="status" id="remind-result" className="rounded-md bg-primary/10 p-3 text-sm">
          {t('fee.defaulters.queued', { n: remind.data.queued })}
          {remind.data.more && <> {t('fee.defaulters.more')}</>}{' '}
          <Link className="inline-flex min-h-11 items-center underline" to="/messages">
            {t('attendance.openQueue')}
          </Link>
        </p>
      )}
      <ErrorNote error={remind.error ?? list.error} />
      {data?.summary_only && (
        <p className="text-sm text-muted-foreground">{t('fee.defaulters.summaryNote')}</p>
      )}
      {data && data.defaulters.length === 0 && (
        <p className="text-muted-foreground">{t('fee.defaulters.none')}</p>
      )}
      {data && data.defaulters.length > 0 && (
        <Table id="defaulters-table">
          <TableHeader>
            <TableRow>
              <TableHead>{t('fee.col.student')}</TableHead>
              <TableHead>{t('fee.col.group')}</TableHead>
              <TableHead>{t('fee.col.months')}</TableHead>
              <TableHead className="text-end">{t('fee.col.overdue')}</TableHead>
              {!data.summary_only && <TableHead className="text-end">{t('fee.col.due')}</TableHead>}
              {!data.summary_only && <TableHead>{t('fee.col.phone')}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.summary_only
              ? data.defaulters.map((d) => (
                  <TableRow key={d.student_id}>
                    <TableCell>
                      <bdi>{d.student_name}</bdi> <Num>{d.admission_no}</Num>
                    </TableCell>
                    <TableCell>
                      <bdi>{d.group ?? '—'}</bdi>
                    </TableCell>
                    <TableCell>
                      <Num>{d.months_overdue}</Num>
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={d.overdue} />
                    </TableCell>
                  </TableRow>
                ))
              : data.defaulters.map((d) => (
                  <TableRow key={d.student_id}>
                    <TableCell>
                      <Link
                        to={`/fees/family/${d.family_id}`}
                        className="inline-flex min-h-11 items-center hover:underline"
                      >
                        <bdi>{d.student_name}</bdi>
                      </Link>{' '}
                      <Num>{d.admission_no}</Num>
                      {d.sponsored && (
                        <Badge variant="outline" className="ms-1">
                          {t('fee.family.sponsored_badge')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <bdi>{d.group ?? '—'}</bdi>
                    </TableCell>
                    <TableCell>
                      <Num>{d.months_overdue}</Num>
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={d.overdue} />
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      <Money paisa={d.due} />
                    </TableCell>
                    <TableCell>
                      {d.guardian_phone ? (
                        <a
                          href={`tel:+${d.guardian_phone}`}
                          className="flex min-h-11 items-center underline"
                        >
                          <bdi className="num">{formatPkPhone(d.guardian_phone)}</bdi>
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      )}
      {data && !data.summary_only && data.defaulters.length > 0 && (
        <p className="text-end font-medium">
          {t('fee.defaulters.total')}: <Money paisa={data.total_overdue} />
        </p>
      )}
    </section>
  );
}

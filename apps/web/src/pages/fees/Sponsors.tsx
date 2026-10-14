import { formatPkPhone, type SponsorListItemDto, type SponsorStatementDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeartHandshake, Plus, Wallet } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { DateText } from '@/components/date-text';
import { FeeLinesTable } from '@/components/fees/common';
import { EndSponsorshipDialog, SponsorshipDialog } from '@/components/fees/dialogs';
import { FeesTabs } from '@/components/fees/FeesTabs';
import { ErrorNote, Field, Num } from '@/components/form';
import { isNotFound, NotFoundState } from '@/components/not-found';
import {
  EmptyState,
  ListRow,
  ListSkeleton,
  Mny,
  Page,
  PageHeader,
  Panel,
  RowList,
  StatStrip,
  StatusBadge,
} from '@/components/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson } from '@/lib/api';
import { canCollect, canManageFees, karachiToday } from '@/lib/fees';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

function AddSponsor() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [d, setD] = useState({ name: '', phone: '', cnic: '' });
  const [err, setErr] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: () => sendJson('POST', '/api/fees/sponsors', d),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['fee-sponsors'] });
      setD({ name: '', phone: '', cnic: '' });
      toast.success(t('fee.sponsor.saved'));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!d.name.trim()) return setErr('required');
    setErr(undefined);
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="grid gap-2 sm:grid-cols-3" noValidate id="sponsor-form">
      <Field id="sponsor-name" label="fee.sponsor.name" required error={err}>
        <Input
          id="sponsor-name"
          value={d.name}
          maxLength={100}
          onChange={(e) => setD({ ...d, name: e.target.value })}
        />
      </Field>
      <Field id="sponsor-phone" label="fee.sponsor.phone">
        <Input
          id="sponsor-phone"
          inputMode="tel"
          dir="ltr"
          value={d.phone}
          maxLength={20}
          onChange={(e) => setD({ ...d, phone: e.target.value })}
        />
      </Field>
      <Field id="sponsor-cnic" label="fee.sponsor.cnic">
        <Input
          id="sponsor-cnic"
          inputMode="numeric"
          dir="ltr"
          value={d.cnic}
          maxLength={15}
          onChange={(e) => setD({ ...d, cnic: e.target.value })}
        />
      </Field>
      <ErrorNote error={save.error} />
      <Button type="submit" variant="outline" className="sm:col-span-3" disabled={save.isPending}>
        <Plus aria-hidden />
        {t('fee.sponsor.add')}
      </Button>
    </form>
  );
}

export function SponsorsPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const q = useQuery({
    queryKey: ['fee-sponsors'],
    queryFn: () => getJson<{ sponsors: SponsorListItemDto[] }>('/api/fees/sponsors'),
  });
  return (
    <Page>
      <PageHeader title={t('fee.sponsor.title')} />
      <FeesTabs />
      <ErrorNote error={q.error} />
      <Panel>
        {q.isPending ? (
          <ListSkeleton rows={3} />
        ) : q.data?.sponsors.length === 0 ? (
          <EmptyState icon={HeartHandshake} title={t('fee.sponsor.none')} />
        ) : (
          <RowList>
            {q.data?.sponsors.map((s) => (
              <ListRow
                key={s.id}
                to={`/fees/sponsors/${s.id}`}
                title={<bdi>{s.name}</bdi>}
                meta={
                  <>
                    {s.phone && <bdi className="num">{formatPkPhone(s.phone)}</bdi>}
                    {s.phone && ' · '}
                    {t('fee.sponsor.activeStudents')} <Num>{s.active_students}</Num>
                  </>
                }
                trailing={
                  // A bare "PKR 0" did not say what it was: the sponsor's outstanding due.
                  <span
                    className={cn(
                      'flex flex-col items-end text-end',
                      s.due === 0 && 'text-muted-foreground',
                    )}
                    data-sponsor-due={s.due}
                  >
                    <span className="text-meta text-muted-foreground">{t('fee.col.due')}</span>
                    <Mny paisa={s.due} className={cn(s.due > 0 && 'font-semibold')} />
                  </span>
                }
              />
            ))}
          </RowList>
        )}
      </Panel>
      {canManageFees(roles) && (
        <Panel title={t('fee.sponsor.add')} bodyClassName="p-4">
          <AddSponsor />
        </Panel>
      )}
    </Page>
  );
}

export function SponsorDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const roles = useRoles();
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['fee-sponsor', id],
    queryFn: () => getJson<SponsorStatementDto>(`/api/fees/sponsors/${id}/statement`),
    enabled: !!id,
  });
  if (q.isLoading)
    return (
      <Page>
        <Panel>
          <ListSkeleton rows={4} />
        </Panel>
      </Page>
    );
  if (isNotFound(q.error))
    return <NotFoundState back={{ to: '/fees/sponsors', label: t('fee.sponsor.title') }} />;
  const s = q.data;
  if (!s) return <ErrorNote error={q.error} />;
  const today = karachiToday();
  return (
    <Page>
      <PageHeader
        back={{ to: '/fees/sponsors', label: t('fee.sponsor.title') }}
        title={<bdi>{s.sponsor.name}</bdi>}
        subtitle={
          s.sponsor.phone ? <bdi className="num">{formatPkPhone(s.sponsor.phone)}</bdi> : undefined
        }
        actions={
          canCollect(roles) && (
            <Button asChild>
              <Link to={`/fees/counter?sponsor=${s.sponsor.id}`}>
                <Wallet aria-hidden />
                {t('fee.sponsor.collect')}
              </Link>
            </Button>
          )
        }
      />
      <StatStrip
        className="lg:grid-cols-3"
        items={[
          { id: 'sp-net', label: t('fee.col.net'), value: <Mny paisa={s.totals.net} /> },
          { id: 'sp-paid', label: t('fee.col.paid'), value: <Mny paisa={s.totals.paid} /> },
          { id: 'sp-due', label: t('fee.col.due'), value: <Mny paisa={s.totals.due} /> },
        ]}
      />
      <Panel
        title={t('fee.sponsor.sponsorships')}
        action={
          canManageFees(roles) && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              {t('fee.sponsor.addSponsorship')}
            </Button>
          )
        }
        bodyClassName="flex flex-col divide-y"
      >
        {s.sponsorships.map((sp) => {
          const ended = !!sp.valid_to && sp.valid_to < today;
          return (
            <div
              key={sp.id}
              className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2"
            >
              <Link to={`/students/${sp.student_id}`} className="font-medium hover:underline">
                <bdi>{sp.student_name}</bdi>
              </Link>
              <Num>{`${sp.share_pct}%`}</Num>
              <span className="text-sm text-muted-foreground">
                <DateText iso={sp.valid_from} />
                {sp.valid_to && (
                  <>
                    {' – '}
                    <DateText iso={sp.valid_to} />
                  </>
                )}
              </span>
              {ended && <StatusBadge tone="neutral">{t('fee.sponsor.ended')}</StatusBadge>}
              {!sp.valid_to && canManageFees(roles) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ms-auto"
                  onClick={() => setEnding(sp.id)}
                >
                  {t('fee.sponsor.end')}
                </Button>
              )}
            </div>
          );
        })}
      </Panel>
      <Panel title={t('fee.sponsor.statement')} bodyClassName="flex flex-col gap-3 py-2">
        <FeeLinesTable lines={s.charges} />
        {s.receipts.length > 0 && (
          <RowList className="border-t">
            {s.receipts.map((r) => (
              <ListRow
                key={r.id}
                to={`/receipts/${r.id}`}
                title={<Num>{r.receipt_no}</Num>}
                meta={<DateText iso={r.business_date} />}
                trailing={<Mny paisa={r.amount} />}
              />
            ))}
          </RowList>
        )}
      </Panel>
      {adding && <SponsorshipDialog open sponsorId={s.sponsor.id} onOpenChange={setAdding} />}
      {ending && (
        <EndSponsorshipDialog
          open
          sponsorshipId={ending}
          onOpenChange={(o) => !o && setEnding(null)}
        />
      )}
    </Page>
  );
}

import { formatPkPhone, type SponsorListItemDto, type SponsorStatementDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Wallet } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { FeeLinesTable, Figure, Money } from '@/components/fees/common';
import { EndSponsorshipDialog, SponsorshipDialog } from '@/components/fees/dialogs';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson } from '@/lib/api';
import { canCollect, canManageFees, karachiToday } from '@/lib/fees';
import { useRoles } from '@/lib/roles';

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
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle>{t('fee.sponsor.title')}</PageTitle>
      <ErrorNote error={q.error} />
      {q.data?.sponsors.length === 0 && (
        <p className="text-muted-foreground">{t('fee.sponsor.none')}</p>
      )}
      <ul className="flex flex-col divide-y">
        {q.data?.sponsors.map((s) => (
          <li key={s.id}>
            <Link
              to={`/fees/sponsors/${s.id}`}
              className="flex min-h-11 flex-wrap items-center gap-2 py-2 hover:bg-accent"
            >
              <bdi className="font-medium">{s.name}</bdi>
              {s.phone && (
                <bdi className="num text-sm text-muted-foreground">{formatPkPhone(s.phone)}</bdi>
              )}
              <span className="text-sm text-muted-foreground">
                {t('fee.sponsor.activeStudents')} <Num>{s.active_students}</Num>
              </span>
              <span className="ms-auto">
                <Money paisa={s.due} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {canManageFees(roles) && (
        <Card className="gap-3 py-4">
          <CardContent className="px-4">
            <AddSponsor />
          </CardContent>
        </Card>
      )}
    </section>
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
  if (q.isLoading) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  const s = q.data;
  if (!s) return <ErrorNote error={q.error} />;
  const today = karachiToday();
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle
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
      >
        <bdi>{s.sponsor.name}</bdi>
      </PageTitle>
      <Card className="gap-3 py-4">
        <CardContent className="grid grid-cols-3 gap-3 px-4">
          <Figure label={t('fee.col.net')}>
            <Money paisa={s.totals.net} />
          </Figure>
          <Figure label={t('fee.col.paid')}>
            <Money paisa={s.totals.paid} />
          </Figure>
          <Figure label={t('fee.col.due')} tone="strong">
            <Money paisa={s.totals.due} />
          </Figure>
        </CardContent>
      </Card>
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle className="flex items-center gap-2">
            {t('fee.sponsor.sponsorships')}
            {canManageFees(roles) && (
              <Button
                size="sm"
                variant="outline"
                className="ms-auto"
                onClick={() => setAdding(true)}
              >
                <Plus aria-hidden />
                {t('fee.sponsor.addSponsorship')}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y px-4">
          {s.sponsorships.map((sp) => {
            const ended = !!sp.valid_to && sp.valid_to < today;
            return (
              <div key={sp.id} className="flex min-h-11 flex-wrap items-center gap-2 py-1">
                <Link to={`/students/${sp.student_id}`} className="font-medium hover:underline">
                  <bdi>{sp.student_name}</bdi>
                </Link>
                <Num>{`${sp.share_pct}%`}</Num>
                <span className="text-sm text-muted-foreground">
                  <Num>{sp.valid_from}</Num>
                  {sp.valid_to && (
                    <>
                      {' → '}
                      <Num>{sp.valid_to}</Num>
                    </>
                  )}
                </span>
                {ended && <Badge variant="outline">{t('fee.sponsor.ended')}</Badge>}
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
        </CardContent>
      </Card>
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('fee.sponsor.statement')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <FeeLinesTable lines={s.charges} />
          <ul className="flex flex-col divide-y">
            {s.receipts.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2">
                <Num>{r.business_date}</Num>
                <Link to={`/receipts/${r.id}`} className="flex min-h-11 items-center underline">
                  <Num>{r.receipt_no}</Num>
                </Link>
                <span className="ms-auto">
                  <Money paisa={r.amount} />
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      {adding && <SponsorshipDialog open sponsorId={s.sponsor.id} onOpenChange={setAdding} />}
      {ending && (
        <EndSponsorshipDialog
          open
          sponsorshipId={ending}
          onOpenChange={(o) => !o && setEnding(null)}
        />
      )}
    </section>
  );
}

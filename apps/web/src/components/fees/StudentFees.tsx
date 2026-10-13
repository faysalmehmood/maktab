import type { GenerateResultDto, StudentFeesDto } from '@maktab/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ConcessionValue, FeeLinesTable, Figure, Money } from '@/components/fees/common';
import {
  EndConcessionDialog,
  EndSponsorshipDialog,
  OpeningBalanceDialog,
  ReduceFeeDialog,
  SponsorshipDialog,
  useFeeInvalidate,
  VoidChargeDialog,
  voidUnit,
} from '@/components/fees/dialogs';
import { ErrorNote, Num } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson } from '@/lib/api';
import {
  canCollect,
  canConcession,
  canGenerate,
  canManageFees,
  karachiToday,
  money,
} from '@/lib/fees';
import { useRoles } from '@/lib/roles';

type Open =
  | { k: 'reduce' }
  | { k: 'sponsor' }
  | { k: 'opening' }
  | { k: 'endConcession'; id: string }
  | { k: 'endSponsorship'; id: string }
  | { k: 'void'; id: string }
  | null;

/** Student detail → Fees (M3b screen 10): dues, concessions, sponsorships, receipts, actions. */
export function StudentFeesCard({
  studentId,
  studentName,
}: {
  studentId: string;
  studentName: string;
}) {
  const { t } = useTranslation();
  const roles = useRoles();
  const [open, setOpen] = useState<Open>(null);
  const q = useQuery({
    queryKey: ['fee-student', studentId],
    queryFn: () => getJson<StudentFeesDto>(`/api/fees/student/${studentId}`),
  });
  const close = (o: boolean) => !o && setOpen(null);
  const invalidate = useFeeInvalidate();
  // Per-student billing for this month (a joiner the monthly run missed, or after a change):
  // POST /api/fees/regenerate is idempotent, so pressing it twice adds nothing.
  const bill = useMutation({
    mutationFn: () =>
      sendJson<GenerateResultDto>('POST', '/api/fees/regenerate', {
        student_id: studentId,
        period: karachiToday().slice(0, 7),
      }),
    onSuccess: async (r) => {
      toast.success(
        r.counts.fees > 0
          ? t('fee.billing.billed', { count: r.counts.fees })
          : t('fee.billing.billedNothing'),
      );
      await invalidate();
    },
  });
  const d = q.data;
  const today = karachiToday();
  const all = d ? [...d.lines, ...d.sponsored] : [];
  const voidLine = open?.k === 'void' ? all.find((l) => l.id === open.id) : undefined;
  return (
    <Card className="gap-3 py-4" id="student-fees">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t('fee.student.title')}
          {d && (
            <span className="ms-auto flex flex-wrap gap-1">
              {canCollect(roles) && (
                <Button asChild size="sm">
                  <Link to={`/fees/counter?family=${d.student.family_id}`}>
                    {t('fee.family.collect')}
                  </Link>
                </Button>
              )}
              <Button asChild size="sm" variant="outline">
                <Link to={`/fees/family/${d.student.family_id}`}>
                  {t('fee.student.familyStatement')}
                </Link>
              </Button>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4">
        <ErrorNote error={q.error ?? bill.error} />
        {d && canGenerate(roles) && (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            id="student-bill-month"
            disabled={bill.isPending}
            onClick={() => bill.mutate()}
          >
            {t('fee.student.billMonth')}
          </Button>
        )}
        {d && (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Figure label={t('fee.student.due')} tone="strong">
                <Money paisa={d.due} />
              </Figure>
              <Figure label={t('fee.student.familyDue')}>
                <Money paisa={d.family_due} />
              </Figure>
              <Figure label={t('fee.student.familyCredit')}>
                <Money paisa={d.family_credit} />
              </Figure>
            </div>
            {canConcession(roles) && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  id="student-reduce-fee"
                  onClick={() => setOpen({ k: 'reduce' })}
                >
                  {t('fee.family.reduceFee')}
                </Button>
                {canManageFees(roles) && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setOpen({ k: 'sponsor' })}>
                      {t('fee.family.addSponsorship')}
                    </Button>
                    {!d.opening_balance && (
                      <Button
                        size="sm"
                        variant="ghost"
                        id="student-opening"
                        onClick={() => setOpen({ k: 'opening' })}
                      >
                        {t('fee.family.openingBalance')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
            {d.opening_balance && (
              <p className="text-sm text-muted-foreground">
                {t('fee.opening.title')}:{' '}
                {t('fee.opening.recorded', {
                  amount: `\u2068${money(d.opening_balance.amount)}\u2069`,
                  date: `\u2068${d.opening_balance.as_of}\u2069`,
                })}
              </p>
            )}
            <section>
              <h3 className="text-sm font-semibold">{t('fee.student.lines')}</h3>
              <FeeLinesTable
                lines={[...d.lines, ...d.sponsored]}
                showStudent={false}
                action={
                  canManageFees(roles)
                    ? (l) =>
                        l.net !== 0 &&
                        l.payer_type === 'family' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setOpen({ k: 'void', id: l.id })}
                          >
                            {t('fee.family.void')}
                          </Button>
                        )
                    : undefined
                }
              />
            </section>
            <section>
              <h3 className="text-sm font-semibold">{t('fee.student.concessions')}</h3>
              {d.concessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('fee.concession.none')}</p>
              ) : (
                <ul className="flex flex-col divide-y" id="student-concessions">
                  {d.concessions.map((c) => {
                    const ended = !!c.ended_at || (!!c.valid_to && c.valid_to < today);
                    return (
                      <li key={c.id} className="flex min-h-11 flex-wrap items-center gap-2">
                        {t(`fee.concession.reasons.${c.reason}`)}
                        <ConcessionValue type={c.type} value={c.value} />
                        {c.head_name && (
                          <bdi className="text-sm text-muted-foreground">{c.head_name}</bdi>
                        )}
                        <span className="text-sm text-muted-foreground">
                          <Num>{c.valid_from}</Num>
                          {(c.ended_at ?? c.valid_to) && (
                            <>
                              {' → '}
                              <Num>{(c.ended_at ?? c.valid_to) as string}</Num>
                            </>
                          )}
                        </span>
                        <Badge variant={ended ? 'outline' : 'secondary'}>
                          {ended ? t('fee.concession.ended') : t('fee.concession.active')}
                        </Badge>
                        {!ended && canConcession(roles) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ms-auto"
                            onClick={() => setOpen({ k: 'endConcession', id: c.id })}
                          >
                            {t('fee.concession.end')}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            {d.sponsorships.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold">{t('fee.student.sponsorships')}</h3>
                <ul className="flex flex-col divide-y">
                  {d.sponsorships.map((s) => (
                    <li key={s.id} className="flex min-h-11 flex-wrap items-center gap-2">
                      <Link to={`/fees/sponsors/${s.sponsor_id}`} className="hover:underline">
                        <bdi>{s.sponsor_name}</bdi>
                      </Link>
                      <Num>{`${s.share_pct}%`}</Num>
                      <span className="text-sm text-muted-foreground">
                        <Num>{s.valid_from}</Num>
                        {s.valid_to && (
                          <>
                            {' → '}
                            <Num>{s.valid_to}</Num>
                          </>
                        )}
                      </span>
                      {!s.valid_to && canManageFees(roles) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ms-auto"
                          onClick={() => setOpen({ k: 'endSponsorship', id: s.id })}
                        >
                          {t('fee.sponsor.end')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="text-sm font-semibold">{t('fee.student.receipts')}</h3>
              {d.receipts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('fee.family.noReceipts')}</p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {d.receipts.slice(0, 10).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-2">
                      <Num>{r.business_date}</Num>
                      <Link
                        to={`/receipts/${r.id}`}
                        className="flex min-h-11 items-center underline"
                      >
                        <Num>{r.receipt_no}</Num>
                      </Link>
                      <span className="ms-auto">
                        <Money paisa={r.amount} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </CardContent>
      {open?.k === 'reduce' && (
        <ReduceFeeDialog
          open
          studentId={studentId}
          studentName={studentName}
          onOpenChange={close}
        />
      )}
      {open?.k === 'sponsor' && (
        <SponsorshipDialog open studentId={studentId} onOpenChange={close} />
      )}
      {open?.k === 'opening' && (
        <OpeningBalanceDialog open studentId={studentId} onOpenChange={close} />
      )}
      {open?.k === 'endConcession' && (
        <EndConcessionDialog open concessionId={open.id} onOpenChange={close} />
      )}
      {open?.k === 'endSponsorship' && (
        <EndSponsorshipDialog open sponsorshipId={open.id} onOpenChange={close} />
      )}
      {voidLine && (
        <VoidChargeDialog
          open
          line={voidLine}
          unit={voidUnit(voidLine, all)}
          onOpenChange={close}
        />
      )}
    </Card>
  );
}

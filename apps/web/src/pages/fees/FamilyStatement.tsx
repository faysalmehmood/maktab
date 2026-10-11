import type { FeeLineDto, FineDto, ReceiptDto } from '@maktab/shared';
import { Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { FeeLinesTable, Figure, Money } from '@/components/fees/common';
import {
  OpeningBalanceDialog,
  ReduceFeeDialog,
  RefundDialog,
  SponsorshipDialog,
  VoidChargeDialog,
  voidUnit,
  WaiveFineDialog,
} from '@/components/fees/dialogs';
import { ErrorNote, Num, PageTitle } from '@/components/form';
import { FamilyParentLinks } from '@/components/messages/ParentLinkPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  canCollect,
  canConcession,
  canManageFees,
  canReverse,
  fineOf,
  headLabel,
  useFamilyStatement,
} from '@/lib/fees';
import { canManageLinks } from '@/lib/messages';
import { useRoles } from '@/lib/roles';

type Dialog =
  | { kind: 'reduce'; studentId: string; name: string }
  | { kind: 'sponsor'; studentId: string }
  | { kind: 'opening'; studentId: string }
  | { kind: 'void'; line: FeeLineDto }
  | { kind: 'waive'; fine: FineDto; line: FeeLineDto }
  | { kind: 'refund' }
  | null;

type Event =
  | { at: string; type: 'charge'; line: FeeLineDto }
  | { at: string; type: 'receipt'; receipt: ReceiptDto };

/** Charges by due date and receipts by business date, newest first (the statement timeline). */
export function timeline(charges: readonly FeeLineDto[], receipts: readonly ReceiptDto[]): Event[] {
  const ev: Event[] = [
    ...charges.map((line) => ({ at: line.due_date, type: 'charge' as const, line })),
    ...receipts.map((receipt) => ({
      at: receipt.business_date,
      type: 'receipt' as const,
      receipt,
    })),
  ];
  return ev.sort((a, b) =>
    a.at === b.at ? (a.type === 'receipt' ? -1 : 1) : a.at < b.at ? 1 : -1,
  );
}

/** PLAN §14.4/§14.7: the family's statement with the admin's fee actions. */
export function FamilyStatementPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const roles = useRoles();
  const q = useFamilyStatement(id);
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = (o: boolean) => !o && setDialog(null);
  if (q.isLoading) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  const f = q.data;
  if (!f) return <ErrorNote error={q.error} />;
  const admin = canConcession(roles);
  const manage = canManageFees(roles);
  const all = [...f.charges, ...f.sponsored];
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle
        actions={
          canCollect(roles) && (
            <Button asChild id="family-collect">
              <Link to={`/fees/counter?family=${f.family.id}`}>
                <Wallet aria-hidden />
                {t('fee.family.collect')}
              </Link>
            </Button>
          )
        }
      >
        <bdi>{f.family.name}</bdi>
      </PageTitle>

      <Card className="gap-3 py-4">
        <CardContent className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-4">
          <Figure label={t('fee.counter.dueBeforeCredit')}>
            <Money paisa={f.totals.due_before_credit} />
          </Figure>
          <Figure label={t('fee.counter.credit')}>
            <Money paisa={f.credit} />
            {f.credit > 0 && canReverse(roles) && (
              <Button
                size="sm"
                variant="outline"
                className="mt-1 self-start"
                id="family-refund"
                onClick={() => setDialog({ kind: 'refund' })}
              >
                {t('fee.family.refund')}
              </Button>
            )}
          </Figure>
          <Figure label={t('fee.counter.netDue')} tone="strong">
            <Money paisa={f.totals.due} />
          </Figure>
          <Figure label={t('fee.col.overdue')}>
            <Money paisa={f.totals.overdue} />
          </Figure>
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('fee.counter.children')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y px-4">
          {f.students.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 py-2">
              <Link
                to={`/students/${s.id}`}
                className="flex min-h-11 items-center font-medium hover:underline"
              >
                <bdi>{s.name}</bdi>
              </Link>
              <Num>{s.admission_no}</Num>
              {s.group && (
                <span className="text-sm text-muted-foreground">
                  <bdi>{s.group}</bdi>
                </span>
              )}
              {s.sponsored && <Badge variant="outline">{t('fee.family.sponsored_badge')}</Badge>}
              {admin && (
                <span className="ms-auto flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    id={`reduce-${s.id}`}
                    onClick={() => setDialog({ kind: 'reduce', studentId: s.id, name: s.name })}
                  >
                    {t('fee.family.reduceFee')}
                  </Button>
                  {manage && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDialog({ kind: 'sponsor', studentId: s.id })}
                      >
                        {t('fee.family.addSponsorship')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDialog({ kind: 'opening', studentId: s.id })}
                      >
                        {t('fee.family.openingBalance')}
                      </Button>
                    </>
                  )}
                </span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('fee.family.charges')}</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {f.charges.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('fee.family.noCharges')}</p>
          ) : (
            <FeeLinesTable
              lines={f.charges}
              action={
                manage || admin
                  ? (l) => {
                      const fine = fineOf(f.fines ?? [], l.id);
                      return (
                        <span className="flex flex-wrap items-center gap-1">
                          {admin && fine && fine.left > 0 && (
                            <Button
                              size="sm"
                              variant="outline"
                              id={`waive-${fine.id}`}
                              onClick={() => setDialog({ kind: 'waive', fine, line: l })}
                            >
                              {t('fee.counter.waiveFine')}
                            </Button>
                          )}
                          {fine && fine.left <= 0 && (
                            <Badge variant="outline" data-waived={fine.id}>
                              {t('fee.counter.fineWaived')}
                            </Badge>
                          )}
                          {manage && l.net !== 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              id={`void-${l.id}`}
                              onClick={() => setDialog({ kind: 'void', line: l })}
                            >
                              {t('fee.family.void')}
                            </Button>
                          )}
                        </span>
                      );
                    }
                  : undefined
              }
            />
          )}
        </CardContent>
      </Card>

      {f.sponsored.length > 0 && (
        <Card className="gap-3 border-dashed py-4" id="family-sponsored">
          <CardHeader className="px-4">
            <CardTitle>{t('fee.family.sponsored')}</CardTitle>
            <p className="text-xs text-muted-foreground">{t('fee.counter.sponsorNote')}</p>
          </CardHeader>
          <CardContent className="px-4">
            <FeeLinesTable lines={f.sponsored} />
          </CardContent>
        </Card>
      )}

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('fee.family.receipts')}</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {f.receipts.length === 0 && f.charges.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('fee.family.noReceipts')}</p>
          ) : (
            <ol className="flex flex-col divide-y" id="family-timeline">
              {timeline(f.charges, f.receipts).map((e) =>
                e.type === 'receipt' ? (
                  <li key={`r${e.receipt.id}`} className="flex flex-wrap items-center gap-2 py-1">
                    <Num>{e.at}</Num>
                    <Link
                      to={`/receipts/${e.receipt.id}`}
                      className="flex min-h-11 items-center font-medium underline"
                    >
                      <Num>{e.receipt.receipt_no}</Num>
                    </Link>
                    <Badge variant={e.receipt.kind === 'reversal' ? 'destructive' : 'secondary'}>
                      {t(`fee.kinds.${e.receipt.kind}`)}
                    </Badge>
                    <span className="text-sm text-muted-foreground">
                      {t(`fee.methods.${e.receipt.method}`)}
                    </span>
                    {e.receipt.reversed_by && (
                      <Badge variant="outline">{t('fee.receipt.reversed')}</Badge>
                    )}
                    <span className="ms-auto">
                      <Money paisa={e.receipt.amount} className="font-medium" />
                    </span>
                  </li>
                ) : (
                  <li
                    key={`c${e.line.id}`}
                    className="flex min-h-11 flex-wrap items-center gap-2 py-1 text-sm text-muted-foreground"
                  >
                    <Num>{e.at}</Num>
                    <bdi>{e.line.student_name}</bdi>
                    <Num>{e.line.period_key}</Num>
                    <bdi>{headLabel(e.line, i18n.language)}</bdi>
                    <span className="ms-auto">
                      <Money paisa={e.line.net} />
                    </span>
                  </li>
                ),
              )}
            </ol>
          )}
        </CardContent>
      </Card>

      {dialog?.kind === 'reduce' && (
        <ReduceFeeDialog
          open
          studentId={dialog.studentId}
          studentName={dialog.name}
          onOpenChange={close}
        />
      )}
      {dialog?.kind === 'sponsor' && (
        <SponsorshipDialog open studentId={dialog.studentId} onOpenChange={close} />
      )}
      {dialog?.kind === 'opening' && (
        <OpeningBalanceDialog open studentId={dialog.studentId} onOpenChange={close} />
      )}
      {dialog?.kind === 'waive' && (
        <WaiveFineDialog open fine={dialog.fine} line={dialog.line} onOpenChange={close} />
      )}
      {dialog?.kind === 'refund' && (
        <RefundDialog open payerId={f.family.id} credit={f.credit} onOpenChange={close} />
      )}
      {dialog?.kind === 'void' && (
        <VoidChargeDialog
          open
          line={dialog.line}
          unit={voidUnit(dialog.line, all)}
          onOpenChange={close}
        />
      )}
      {canManageLinks(roles) && <FamilyParentLinks familyId={f.family.id} />}
    </section>
  );
}

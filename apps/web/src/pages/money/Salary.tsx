import type {
  GeneratePayslipsDto,
  PayrollStaffDto,
  PayslipDetailDto,
  PayslipDto,
  PayslipListDto,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router';
import { Money, ReasonDialog } from '@/components/fees/common';
import { ErrorNote, Field, PageTitle } from '@/components/form';
import { MoneyErrorNote, PayslipStatusBadge, ReportActions } from '@/components/money/common';
import {
  ApproveDialog,
  LinesEditor,
  PayDialog,
  PaySettingsDialog,
  PayslipPrint,
} from '@/components/money/payslip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getJson, sendJson } from '@/lib/api';
import { karachiToday } from '@/lib/fees';
import {
  canApprovePayslip,
  canPaySalary,
  canPreparePayroll,
  payslipKey,
  useMyPayslips,
  usePayrollStaff,
  usePayslip,
  usePayslips,
} from '@/lib/money';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

const linkCls = 'inline-flex min-h-11 items-center underline';

/** Payslips of one month as a table: staff, status, pay, net, paid, left; totals. */
function SlipsTable({
  rows,
  totals,
  showMonth = false,
}: {
  rows: readonly PayslipDto[];
  totals?: { pay: number; net: number; paid: number };
  showMonth?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {showMonth && <TableHead>{t('money.common.month')}</TableHead>}
            <TableHead>{t('money.common.staff')}</TableHead>
            <TableHead>{t('money.common.status')}</TableHead>
            <TableHead className="text-end">{t('money.salary.pay')}</TableHead>
            <TableHead className="text-end">{t('money.salary.recovery')}</TableHead>
            <TableHead className="text-end">{t('money.salary.net')}</TableHead>
            <TableHead className="text-end">{t('money.salary.paid')}</TableHead>
            <TableHead className="text-end">{t('money.salary.left')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} data-slip={r.id}>
              {showMonth && (
                <TableCell>
                  <bdi className="num">{r.period_key}</bdi>
                </TableCell>
              )}
              <TableCell>
                <Link to={`/salary/${r.id}`} className={linkCls} id={`slip-link-${r.id}`}>
                  <bdi>{r.staff_name}</bdi>
                </Link>
              </TableCell>
              <TableCell>
                <PayslipStatusBadge status={r.status} />
              </TableCell>
              <TableCell className="text-end">
                <Money paisa={r.pay} />
              </TableCell>
              <TableCell className="text-end">
                <Money paisa={r.recovery} />
              </TableCell>
              <TableCell className="text-end font-medium">
                <Money paisa={r.net} />
              </TableCell>
              <TableCell className="text-end">
                <Money paisa={r.paid} />
              </TableCell>
              <TableCell className="text-end">
                <Money paisa={r.status === 'void' ? 0 : r.net - r.paid} />
              </TableCell>
            </TableRow>
          ))}
          {totals && (
            <TableRow className="font-medium" id="slips-totals">
              <TableCell colSpan={showMonth ? 3 : 2}>{t('money.salary.totals')}</TableCell>
              <TableCell className="text-end">
                <Money paisa={totals.pay} />
              </TableCell>
              <TableCell />
              <TableCell className="text-end">
                <Money paisa={totals.net} />
              </TableCell>
              <TableCell className="text-end">
                <Money paisa={totals.paid} />
              </TableCell>
              <TableCell className="text-end">
                <Money paisa={totals.net - totals.paid} />
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function PaySettings() {
  const { t } = useTranslation();
  const q = usePayrollStaff();
  const [editing, setEditing] = useState<PayrollStaffDto | null>(null);
  const staff = q.data?.staff ?? [];
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle>{t('money.salary.staffList')}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <ErrorNote error={q.error} />
        <ul className="flex flex-col divide-y">
          {staff.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-1">
              <bdi className="font-medium">{s.name}</bdi>
              <span className="text-sm text-muted-foreground">
                {s.base_salary ? (
                  <Money paisa={s.base_salary} />
                ) : (
                  t('money.salary.setup.notOnPayroll')
                )}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ms-auto min-h-11"
                id={`pay-edit-${s.id}`}
                onClick={() => setEditing(s)}
              >
                {t('money.salary.setup.edit')}
              </Button>
            </li>
          ))}
        </ul>
        {editing && (
          <PaySettingsDialog
            key={editing.id}
            staff={editing}
            open={!!editing}
            onOpenChange={(o) => !o && setEditing(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** PLAN §14.8 salary: month → prepare drafts (chunks of 50) → list → payslip. */
export function SalaryPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const qc = useQueryClient();
  const [period, setPeriod] = useState(karachiToday().slice(0, 7));
  const q = usePayslips(period);
  const generate = useMutation({
    mutationFn: async () => {
      let created = 0;
      let skipped = 0;
      let after: string | null = null;
      for (let i = 0; i < 200; i++) {
        const r: GeneratePayslipsDto = await sendJson<GeneratePayslipsDto>(
          'POST',
          '/api/payslips/generate',
          { period, after },
        );
        created += r.created;
        skipped += r.skipped;
        if (!r.next) break;
        after = r.next;
      }
      return { created, skipped };
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['payslips'] });
      toast.success(t('money.salary.generated', r));
    },
  });
  const rows = q.data?.payslips ?? [];
  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <PageTitle
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/advances">{t('money.nav.advances')}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/reports/salaries">{t('money.salary.register')}</Link>
            </Button>
          </>
        }
      >
        {t('money.salary.title')}
      </PageTitle>
      <div className="flex flex-wrap items-end gap-2">
        <Field id="salary-period" label="money.common.month">
          <Input
            id="salary-period"
            type="month"
            dir="ltr"
            className="num"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </Field>
        {canPreparePayroll(roles) && (
          <Button
            id="salary-generate"
            disabled={generate.isPending || !/^\d{4}-\d{2}$/.test(period)}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? t('money.salary.generating') : t('money.salary.generate')}
          </Button>
        )}
      </div>
      <MoneyErrorNote error={generate.error} />
      <ErrorNote error={q.error} />
      {q.data && rows.length === 0 && (
        <p className="text-muted-foreground" id="salary-empty">
          {t('money.salary.empty')}
        </p>
      )}
      {rows.length > 0 && <SlipsTable rows={rows} totals={q.data?.totals} />}
      {canApprovePayslip(roles) && <PaySettings />}
    </section>
  );
}

function Totals({ slip }: { slip: PayslipDetailDto }) {
  const { t } = useTranslation();
  const items: [string, number][] = [
    [t('money.salary.earnings'), slip.earnings],
    [t('money.salary.deductions'), slip.deductions],
    [t('money.salary.pay'), slip.pay],
    [t('money.salary.recovery'), slip.recovery],
    [t('money.salary.net'), slip.net],
    [t('money.salary.paid'), slip.paid],
    [t('money.salary.left'), slip.status === 'void' ? 0 : slip.net - slip.paid],
    [t('money.salary.outstanding'), slip.advance.outstanding],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" id="slip-totals">
      {items.map(([label, v]) => (
        <div key={label} className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-medium">
            <Money paisa={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LinesTable({ slip }: { slip: PayslipDetailDto }) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('money.salary.kind')}</TableHead>
          <TableHead>{t('money.salary.lineNote')}</TableHead>
          <TableHead className="text-end">{t('money.common.amount')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {slip.lines.map((l) => (
          <TableRow key={l.id}>
            <TableCell>{t(`money.salary.lineKinds.${l.kind}`)}</TableCell>
            <TableCell>{l.note ? <bdi>{l.note}</bdi> : '—'}</TableCell>
            <TableCell
              className={cn(
                'text-end',
                (l.kind === 'deduction' || l.kind === 'advance_recovery') && 'text-destructive',
              )}
            >
              <Money
                paisa={
                  l.kind === 'deduction' || l.kind === 'advance_recovery' ? -l.amount : l.amount
                }
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One payslip: lines (editable while draft), approve, pay, void, print. */
export function PayslipPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const roles = useRoles();
  const qc = useQueryClient();
  const q = usePayslip(id);
  const [approving, setApproving] = useState(false);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const voidSlip = useMutation({
    mutationFn: (reason: string) =>
      sendJson<{ payslip: PayslipDetailDto }>('POST', `/api/payslips/${id}/void`, { reason }),
    onSuccess: async (r) => {
      qc.setQueryData(payslipKey(id), r);
      await qc.invalidateQueries({ queryKey: ['payslips'] });
      toast.success(t('money.salary.voidedToast'));
      setVoiding(false);
    },
  });
  if (q.isLoading) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  const slip = q.data?.payslip;
  if (!slip) return <ErrorNote error={q.error} />;
  const draft = slip.status === 'draft';
  const mayVoid =
    canApprovePayslip(roles) &&
    (slip.status === 'draft' || slip.status === 'approved') &&
    slip.paid === 0;
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle
        actions={
          <Button asChild variant="outline" id="slip-print">
            <Link to={`/payslips/${slip.id}/print`}>
              <Printer aria-hidden />
              {t('money.salary.printSlip')}
            </Link>
          </Button>
        }
      >
        {t('money.salary.slip')} · <bdi>{slip.staff_name}</bdi> ·{' '}
        <bdi className="num">{slip.period_key}</bdi>
      </PageTitle>
      <div className="flex flex-wrap items-center gap-2">
        <PayslipStatusBadge status={slip.status} />
        {slip.approved_by_name && (
          <span className="text-sm text-muted-foreground">
            {t('money.salary.approvedBy')} <bdi>{slip.approved_by_name}</bdi>
          </span>
        )}
        {slip.void_reason && (
          <span className="text-sm text-destructive">
            {t('money.common.reason')}: <bdi>{slip.void_reason}</bdi>
          </span>
        )}
      </div>
      <Totals slip={slip} />
      {draft && !slip.can_approve && canApprovePayslip(roles) && (
        <p role="note" id="slip-own" className="rounded-md bg-amber-100 p-3 text-sm text-amber-950">
          {t('money.salary.ownSlip')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {slip.can_approve && (
          <Button id="slip-approve" onClick={() => setApproving(true)}>
            {t('money.salary.approve')}
          </Button>
        )}
        {slip.status === 'approved' && canPaySalary(roles) && (
          <Button id="slip-pay" onClick={() => setPaying(true)}>
            {t('money.salary.payButton')}
          </Button>
        )}
        {mayVoid && (
          <Button variant="destructive" id="slip-void" onClick={() => setVoiding(true)}>
            {t('money.common.void')}
          </Button>
        )}
      </div>
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('money.salary.lines')}</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {draft && canPreparePayroll(roles) ? (
            <LinesEditor key={slip.lines.map((l) => l.id).join()} slip={slip} />
          ) : (
            <LinesTable slip={slip} />
          )}
        </CardContent>
      </Card>
      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('money.salary.payments')}</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {slip.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('money.salary.noPayments')}</p>
          ) : (
            <ul className="flex flex-col divide-y" id="slip-payments">
              {slip.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap gap-2 py-2">
                  <bdi className="num">{p.date}</bdi>
                  <bdi>{p.account_name}</bdi>
                  {p.note && <bdi className="text-muted-foreground">{p.note}</bdi>}
                  <span className="ms-auto font-medium">
                    <Money paisa={p.amount} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {approving && <ApproveDialog slip={slip} open={approving} onOpenChange={setApproving} />}
      {paying && <PayDialog slip={slip} open={paying} onOpenChange={setPaying} />}
      <ReasonDialog
        id="slip-void"
        open={voiding}
        onOpenChange={setVoiding}
        title={t('money.salary.voidTitle')}
        body={t('money.salary.voidBody')}
        confirmLabel={t('money.salary.voidConfirm')}
        pending={voidSlip.isPending}
        error={voidSlip.error}
        onConfirm={(reason) => voidSlip.mutate(reason)}
      />
    </section>
  );
}

/** A5 slip in Urdu or English (?lang=), independent of the app language. */
export function PayslipPrintPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useQuery({
    queryKey: payslipKey(id),
    queryFn: () => getJson<{ payslip: PayslipDetailDto }>(`/api/payslips/${id}`),
    enabled: !!id,
  });
  const p = params.get('lang');
  const lang: 'en' | 'ur' = p === 'ur' || p === 'en' ? p : i18n.language === 'ur' ? 'ur' : 'en';
  if (q.isLoading) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  const slip = q.data?.payslip;
  if (!slip) return <ErrorNote error={q.error} />;
  const chip = (active: boolean) =>
    cn(
      'min-h-11 min-w-11 rounded-md border px-3 text-sm',
      active && 'border-primary bg-primary/10 font-medium',
    );
  const set = (v: 'en' | 'ur') => {
    const n = new URLSearchParams(params);
    n.set('lang', v);
    setParams(n, { replace: true });
  };
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <span className="text-sm text-muted-foreground">{t('money.salary.slipLanguage')}</span>
        <button
          type="button"
          id="slip-lang-ur"
          lang="ur"
          className={chip(lang === 'ur')}
          aria-pressed={lang === 'ur'}
          onClick={() => set('ur')}
        >
          اردو
        </button>
        <button
          type="button"
          id="slip-lang-en"
          lang="en"
          className={chip(lang === 'en')}
          aria-pressed={lang === 'en'}
          onClick={() => set('en')}
        >
          English
        </button>
        <Button id="slip-print-now" onClick={() => window.print()}>
          <Printer aria-hidden />
          {t('money.common.print')}
        </Button>
      </div>
      <PayslipPrint slip={slip} lang={lang} />
    </section>
  );
}

/** Teacher (or any staff member): their own approved/paid payslips. */
export function MyPayslipsPage() {
  const { t } = useTranslation();
  const q = useMyPayslips();
  const [open, setOpen] = useState<string | null>(null);
  const rows = q.data?.payslips ?? [];
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle>{t('money.mine.title')}</PageTitle>
      <ErrorNote error={q.error} />
      {q.data && rows.length === 0 && (
        <p className="text-muted-foreground" id="mine-empty">
          {t('money.mine.empty')}
        </p>
      )}
      {rows.map((s) => (
        <Card key={s.id} className="gap-2 py-4" data-slip={s.id}>
          <CardHeader className="px-4">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <bdi className="num">{s.period_key}</bdi>
              <PayslipStatusBadge status={s.status} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 px-4">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                {t('money.salary.net')} <Money paisa={s.net} className="font-semibold" />
              </span>
              <span>
                {t('money.salary.paid')} <Money paisa={s.paid} />
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                id={`mine-toggle-${s.id}`}
                aria-expanded={open === s.id}
                onClick={() => setOpen(open === s.id ? null : s.id)}
              >
                {open === s.id ? t('money.salary.hideLines') : t('money.salary.showLines')}
              </Button>
              <Button asChild variant="outline">
                <Link to={`/payslips/${s.id}/print`}>
                  <Printer aria-hidden />
                  {t('money.salary.printSlip')}
                </Link>
              </Button>
            </div>
            {open === s.id && <LinesTable slip={s} />}
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

/** PLAN §14.11 salary register: payslips over a month range, print + CSV. */
export function SalaryRegisterPage() {
  const { t } = useTranslation();
  const month = karachiToday().slice(0, 7);
  const [from, setFrom] = useState(month);
  const [to, setTo] = useState(month);
  const ok = /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to) && from <= to;
  const q = useQuery({
    queryKey: ['payslips', 'register', from, to],
    queryFn: () => getJson<PayslipListDto>(`/api/reports/salaries?from=${from}&to=${to}`),
    enabled: ok,
  });
  const rows = q.data?.payslips ?? [];
  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <PageTitle
        actions={
          <ReportActions
            id="salary-register"
            csv={ok ? `/api/reports/salaries?from=${from}&to=${to}&format=csv` : null}
          />
        }
      >
        {t('money.salary.register')}
      </PageTitle>
      <div className="grid gap-2 sm:grid-cols-2 print:hidden">
        <Field id="register-from" label="money.common.from">
          <Input
            id="register-from"
            type="month"
            dir="ltr"
            className="num"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field id="register-to" label="money.common.to">
          <Input
            id="register-to"
            type="month"
            dir="ltr"
            className="num"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
      </div>
      <ErrorNote error={q.error} />
      {q.data && rows.length === 0 && (
        <p className="text-muted-foreground">{t('money.reports.noRows')}</p>
      )}
      {rows.length > 0 && <SlipsTable rows={rows} totals={q.data?.totals} showMonth />}
    </section>
  );
}

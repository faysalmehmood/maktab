import { newId } from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { AmountInput, Money } from '@/components/fees/common';
import { Field, PageTitle } from '@/components/form';
import { AccountSelect, MoneyErrorNote, ReportActions } from '@/components/money/common';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { sendJson } from '@/lib/api';
import { karachiToday, rupeesToPaisa, useAccounts } from '@/lib/fees';
import { canPaySalary, useAdvances, usePayrollStaff } from '@/lib/money';
import { useRoles } from '@/lib/roles';

/**
 * Staff advances (PLAN §14.8): a receivable, not an expense. Paid from the drawer (today) or a bank
 * account; recovered through later payslips (suggested on each new draft). Outstanding is derived.
 */

type Draft = { staff: string; amount: string; account: string; date: string; note: string };

export function validateAdvance(
  d: Draft,
  o: { today: string; cashAccount: boolean },
): Record<string, string> {
  const er: Record<string, string> = {};
  if (!d.staff) er.staff = 'required';
  const p = rupeesToPaisa(d.amount);
  if (!p) er.amount = d.amount ? 'amount_invalid' : 'required';
  if (!d.account) er.account = 'account_required';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date > o.today) er.date = 'invalid';
  else if (o.cashAccount && d.date !== o.today) er.date = 'invalid';
  return er;
}

export function AddAdvanceDialog({
  open,
  onOpenChange,
  staffId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  staffId?: string;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const today = karachiToday();
  const staff = (usePayrollStaff(open).data?.staff ?? []).filter((s) => s.status === 'active');
  const accounts = useAccounts(open).data?.accounts ?? [];
  const blank: Draft = { staff: staffId ?? '', amount: '', account: '', date: today, note: '' };
  const [d, setD] = useState<Draft>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(newId);
  const cashAccount = accounts.find((a) => a.id === d.account)?.kind === 'cash';
  const save = useMutation({
    mutationFn: (amount: number) =>
      sendJson('POST', '/api/advances', {
        id: attempt,
        staff_id: d.staff,
        amount,
        account_id: d.account,
        date: cashAccount ? today : d.date,
        note: d.note,
      }),
    onSuccess: () => {
      toast.success(t('money.advance.saved'));
      void qc.invalidateQueries({ queryKey: ['advances'] });
      void qc.invalidateQueries({ queryKey: ['payroll-staff'] });
      void qc.invalidateQueries({ queryKey: ['cash'] });
      setD(blank);
      setAttempt(newId());
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const er = validateAdvance(d, { today, cashAccount });
    setErrors(er);
    const p = rupeesToPaisa(d.amount);
    if (!Object.keys(er).length && p) save.mutate(p);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={submit} noValidate className="flex flex-col gap-3" id="advance-form">
          <DialogHeader>
            <DialogTitle>{t('money.advance.addTitle')}</DialogTitle>
            <DialogDescription>{t('money.advance.hint')}</DialogDescription>
          </DialogHeader>
          <Field id="advance-staff" label="money.common.staff" required error={errors.staff}>
            <Select
              id="advance-staff"
              value={d.staff}
              onChange={(e) => setD({ ...d, staff: e.target.value })}
            >
              <option value="">—</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="advance-amount" label="money.common.amount" required error={errors.amount}>
            <AmountInput
              id="advance-amount"
              value={d.amount}
              onChange={(v) => setD({ ...d, amount: v })}
              invalid={!!errors.amount}
            />
          </Field>
          <Field id="advance-account" label="money.common.account" required error={errors.account}>
            <AccountSelect
              id="advance-account"
              value={d.account}
              accounts={accounts}
              invalid={!!errors.account}
              onChange={(v) => setD({ ...d, account: v })}
            />
          </Field>
          <Field
            id="advance-date"
            label="money.common.date"
            required
            error={errors.date}
            hint={cashAccount ? t('money.common.cashToday') : undefined}
          >
            <Input
              id="advance-date"
              type="date"
              className="num"
              max={today}
              value={cashAccount ? today : d.date}
              disabled={cashAccount}
              onChange={(e) => setD({ ...d, date: e.target.value })}
            />
          </Field>
          <Field id="advance-note" label="money.common.note">
            <Textarea
              id="advance-note"
              value={d.note}
              maxLength={200}
              onChange={(e) => setD({ ...d, note: e.target.value })}
            />
          </Field>
          <MoneyErrorNote error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending} id="advance-save">
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Balances per staff member and the advances given (shared with the advance register). */
export function AdvanceTables() {
  const { t } = useTranslation();
  const q = useAdvances();
  return (
    <>
      <MoneyErrorNote error={q.error} />
      {q.data && q.data.balances.length === 0 && (
        <p className="text-muted-foreground">{t('money.advance.empty')}</p>
      )}
      {q.data && q.data.balances.length > 0 && (
        <div className="overflow-x-auto">
          <Table id="advance-balances">
            <TableHeader>
              <TableRow>
                <TableHead>{t('money.common.staff')}</TableHead>
                <TableHead className="text-end">{t('money.advance.advanced')}</TableHead>
                <TableHead className="text-end">{t('money.advance.recovered')}</TableHead>
                <TableHead className="text-end">{t('money.advance.outstanding')}</TableHead>
                <TableHead>{t('money.advance.last')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.balances.map((b) => (
                <TableRow key={b.staff_id} data-staff={b.staff_id}>
                  <TableCell>
                    <bdi>{b.staff_name}</bdi>
                  </TableCell>
                  <TableCell className="text-end">
                    <Money paisa={b.advanced} />
                  </TableCell>
                  <TableCell className="text-end">
                    <Money paisa={b.recovered} />
                  </TableCell>
                  <TableCell className="text-end font-semibold">
                    <Money paisa={b.outstanding} />
                  </TableCell>
                  <TableCell>
                    <bdi className="num">{b.last_advance ?? '—'}</bdi>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {q.data && q.data.advances.length > 0 && (
        <>
          <h2 className="font-semibold">{t('money.advance.history')}</h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('money.common.date')}</TableHead>
                  <TableHead>{t('money.common.staff')}</TableHead>
                  <TableHead>{t('money.common.account')}</TableHead>
                  <TableHead>{t('money.common.note')}</TableHead>
                  <TableHead className="text-end">{t('money.common.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.advances.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <bdi className="num">{a.date}</bdi>
                    </TableCell>
                    <TableCell>
                      <bdi>{a.staff_name}</bdi>
                    </TableCell>
                    <TableCell>
                      <bdi>{a.account_name}</bdi>
                    </TableCell>
                    <TableCell>
                      <bdi>{a.note ?? ''}</bdi>
                    </TableCell>
                    <TableCell className="text-end">
                      <Money paisa={a.amount} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </>
  );
}

export function AdvancesPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const [adding, setAdding] = useState(false);
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle
        actions={
          <>
            {canPaySalary(roles) && (
              <Button id="advance-add" onClick={() => setAdding(true)} className="print:hidden">
                <Plus aria-hidden />
                {t('money.advance.add')}
              </Button>
            )}
            <Button asChild variant="outline" className="print:hidden">
              <Link to="/salary">{t('money.nav.salary')}</Link>
            </Button>
          </>
        }
      >
        {t('money.advance.title')}
      </PageTitle>
      <p className="text-sm text-muted-foreground">{t('money.advance.hint')}</p>
      <AdvanceTables />
      <div className="flex flex-wrap gap-2">
        <ReportActions id="advances" csv="/api/advances?format=csv" />
      </div>
      <AddAdvanceDialog open={adding} onOpenChange={setAdding} />
    </section>
  );
}

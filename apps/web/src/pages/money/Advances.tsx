import { newId } from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { DateText } from '@/components/date-text';
import { AmountInput } from '@/components/fees/common';
import { Field } from '@/components/form';
import {
  AccountSelect,
  MoneyErrorNote,
  payOutAccounts,
  ReportActions,
} from '@/components/money/common';
import { EmptyState, Mny, Page, PageHeader, Panel } from '@/components/page';
import { RowMenu } from '@/components/row-menu';
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
  const acc = useAccounts(open).data;
  // Cash leaves only the payer's own drawer (F3): other drawers are not offered.
  const accounts = payOutAccounts(acc?.accounts ?? [], acc?.my_drawer);
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

type AdvanceList = NonNullable<ReturnType<typeof useAdvances>['data']>;
type Balance = AdvanceList['balances'][number];
type Advance = AdvanceList['advances'][number];

/**
 * Balances per staff member and the advances given (shared with the advance register): two
 * DataTables (cards on a phone, so amounts are never cut off). `onGive` adds a row menu with
 * "Give advance" for that person.
 */
export function AdvanceTables({ onGive }: { onGive?: (staffId: string) => void }) {
  const { t } = useTranslation();
  const q = useAdvances();
  const balances: Column<Balance>[] = [
    {
      id: 'staff',
      header: t('money.common.staff'),
      primary: true,
      cell: (b) => <bdi data-staff={b.staff_id}>{b.staff_name}</bdi>,
    },
    {
      id: 'outstanding',
      header: t('money.advance.outstanding'),
      numeric: true,
      cell: (b) => <Mny paisa={b.outstanding} className="font-semibold" />,
    },
    {
      id: 'advanced',
      header: t('money.advance.advanced'),
      numeric: true,
      cell: (b) => <Mny paisa={b.advanced} />,
    },
    {
      id: 'recovered',
      header: t('money.advance.recovered'),
      numeric: true,
      cell: (b) => <Mny paisa={b.recovered} />,
    },
    {
      id: 'last',
      header: t('money.advance.last'),
      cell: (b) => (b.last_advance ? <DateText iso={b.last_advance} /> : '—'),
    },
  ];
  const given: Column<Advance>[] = [
    {
      id: 'staff',
      header: t('money.common.staff'),
      primary: true,
      cell: (a) => <bdi>{a.staff_name}</bdi>,
    },
    { id: 'date', header: t('money.common.date'), cell: (a) => <DateText iso={a.date} /> },
    {
      id: 'account',
      header: t('money.common.account'),
      cell: (a) => <bdi>{a.account_name}</bdi>,
    },
    {
      id: 'note',
      header: t('money.common.note'),
      hideOnPhone: true,
      cell: (a) => (a.note ? <bdi>{a.note}</bdi> : '—'),
    },
    {
      id: 'amount',
      header: t('money.common.amount'),
      numeric: true,
      cell: (a) => <Mny paisa={a.amount} />,
    },
  ];
  // Fully recovered staff leave this list; "Advances given" below keeps their history.
  const owing = q.data?.balances.filter((b) => b.outstanding > 0);
  const total = (owing ?? []).reduce((n, b) => n + b.outstanding, 0);
  return (
    <>
      <MoneyErrorNote error={q.error} />
      <Panel
        id="advance-balances-panel"
        title={t('money.advance.outstanding')}
        action={
          owing && owing.length > 0 ? (
            <span id="advance-total" className="text-sm font-semibold">
              <Mny paisa={total} />
            </span>
          ) : undefined
        }
      >
        <DataTable
          id="advance-balances"
          caption={t('money.advance.outstanding')}
          columns={balances}
          rows={owing}
          rowKey={(b) => b.staff_id}
          loading={q.isPending}
          rowActions={
            onGive
              ? (b) => (
                  <RowMenu
                    className="print:hidden"
                    label={`${t('shell.rowMenu')}: ${b.staff_name}`}
                    actions={[
                      {
                        id: `advance-give-${b.staff_id}`,
                        label: t('money.advance.add'),
                        icon: HandCoins,
                        onSelect: () => onGive(b.staff_id),
                      },
                    ]}
                  />
                )
              : undefined
          }
          empty={
            <EmptyState
              icon={HandCoins}
              title={t(
                q.data && q.data.advances.length > 0
                  ? 'money.advance.noneOwed'
                  : 'money.advance.empty',
              )}
            />
          }
        />
      </Panel>
      {q.data && q.data.advances.length > 0 && (
        <Panel title={t('money.advance.history')}>
          <DataTable
            id="advance-history"
            caption={t('money.advance.history')}
            columns={given}
            rows={q.data.advances}
            rowKey={(a) => a.id}
          />
        </Panel>
      )}
    </>
  );
}

export function AdvancesPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  // `null` closed; '' open with no one chosen; a staff id when opened from a row.
  const [adding, setAdding] = useState<string | null>(null);
  const pay = canPaySalary(roles);
  return (
    <Page>
      <PageHeader
        title={t('money.advance.title')}
        subtitle={t('money.advance.hint')}
        actions={
          <>
            <ReportActions id="advances" csv="/api/advances?format=csv" />
            <Button asChild variant="outline" className="print:hidden">
              <Link to="/salary">{t('money.nav.salary')}</Link>
            </Button>
            {pay && (
              <Button id="advance-add" onClick={() => setAdding('')} className="print:hidden">
                <Plus aria-hidden />
                {t('money.advance.add')}
              </Button>
            )}
          </>
        }
      />
      <AdvanceTables onGive={pay ? setAdding : undefined} />
      {adding !== null && (
        <AddAdvanceDialog
          key={adding}
          open
          staffId={adding || undefined}
          onOpenChange={(o) => !o && setAdding(null)}
        />
      )}
    </Page>
  );
}

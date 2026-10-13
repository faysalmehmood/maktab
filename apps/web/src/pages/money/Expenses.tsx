import { type ExpenseDto, type ExpenseListDto, newId } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Camera, ImageIcon, Plus, ReceiptText } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable } from '@/components/data-table';
import { AmountInput, ReasonDialog } from '@/components/fees/common';
import { type ActiveFilter, FilterBar } from '@/components/filter-bar';
import { Field } from '@/components/form';
import {
  AccountSelect,
  MoneyErrorNote,
  payOutAccounts,
  ReportActions,
} from '@/components/money/common';
import {
  EmptyState,
  ListSkeleton,
  Mny,
  Page,
  PageHeader,
  Panel,
  StatusBadge,
} from '@/components/page';
import { RowMenu } from '@/components/row-menu';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { Textarea } from '@/components/ui/textarea';
import { getJson, sendJson, uploadFile } from '@/lib/api';
import { karachiToday, rupeesToPaisa, useAccounts } from '@/lib/fees';
import { resizeToJpeg } from '@/lib/image';
import { canCreateExpense, canVoidExpense, nameIn, useExpenseCategories } from '@/lib/money';
import { useRoles } from '@/lib/roles';

/**
 * PLAN §14.8 expenses: date, category, amount, paid from (drawer or bank), vendor, note, optional
 * bill photo → EXP number; void with a reason only (owner/admin). Cash leaves today's drawer, so a
 * drawer expense is always dated today; a bank expense may be dated earlier, never later.
 */

type Draft = {
  category: string;
  amount: string;
  account: string;
  date: string;
  vendor: string;
  note: string;
  photo: File | null;
};

export function validateExpense(
  d: Draft,
  o: { today: string; cashAccount: boolean },
): Record<string, string> {
  const er: Record<string, string> = {};
  if (!d.category) er.category = 'required';
  const p = rupeesToPaisa(d.amount);
  if (!p) er.amount = d.amount ? 'amount_invalid' : 'required';
  if (!d.account) er.account = 'account_required';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.date > o.today) er.date = 'invalid';
  else if (o.cashAccount && d.date !== o.today) er.date = 'invalid';
  return er;
}

export function AddExpenseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const today = karachiToday();
  const cats = (useExpenseCategories(open).data?.categories ?? []).filter((c) => !c.system);
  const acc = useAccounts(open).data;
  // Cash leaves only the payer's own drawer (F3): other drawers are not offered.
  const accounts = payOutAccounts(acc?.accounts ?? [], acc?.my_drawer);
  const blank: Draft = {
    category: '',
    amount: '',
    account: '',
    date: today,
    vendor: '',
    note: '',
    photo: null,
  };
  const [d, setD] = useState<Draft>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // One id per attempt: a retry after a lost answer returns the same expense, never a second one.
  const [attempt, setAttempt] = useState(newId);
  const cashAccount = accounts.find((a) => a.id === d.account)?.kind === 'cash';
  const save = useMutation({
    mutationFn: async (amount: number) => {
      const r = await sendJson<{ expense: ExpenseDto }>('POST', '/api/expenses', {
        id: attempt,
        category_id: d.category,
        amount,
        account_id: d.account,
        date: cashAccount ? today : d.date,
        vendor: d.vendor,
        note: d.note,
      });
      if (d.photo) {
        const jpeg = await resizeToJpeg(d.photo);
        await uploadFile(`/api/expenses/${r.expense.id}/photo`, jpeg, 'bill.jpg');
      }
      return r.expense;
    },
    onSuccess: (e) => {
      toast.success(t('money.expense.saved', { no: e.expense_no }));
      void qc.invalidateQueries({ queryKey: ['expenses'] });
      void qc.invalidateQueries({ queryKey: ['cash'] });
      setD(blank);
      setAttempt(newId());
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const er = validateExpense(d, { today, cashAccount });
    setErrors(er);
    const p = rupeesToPaisa(d.amount);
    if (!Object.keys(er).length && p) save.mutate(p);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={submit} noValidate className="flex flex-col gap-3" id="expense-form">
          <DialogHeader>
            <DialogTitle>{t('money.expense.addTitle')}</DialogTitle>
            <DialogDescription>{t('money.common.drawerHint')}</DialogDescription>
          </DialogHeader>
          <Field
            id="expense-category"
            label="money.common.category"
            required
            error={errors.category}
          >
            <Select
              id="expense-category"
              value={d.category}
              onChange={(e) => setD({ ...d, category: e.target.value })}
            >
              <option value="">—</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {nameIn(c, i18n.language)}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="expense-amount" label="money.common.amount" required error={errors.amount}>
            <AmountInput
              id="expense-amount"
              value={d.amount}
              onChange={(v) => setD({ ...d, amount: v })}
              invalid={!!errors.amount}
            />
          </Field>
          <Field id="expense-account" label="money.common.account" required error={errors.account}>
            <AccountSelect
              id="expense-account"
              value={d.account}
              accounts={accounts}
              invalid={!!errors.account}
              onChange={(v) => setD({ ...d, account: v })}
            />
          </Field>
          <Field
            id="expense-date"
            label="money.common.date"
            required
            error={errors.date}
            hint={cashAccount ? t('money.common.cashToday') : undefined}
          >
            <Input
              id="expense-date"
              type="date"
              className="num"
              max={today}
              value={cashAccount ? today : d.date}
              disabled={cashAccount}
              onChange={(e) => setD({ ...d, date: e.target.value })}
            />
          </Field>
          <Field id="expense-vendor" label="money.common.vendor">
            <Input
              id="expense-vendor"
              value={d.vendor}
              maxLength={120}
              onChange={(e) => setD({ ...d, vendor: e.target.value })}
            />
          </Field>
          <Field id="expense-note" label="money.common.note">
            <Textarea
              id="expense-note"
              value={d.note}
              maxLength={300}
              onChange={(e) => setD({ ...d, note: e.target.value })}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-photo">{t('money.expense.photo')}</Label>
            <label
              htmlFor="expense-photo"
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm hover:bg-accent"
            >
              <Camera className="size-4" aria-hidden />
              {d.photo ? <bdi>{d.photo.name}</bdi> : t('money.expense.photoHint')}
            </label>
            <input
              id="expense-photo"
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => setD({ ...d, photo: e.target.files?.[0] ?? null })}
            />
          </div>
          <MoneyErrorNote error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={save.isPending} id="expense-save">
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A missing bill photo can be added later from the row (the recorder, or an owner/admin). */
function AddPhotoButton({ e }: { e: ExpenseDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const add = useMutation({
    mutationFn: async (file: File) =>
      uploadFile(`/api/expenses/${e.id}/photo`, await resizeToJpeg(file), 'bill.jpg'),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['expenses'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : t('common.error')),
  });
  const id = `expense-add-photo-${e.id}`;
  return (
    <Button asChild variant="outline" size="sm" className="min-h-11">
      <label htmlFor={id} aria-disabled={add.isPending}>
        <Camera aria-hidden />
        {t('money.expense.addPhoto')}
        <input
          id={id}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          disabled={add.isPending}
          onChange={(ev) => {
            const f = ev.target.files?.[0];
            if (f) add.mutate(f);
          }}
        />
      </label>
    </Button>
  );
}

/** The bill cell: look at the photo, or add a missing one (never only Void; UI plan 4.6.8). */
function BillCell({ e, canAddPhoto }: { e: ExpenseDto; canAddPhoto: boolean }) {
  const { t } = useTranslation();
  if (e.has_photo)
    return (
      <Button asChild variant="outline" size="sm">
        <a href={`/api/expenses/${e.id}/photo`} target="_blank" rel="noreferrer">
          <ImageIcon aria-hidden />
          {t('money.expense.viewPhoto')}
        </a>
      </Button>
    );
  if (!e.voided && canAddPhoto) return <AddPhotoButton e={e} />;
  return <span className="text-muted-foreground">—</span>;
}

/**
 * The expense list on the shared DataTable: what was bought (category, vendor, note, a void reason)
 * as the row's name, its number, date, account and amount, the bill; Void (owner/admin) sits in the
 * row's "more" menu, last and red, behind the reason dialog.
 */
function ExpenseTable({
  rows,
  onVoid,
  canAddPhoto,
}: {
  rows: readonly ExpenseDto[];
  onVoid?: (e: ExpenseDto) => void;
  canAddPhoto: boolean;
}) {
  const { t, i18n } = useTranslation();
  const columns: Column<ExpenseDto>[] = [
    {
      id: 'what',
      header: t('money.common.category'),
      primary: true,
      cell: (e) => (
        <span className="flex min-w-0 flex-col gap-0.5" data-expense={e.id}>
          <span>
            <bdi>
              {nameIn({ name: e.category_name, name_ur: e.category_name_ur }, i18n.language)}
            </bdi>
            {e.vendor && (
              <span className="font-normal text-muted-foreground">
                {' · '}
                <bdi>{e.vendor}</bdi>
              </span>
            )}
          </span>
          {e.note && (
            <span className="text-meta font-normal text-muted-foreground">
              <bdi>{e.note}</bdi>
            </span>
          )}
          {e.voided && e.void_reason && (
            <span className="text-meta font-normal text-bad">
              {t('money.common.reason')}: <bdi>{e.void_reason}</bdi>
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'no',
      header: t('money.expense.number'),
      cell: (e) => <bdi className="num whitespace-nowrap">{e.expense_no}</bdi>,
    },
    {
      id: 'date',
      header: t('money.common.date'),
      cell: (e) => <bdi className="num whitespace-nowrap">{e.date}</bdi>,
    },
    {
      id: 'account',
      header: t('money.common.account'),
      cell: (e) => <bdi>{e.account_name}</bdi>,
    },
    {
      id: 'amount',
      header: t('money.common.amount'),
      numeric: true,
      cell: (e) => (
        <span className="inline-flex flex-col items-end gap-1">
          <Mny paisa={e.amount} className={e.voided ? 'line-through opacity-70' : undefined} />
          {e.voided && <StatusBadge tone="bad">{t('money.common.voided')}</StatusBadge>}
        </span>
      ),
    },
    {
      id: 'bill',
      header: t('money.expense.photo'),
      className: 'print:hidden',
      cell: (e) => <BillCell e={e} canAddPhoto={canAddPhoto} />,
    },
  ];
  return (
    <DataTable
      id="expense-table"
      caption={t('money.expense.title')}
      columns={columns}
      rows={rows}
      rowKey={(e) => e.id}
      rowActions={
        onVoid
          ? (e) =>
              e.voided ? null : (
                <RowMenu
                  className="print:hidden"
                  label={`${t('shell.rowMenu')}: ${e.expense_no}`}
                  actions={[
                    {
                      id: `expense-void-${e.id}`,
                      label: t('money.common.void'),
                      icon: Ban,
                      destructive: true,
                      onSelect: () => onVoid(e),
                    },
                  ]}
                />
              )
          : undefined
      }
    />
  );
}

/** Filters shared by the Expenses page and the expense register. */
export function useExpenseFilters() {
  const today = karachiToday();
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [category, setCategory] = useState('');
  const [account, setAccount] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [q, setQ] = useState('');
  const qs = new URLSearchParams({ from, to });
  if (category) qs.set('category_id', category);
  if (account) qs.set('account_id', account);
  if (includeVoid) qs.set('include_void', '1');
  if (q.trim()) qs.set('q', q.trim());
  return {
    from,
    setFrom,
    to,
    setTo,
    category,
    setCategory,
    account,
    setAccount,
    includeVoid,
    setIncludeVoid,
    q,
    setQ,
    qs: qs.toString(),
    valid: from <= to,
  };
}

export function ExpenseFilters({ f }: { f: ReturnType<typeof useExpenseFilters> }) {
  const { t, i18n } = useTranslation();
  const cats = useExpenseCategories().data?.categories ?? [];
  const accounts = useAccounts().data?.accounts ?? [];
  const cat = cats.find((c) => c.id === f.category);
  const acc = accounts.find((a) => a.id === f.account);
  // Dates are always set (this month by default), so only the optional filters become chips.
  const active: ActiveFilter[] = [];
  if (f.category)
    active.push({
      id: 'category',
      label: (
        <>
          {t('money.common.category')}: <bdi>{cat ? nameIn(cat, i18n.language) : '…'}</bdi>
        </>
      ),
      onClear: () => f.setCategory(''),
    });
  if (f.account)
    active.push({
      id: 'account',
      label: (
        <>
          {t('money.common.account')}: <bdi>{acc?.name ?? '…'}</bdi>
        </>
      ),
      onClear: () => f.setAccount(''),
    });
  if (f.includeVoid)
    active.push({
      id: 'void',
      label: t('money.common.includeVoid'),
      onClear: () => f.setIncludeVoid(false),
    });
  return (
    <FilterBar
      id="expense-filters"
      className="rounded-xl border bg-card p-4"
      search={
        <Field id="exp-q" label="money.common.search">
          <Input
            id="exp-q"
            type="search"
            value={f.q}
            maxLength={60}
            onChange={(e) => f.setQ(e.target.value)}
          />
        </Field>
      }
      active={active}
      onClearAll={() => {
        f.setCategory('');
        f.setAccount('');
        f.setIncludeVoid(false);
      }}
    >
      <Field id="exp-from" label="money.common.from">
        <Input
          id="exp-from"
          type="date"
          className="num"
          value={f.from}
          onChange={(e) => f.setFrom(e.target.value)}
        />
      </Field>
      <Field id="exp-to" label="money.common.to">
        <Input
          id="exp-to"
          type="date"
          className="num"
          value={f.to}
          onChange={(e) => f.setTo(e.target.value)}
        />
      </Field>
      <Field id="exp-category" label="money.common.category">
        <Select
          id="exp-category"
          value={f.category}
          onChange={(e) => f.setCategory(e.target.value)}
        >
          <option value="">{t('money.common.all')}</option>
          {cats
            .filter((c) => !c.system)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {nameIn(c, i18n.language)}
              </option>
            ))}
        </Select>
      </Field>
      <Field id="exp-account" label="money.common.account">
        <AccountSelect
          id="exp-account"
          value={f.account}
          accounts={accounts}
          onChange={f.setAccount}
        />
      </Field>
      {/* The shared 44 px row label: the whole line is the touch target (verify pass). */}
      <Checkbox
        id="exp-include-void"
        className="min-w-11 self-end"
        checked={f.includeVoid}
        onChange={(e) => f.setIncludeVoid(e.target.checked)}
        label={t('money.common.includeVoid')}
      />
    </FilterBar>
  );
}

export function ExpensesPage() {
  const { t } = useTranslation();
  const roles = useRoles();
  const qc = useQueryClient();
  const f = useExpenseFilters();
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<ExpenseDto | null>(null);
  const q = useQuery({
    queryKey: ['expenses', f.qs],
    queryFn: () => getJson<ExpenseListDto>(`/api/expenses?${f.qs}`),
    enabled: f.valid,
  });
  const voidIt = useMutation({
    mutationFn: (o: { id: string; reason: string }) =>
      sendJson('POST', `/api/expenses/${o.id}/void`, { reason: o.reason }),
    onSuccess: () => {
      toast.success(t('money.expense.voidedToast'));
      setVoiding(null);
      void qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
  return (
    <Page>
      <PageHeader
        title={t('money.expense.title')}
        help="income-expense"
        actions={
          <>
            <ReportActions id="expenses" csv={`/api/expenses?${f.qs}&format=csv`} />
            {canCreateExpense(roles) && (
              <Button id="expense-add" onClick={() => setAdding(true)} className="print:hidden">
                <Plus aria-hidden />
                {t('money.expense.add')}
              </Button>
            )}
          </>
        }
      />
      <ExpenseFilters f={f} />
      <MoneyErrorNote error={q.error} />
      {q.isPending && f.valid && (
        <Panel>
          <ListSkeleton rows={4} />
        </Panel>
      )}
      {q.data && q.data.expenses.length === 0 && (
        <Panel>
          <EmptyState icon={ReceiptText} title={t('money.expense.empty')} />
        </Panel>
      )}
      {q.data && q.data.expenses.length > 0 && (
        <Panel
          title={
            <span id="expense-total" className="flex flex-wrap gap-2">
              {t('money.expense.totalLine')} <Mny paisa={q.data.total} />
            </span>
          }
        >
          <ExpenseTable
            rows={q.data.expenses}
            onVoid={canVoidExpense(roles) ? setVoiding : undefined}
            canAddPhoto={canCreateExpense(roles)}
          />
        </Panel>
      )}
      <AddExpenseDialog open={adding} onOpenChange={setAdding} />
      {voiding && (
        <ReasonDialog
          id="expense-void"
          open
          onOpenChange={(o) => !o && setVoiding(null)}
          title={t('money.expense.voidTitle', { no: voiding.expense_no })}
          body={t('money.expense.voidBody')}
          confirmLabel={t('money.expense.voidConfirm')}
          pending={voidIt.isPending}
          error={voidIt.error}
          onConfirm={(reason) => voidIt.mutate({ id: voiding.id, reason })}
        />
      )}
    </Page>
  );
}

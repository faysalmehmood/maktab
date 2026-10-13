import { type ExpenseDto, type ExpenseListDto, newId } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Camera, ImageIcon, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AmountInput, Money, ReasonDialog } from '@/components/fees/common';
import { Field, PageTitle } from '@/components/form';
import {
  AccountSelect,
  MoneyErrorNote,
  payOutAccounts,
  ReportActions,
} from '@/components/money/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

/**
 * One expense. Its first actions look at it (the bill photo, or adding one that is missing); Void
 * is secondary, at the far end, never the only thing a row offers (UI plan 4.6.8).
 */
function ExpenseRow({
  e,
  onVoid,
  canAddPhoto = false,
}: {
  e: ExpenseDto;
  onVoid?: (e: ExpenseDto) => void;
  canAddPhoto?: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Card className="gap-1 py-3" data-expense={e.id}>
      <CardContent className="flex flex-col gap-1 px-4">
        <div className="flex flex-wrap items-center gap-2">
          <bdi className="num text-sm text-muted-foreground">{e.expense_no}</bdi>
          <bdi className="num text-sm text-muted-foreground">{e.date}</bdi>
          {e.voided && <Badge variant="destructive">{t('money.common.voided')}</Badge>}
          <span className={e.voided ? 'ms-auto line-through' : 'ms-auto font-semibold'}>
            <Money paisa={e.amount} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <bdi className="font-medium">
            {nameIn({ name: e.category_name, name_ur: e.category_name_ur }, i18n.language)}
          </bdi>
          {e.vendor && (
            <>
              · <bdi>{e.vendor}</bdi>
            </>
          )}
          · <bdi>{e.account_name}</bdi>
        </div>
        {e.note && (
          <p className="text-sm text-muted-foreground">
            <bdi>{e.note}</bdi>
          </p>
        )}
        {e.voided && e.void_reason && (
          <p className="text-sm text-destructive">
            {t('money.common.reason')}: <bdi>{e.void_reason}</bdi>
          </p>
        )}
        <div className="flex flex-wrap gap-2 print:hidden">
          {e.has_photo && (
            <Button asChild variant="outline" size="sm" className="min-h-11">
              <a href={`/api/expenses/${e.id}/photo`} target="_blank" rel="noreferrer">
                <ImageIcon aria-hidden />
                {t('money.expense.viewPhoto')}
              </a>
            </Button>
          )}
          {!e.has_photo && !e.voided && canAddPhoto && <AddPhotoButton e={e} />}
          {onVoid && !e.voided && (
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto min-h-11 text-destructive"
              id={`expense-void-${e.id}`}
              onClick={() => onVoid(e)}
            >
              <Ban aria-hidden />
              {t('money.common.void')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
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
  return (
    <div className="grid gap-2 sm:grid-cols-3 print:hidden">
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
      <Field id="exp-q" label="money.common.search">
        <Input id="exp-q" value={f.q} maxLength={60} onChange={(e) => f.setQ(e.target.value)} />
      </Field>
      {/* The shared 44 px row label: the whole line is the touch target (verify pass). */}
      <Checkbox
        id="exp-include-void"
        className="min-w-11 self-end"
        checked={f.includeVoid}
        onChange={(e) => f.setIncludeVoid(e.target.checked)}
        label={t('money.common.includeVoid')}
      />
    </div>
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
    <section className="flex max-w-4xl flex-col gap-4">
      <PageTitle
        actions={
          <>
            {canCreateExpense(roles) && (
              <Button id="expense-add" onClick={() => setAdding(true)} className="print:hidden">
                <Plus aria-hidden />
                {t('money.expense.add')}
              </Button>
            )}
            <ReportActions id="expenses" csv={`/api/expenses?${f.qs}&format=csv`} />
          </>
        }
      >
        {t('money.expense.title')}
      </PageTitle>
      <ExpenseFilters f={f} />
      <MoneyErrorNote error={q.error} />
      {q.data && q.data.expenses.length === 0 && (
        <p className="text-muted-foreground">{t('money.expense.empty')}</p>
      )}
      {q.data && q.data.expenses.length > 0 && (
        <>
          <p className="flex flex-wrap gap-2 font-medium" id="expense-total">
            {t('money.expense.totalLine')}
            <span className="ms-auto">
              <Money paisa={q.data.total} />
            </span>
          </p>
          <div className="flex flex-col gap-2">
            {q.data.expenses.map((e) => (
              <ExpenseRow
                key={e.id}
                e={e}
                onVoid={canVoidExpense(roles) ? setVoiding : undefined}
                canAddPhoto={canCreateExpense(roles)}
              />
            ))}
          </div>
        </>
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
    </section>
  );
}

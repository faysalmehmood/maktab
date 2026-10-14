import {
  formatPkPhone,
  newId,
  PAYSLIP_LINE_KINDS,
  type PayrollStaffDto,
  type PayslipDetailDto,
  type PayslipLineKind,
} from '@maktab/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateText } from '@/components/date-text';
import { AmountInput, Money } from '@/components/fees/common';
import { Field } from '@/components/form';
import { AccountSelect, MoneyErrorNote, payOutAccounts } from '@/components/money/common';
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
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { useLanguageResources } from '@/i18n';
import { sendJson } from '@/lib/api';
import { karachiToday, money, paisaToRupeeText, rupeesToPaisa, useAccounts } from '@/lib/fees';
import { payslipKey } from '@/lib/money';
import { cn } from '@/lib/utils';

/** Sign of a line in the net: basic and allowance add; deduction and advance recovery subtract. */
const sign = (k: PayslipLineKind) => (k === 'basic' || k === 'allowance' ? 1 : -1);

export type EditLine = { key: string; kind: PayslipLineKind; amount: string; note: string };

type LineOut = { kind: PayslipLineKind; amount: number; note: string | null };
type LinesCheck =
  | { ok: true; lines: LineOut[]; net: number }
  | { ok: false; error: 'noLines' | 'amount_invalid' | 'negative_net'; key?: string };

/** Client-side check of a draft's lines: codes are errors.* keys (or money.salary.noLines). */
export function checkLines(lines: readonly EditLine[]): LinesCheck {
  if (!lines.length) return { ok: false, error: 'noLines' };
  const out: LineOut[] = [];
  let net = 0;
  for (const l of lines) {
    const p = rupeesToPaisa(l.amount);
    if (!p || p <= 0) return { ok: false, error: 'amount_invalid', key: l.key };
    out.push({ kind: l.kind, amount: p, note: l.note.trim() || null });
    net += sign(l.kind) * p;
  }
  if (net < 0) return { ok: false, error: 'negative_net' };
  return { ok: true, lines: out, net };
}

/** Draft lines editor (PLAN §14.8): kind, amount, label; PUT /api/payslips/:id/lines. */
export function LinesEditor({ slip }: { slip: PayslipDetailDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [lines, setLines] = useState<EditLine[]>(() =>
    slip.lines.map((l) => ({
      key: l.id,
      kind: l.kind,
      amount: paisaToRupeeText(l.amount),
      note: l.note ?? '',
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [badKey, setBadKey] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (body: {
      lines: { kind: PayslipLineKind; amount: number; note: string | null }[];
    }) => sendJson<{ payslip: PayslipDetailDto }>('PUT', `/api/payslips/${slip.id}/lines`, body),
    onSuccess: async (r) => {
      qc.setQueryData(payslipKey(slip.id), r);
      await qc.invalidateQueries({ queryKey: ['payslips'] });
      toast.success(t('money.salary.linesSaved'));
    },
  });
  const set = (key: string, patch: Partial<EditLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const c = checkLines(lines);
    if (!c.ok) {
      setError(c.error);
      setBadKey(c.key);
      return;
    }
    setError(null);
    setBadKey(undefined);
    save.mutate({ lines: c.lines });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate id="lines-form">
      {lines.map((l, i) => (
        <div
          key={l.key}
          className="grid gap-2 rounded-md border p-2 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end"
          data-line={i}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`line-kind-${i}`}>{t('money.salary.kind')}</Label>
            <Select
              id={`line-kind-${i}`}
              value={l.kind}
              onChange={(e) => set(l.key, { kind: e.target.value as PayslipLineKind })}
            >
              {PAYSLIP_LINE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`money.salary.lineKinds.${k}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`line-amount-${i}`}>{t('money.common.amount')}</Label>
            <AmountInput
              id={`line-amount-${i}`}
              value={l.amount}
              invalid={badKey === l.key}
              onChange={(v) => set(l.key, { amount: v })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`line-note-${i}`}>{t('money.salary.lineNote')}</Label>
            <Input
              id={`line-note-${i}`}
              value={l.note}
              maxLength={80}
              onChange={(e) => set(l.key, { note: e.target.value })}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={t('money.salary.removeLine')}
            id={`line-remove-${i}`}
            onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      {error && (
        <p role="alert" id="lines-error" className="text-sm text-destructive">
          {error === 'noLines'
            ? t('money.salary.noLines')
            : t(`errors.${error}` as 'errors.required')}
        </p>
      )}
      <MoneyErrorNote error={save.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          id="lines-add"
          onClick={() =>
            setLines((ls) => [...ls, { key: newId(), kind: 'deduction', amount: '', note: '' }])
          }
        >
          <Plus aria-hidden />
          {t('money.salary.addLine')}
        </Button>
        <Button type="submit" id="lines-save" disabled={save.isPending}>
          {t('money.salary.saveLines')}
        </Button>
      </div>
    </form>
  );
}

/** Approve confirmation (owner/admin, not for your own slip — the server decides can_approve). */
export function ApproveDialog({
  slip,
  open,
  onOpenChange,
}: {
  slip: PayslipDetailDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const approve = useMutation({
    mutationFn: () =>
      sendJson<{ payslip: PayslipDetailDto }>('POST', `/api/payslips/${slip.id}/approve`),
    onSuccess: async (r) => {
      qc.setQueryData(payslipKey(slip.id), r);
      await qc.invalidateQueries({ queryKey: ['payslips'] });
      toast.success(t('money.salary.approved'));
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('money.salary.approveTitle')}</DialogTitle>
          <DialogDescription>
            {t('money.salary.approveBody', { net: `⁨${money(slip.net)}⁩` })}
          </DialogDescription>
        </DialogHeader>
        <MoneyErrorNote error={approve.error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            id="approve-confirm"
            disabled={approve.isPending}
            onClick={() => approve.mutate()}
          >
            {t('money.salary.approve')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pay (part of) an approved slip: amount ≤ what is left, from an account; a drawer (cash account)
 * pays today only. One client-minted id per attempt, so a retried click never pays twice.
 */
export function PayDialog({
  slip,
  open,
  onOpenChange,
}: {
  slip: PayslipDetailDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const acc = useAccounts(open).data;
  // Cash leaves only the payer's own drawer (F3): other drawers are not offered.
  const accounts = payOutAccounts(acc?.accounts ?? [], acc?.my_drawer);
  const left = slip.net - slip.paid;
  const today = karachiToday();
  const [amount, setAmount] = useState(() => (left > 0 ? paisaToRupeeText(left) : ''));
  const [account, setAccount] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [attempt, setAttempt] = useState(() => newId());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [over, setOver] = useState(false);
  const isCash = accounts.find((a) => a.id === account)?.kind === 'cash';
  const pay = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      sendJson<{ payslip: PayslipDetailDto }>('POST', `/api/payslips/${slip.id}/pay`, body),
    onSuccess: async (r) => {
      qc.setQueryData(payslipKey(slip.id), { payslip: r.payslip });
      await qc.invalidateQueries({ queryKey: ['payslips'] });
      toast.success(t('money.salary.paidToast'));
      setAttempt(newId());
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const er: Record<string, string> = {};
    const p = rupeesToPaisa(amount);
    if (!p) er.amount = amount ? 'amount_invalid' : 'amount_required';
    if (!account) er.account = 'required';
    const d = isCash ? today : date;
    if (!d || d > today) er.date = 'future';
    const tooMuch = !!p && p > left;
    setErrors(er);
    setOver(tooMuch);
    if (Object.keys(er).length || tooMuch || !p) return;
    pay.mutate({ id: attempt, amount: p, account_id: account, date: d, note: note.trim() || null });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t('money.salary.payTitle')}</DialogTitle>
            <DialogDescription asChild>
              <div>
                <bdi>{slip.staff_name}</bdi> · <DateText iso={slip.period_key} kind="month" /> ·{' '}
                {t('money.salary.left')} <Money paisa={left} />
              </div>
            </DialogDescription>
          </DialogHeader>
          <Field id="pay-amount" label="money.common.amount" required error={errors.amount}>
            <AmountInput
              id="pay-amount"
              value={amount}
              invalid={!!errors.amount || over}
              onChange={(v) => {
                setAmount(v);
                setOver(false);
              }}
            />
          </Field>
          {over && (
            <p role="alert" id="pay-over" className="text-xs text-destructive">
              {t('money.salary.overLeft', { left: `⁨${money(left)}⁩` })}
            </p>
          )}
          <Field id="pay-account" label="money.common.account" required error={errors.account}>
            <AccountSelect
              id="pay-account"
              value={account}
              onChange={setAccount}
              accounts={accounts}
              invalid={!!errors.account}
            />
          </Field>
          <Field
            id="pay-date"
            label="money.common.date"
            hint={isCash ? t('money.common.cashToday') : undefined}
          >
            <Input
              id="pay-date"
              type="date"
              dir="ltr"
              className="num"
              value={isCash ? today : date}
              max={today}
              disabled={isCash}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
          {errors.date && (
            <p role="alert" className="text-xs text-destructive">
              {t('money.common.future')}
            </p>
          )}
          <Field id="pay-note" label="money.common.note">
            <Input
              id="pay-note"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <MoneyErrorNote error={pay.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" id="pay-confirm" disabled={pay.isPending}>
              {t('money.salary.payConfirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Allowance = { key: string; label: string; amount: string };

/** Owner/admin: basic salary, fixed allowances and joining date of one staff member. */
export function PaySettingsDialog({
  staff,
  open,
  onOpenChange,
}: {
  staff: PayrollStaffDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [base, setBase] = useState(
    staff.base_salary != null ? paisaToRupeeText(staff.base_salary) : '',
  );
  const [joined, setJoined] = useState(staff.joined ?? '');
  const [allow, setAllow] = useState<Allowance[]>(() =>
    staff.allowances.map((a) => ({
      key: newId(),
      label: a.label,
      amount: paisaToRupeeText(a.amount),
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) => sendJson('PUT', `/api/payroll/staff/${staff.id}`, body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['payroll-staff'] });
      toast.success(t('money.salary.setup.saved'));
      onOpenChange(false);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const b = base.trim() ? rupeesToPaisa(base) : null;
    if (base.trim() && b == null) return setError('amount_invalid');
    const list: { label: string; amount: number }[] = [];
    for (const a of allow) {
      const p = rupeesToPaisa(a.amount);
      if (!a.label.trim()) return setError('required');
      if (!p) return setError('amount_invalid');
      list.push({ label: a.label.trim(), amount: p });
    }
    setError(null);
    save.mutate({ base_salary: b, allowances: list, joined: joined || null });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t('money.salary.setup.title')}</DialogTitle>
            <DialogDescription asChild>
              <div>
                <bdi>{staff.name}</bdi>
              </div>
            </DialogDescription>
          </DialogHeader>
          <Field id="pay-base" label="money.salary.setup.base">
            <AmountInput id="pay-base" value={base} onChange={setBase} />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t('money.salary.setup.allowances')}</legend>
            {allow.map((a, i) => (
              <div key={a.key} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`allow-label-${i}`}>{t('money.salary.setup.label')}</Label>
                  <Input
                    id={`allow-label-${i}`}
                    value={a.label}
                    maxLength={40}
                    onChange={(e) =>
                      setAllow((xs) =>
                        xs.map((x) => (x.key === a.key ? { ...x, label: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`allow-amount-${i}`}>{t('money.common.amount')}</Label>
                  <Input
                    id={`allow-amount-${i}`}
                    inputMode="decimal"
                    dir="ltr"
                    className="num"
                    value={a.amount}
                    onChange={(e) =>
                      setAllow((xs) =>
                        xs.map((x) => (x.key === a.key ? { ...x, amount: e.target.value } : x)),
                      )
                    }
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11"
                  aria-label={t('money.salary.removeLine')}
                  onClick={() => setAllow((xs) => xs.filter((x) => x.key !== a.key))}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className="self-start"
              id="allow-add"
              onClick={() => setAllow((xs) => [...xs, { key: newId(), label: '', amount: '' }])}
            >
              <Plus aria-hidden />
              {t('money.salary.setup.addAllowance')}
            </Button>
          </fieldset>
          <Field id="pay-joined" label="money.salary.setup.joined">
            <Input
              id="pay-joined"
              type="date"
              dir="ltr"
              className="num"
              value={joined}
              onChange={(e) => setJoined(e.target.value)}
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${error}` as 'errors.required')}
            </p>
          )}
          <MoneyErrorNote error={save.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" id="pay-settings-save" disabled={save.isPending}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const N = ({ children }: { children: string }) => <bdi className="num">{children}</bdi>;

/**
 * The paper payslip (PLAN §14.8 "slip print"): A5, in its own language (independent of the app's),
 * reusing the receipt print CSS. Every number is a Latin `.num` run.
 */
export function PayslipPrint({
  slip,
  lang,
  mark,
}: {
  slip: PayslipDetailDto;
  lang: 'en' | 'ur';
  /** The school's logo or badge for the header (M7b). */
  mark?: ReactNode;
}) {
  const { i18n } = useTranslation();
  useLanguageResources(lang);
  // Same mechanism as the receipts (ReceiptPrint): while the slip is on screen the whole document
  // prints on the `payslip-a5` named page. Anything left on the default page (the app shell, the
  // toaster's empty <section>) forced a page-type switch and a blank Letter second page.
  useLayoutEffect(() => {
    const style = document.createElement('style');
    style.dataset.receiptPage = 'payslip-a5';
    style.textContent = '@media print { html, body { page: payslip-a5; } }';
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
  const t = i18n.getFixedT(lang);
  const school = lang === 'ur' && slip.school.name_ur ? slip.school.name_ur : slip.school.name;
  const row = (label: string, paisa: number, strong = false) => (
    <tr className={cn(strong && 'receipt-total')}>
      <td>{label}</td>
      <td className="end">
        <N>{money(paisa)}</N>
      </td>
    </tr>
  );
  return (
    <article
      lang={lang}
      dir={lang === 'ur' ? 'rtl' : 'ltr'}
      className="receipt receipt-a5 payslip-a5"
      data-lang={lang}
      id="payslip-paper"
    >
      <header className="receipt-head">
        {mark}
        <h1>{school}</h1>
        {slip.school.address && <div className="receipt-sub">{slip.school.address}</div>}
        {slip.school.phone && (
          <div className="receipt-sub">
            <N>{formatPkPhone(slip.school.phone)}</N>
          </div>
        )}
        <div className="receipt-title">{t('money.salary.slip')}</div>
      </header>
      <dl className="receipt-meta">
        <dt>{t('money.common.staff')}</dt>
        <dd>
          <bdi>{slip.staff_name}</bdi>
        </dd>
        {slip.staff_role && (
          <>
            <dt>{t('money.salary.role')}</dt>
            <dd>
              <bdi>{slip.staff_role}</bdi>
            </dd>
          </>
        )}
        <dt>{t('money.common.month')}</dt>
        <dd>
          <DateText iso={slip.period_key} kind="month" lang={lang} />
        </dd>
        <dt>{t('money.common.status')}</dt>
        <dd>{t(`money.salary.status.${slip.status}`)}</dd>
      </dl>
      <table className="receipt-lines">
        <thead>
          <tr className="receipt-cols">
            <th>{t('money.salary.kind')}</th>
            <th className="end">{t('money.common.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {slip.lines.map((l) => (
            <tr key={l.id}>
              <td>
                {t(`money.salary.lineKinds.${l.kind}`)}
                {l.note && (
                  <>
                    {' · '}
                    <bdi>{l.note}</bdi>
                  </>
                )}
              </td>
              <td className="end">
                <N>{`${sign(l.kind) < 0 ? '−' : ''}${money(l.amount)}`}</N>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {row(t('money.salary.earnings'), slip.earnings)}
          {row(t('money.salary.deductions'), slip.deductions)}
          {row(t('money.salary.recovery'), slip.recovery)}
          {row(t('money.salary.net'), slip.net, true)}
          {row(t('money.salary.paid'), slip.paid)}
          {row(t('money.salary.left'), slip.net - slip.paid)}
        </tfoot>
      </table>
      {slip.advance.outstanding > 0 && (
        <p className="receipt-sub">
          {t('money.salary.outstanding')} <N>{money(slip.advance.outstanding)}</N>
        </p>
      )}
      {slip.payments.length > 0 && (
        <table className="receipt-lines">
          <thead>
            <tr className="receipt-cols">
              <th>{t('money.salary.payments')}</th>
              <th className="end">{t('money.common.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {slip.payments.map((p) => (
              <tr key={p.id}>
                <td>
                  <DateText iso={p.date} lang={lang} /> ·{' '}
                  <bdi className="wrap">{p.account_name}</bdi>
                </td>
                <td className="end">
                  <N>{money(p.amount)}</N>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {slip.approved_by_name && (
        <p className="receipt-sub">
          {t('money.salary.approvedBy')} <bdi>{slip.approved_by_name}</bdi>
        </p>
      )}
      <p className="receipt-sub" style={{ marginTop: '2rem' }}>
        {t('money.salary.signature')} ____________________
      </p>
    </article>
  );
}

import {
  CONCESSION_REASONS,
  concessionInputSchema,
  type FeeLineDto,
  type FineDto,
  type Paged,
  type ReceiptDetailDto,
  type RefundInput,
  type SponsorListItemDto,
  type StudentFeesDto,
  type StudentListItem,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { AmountInput, MethodChips, Money, ReasonDialog } from '@/components/fees/common';
import { ErrorNote, Field, Num } from '@/components/form';
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
import { getJson, sendJson } from '@/lib/api';
import {
  accountsFor,
  headLabel,
  karachiToday,
  mintAttemptKey,
  money,
  needsAccount,
  outcomeUnknown,
  type PaymentMethod,
  rupeesToPaisa,
  useAccounts,
  useFeeHeads,
} from '@/lib/fees';
import { type FieldErrors, issuesToErrors } from '@/lib/form';

/** After any fee-changing action: every fee view refreshes (family, student tab, counter, lists). */
export function useFeeInvalidate() {
  const qc = useQueryClient();
  return async () => {
    for (const k of [
      'fee-family',
      'fee-payer',
      'fee-student',
      'fee-search',
      'fee-concessions',
      'fee-sponsors',
      'fee-sponsor',
      'fee-dashboard',
      'fee-defaulters',
    ])
      await qc.invalidateQueries({ queryKey: [k] });
  };
}

function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  pending,
  error,
  submitLabel,
  id,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  onSubmit: () => void;
  pending?: boolean;
  error?: unknown;
  submitLabel?: string;
  id: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && (
              <DialogDescription asChild>
                <div>{description}</div>
              </DialogDescription>
            )}
          </DialogHeader>
          {children}
          <ErrorNote error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" id={`${id}-save`} disabled={pending}>
              {submitLabel ?? t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The first day a concession takes effect: the first month starting on or after its from-date
 * (a mid-month date starts next month; PLAN §14.7).
 */
export function concessionStartMonth(from: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return from;
  if (from.endsWith('-01')) return from;
  const [y, m] = from.split('-').map(Number) as [number, number];
  const n = y * 12 + m; // next month, 0-based month + 1
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01`;
}

/** PLAN §14.7 "Reduce fee": reason, % or fixed, head, from date; then optionally regenerate. */
export function ReduceFeeDialog({
  studentId,
  studentName,
  open,
  onOpenChange,
}: {
  studentId: string;
  studentName: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const heads = (useFeeHeads().data?.heads ?? []).filter((h) => !h.archived);
  const invalidate = useFeeInvalidate();
  const today = karachiToday();
  const [d, setD] = useState({
    reason: 'scholarship' as (typeof CONCESSION_REASONS)[number],
    type: 'pct' as 'pct' | 'fixed',
    value: '',
    head: '',
    from: today,
    to: '',
    note: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const body = () => ({
    student_id: studentId,
    fee_head_id: d.head || null,
    type: d.type,
    value: d.type === 'pct' ? Number(d.value) : (rupeesToPaisa(d.value) ?? 0),
    reason: d.reason,
    note: d.note,
    valid_from: d.from,
    valid_to: d.to || null,
  });
  const save = useMutation({
    mutationFn: () => sendJson('POST', '/api/fees/concessions', body()),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('fee.concession.saved'));
      setSaved(true);
    },
  });
  const applies = concessionStartMonth(d.from);
  // Months of this student already billed on or after the month the concession starts: those are
  // the ones a regenerate can update (one request per month, PLAN §15 budget).
  const studentFees = useQuery({
    queryKey: ['fee-student', studentId],
    queryFn: () => getJson<StudentFeesDto>(`/api/fees/student/${studentId}`),
    enabled: saved,
  });
  const billed = [
    ...new Set(
      [...(studentFees.data?.lines ?? []), ...(studentFees.data?.sponsored ?? [])]
        .map((l) => l.period_key)
        .filter((p) => p >= applies.slice(0, 7) && p <= today.slice(0, 7)),
    ),
  ].sort();
  const regen = useMutation({
    mutationFn: async () => {
      for (const period of billed)
        await sendJson('POST', '/api/fees/regenerate', { student_id: studentId, period });
    },
    onSuccess: async () => {
      await invalidate();
      toast.success(t('fee.concession.regenerated'));
      onOpenChange(false);
    },
  });
  const submit = () => {
    const input = body();
    const parsed = concessionInputSchema.safeParse(input);
    if (!parsed.success || !input.value) {
      const e = parsed.success ? {} : issuesToErrors(parsed.error.issues, input);
      if (!input.value) e.value = 'required';
      return setErrors(e);
    }
    setErrors({});
    save.mutate();
  };
  if (saved)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('fee.concession.saved')}</DialogTitle>
            <DialogDescription>{t('fee.concession.explain')}</DialogDescription>
          </DialogHeader>
          <p className="text-sm font-medium" id="concession-applies">
            {t('fee.concession.appliesFrom', { date: `\u2068${applies}\u2069` })}
          </p>
          {studentFees.data && billed.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('fee.concession.nothingBilled')}</p>
          )}
          <ErrorNote error={regen.error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
            {billed.length > 0 && (
              <Button
                id="concession-regenerate"
                disabled={regen.isPending}
                onClick={() => regen.mutate()}
              >
                {t('fee.concession.regenerateFrom', {
                  date: `\u2068${billed[0]}-01\u2069`,
                })}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <FormDialog
      id="concession"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.concession.reduceFee')}
      description={
        <>
          <bdi className="font-medium">{studentName}</bdi>
          <p className="mt-1 text-xs">{t('fee.concession.explain')}</p>
          <p className="mt-1 text-xs font-medium" id="concession-applies-hint">
            {t('fee.concession.appliesFrom', {
              date: `\u2068${concessionStartMonth(d.from)}\u2069`,
            })}
          </p>
        </>
      }
      onSubmit={submit}
      pending={save.isPending}
      error={save.error}
    >
      <Field id="concession-reason" label="fee.concession.reason" required>
        <Select
          id="concession-reason"
          value={d.reason}
          onChange={(e) => setD({ ...d, reason: e.target.value as typeof d.reason })}
        >
          {CONCESSION_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`fee.concession.reasons.${r}`)}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset aria-label={t('fee.concession.type')} className="flex gap-2">
        {(['pct', 'fixed'] as const).map((k) => (
          <Button
            key={k}
            type="button"
            id={`concession-type-${k}`}
            aria-pressed={d.type === k}
            variant={d.type === k ? 'default' : 'outline'}
            onClick={() => setD({ ...d, type: k, value: '' })}
          >
            {t(`fee.concession.${k}`)}
          </Button>
        ))}
      </fieldset>
      <Field
        id="concession-value"
        label={d.type === 'pct' ? 'fee.concession.valuePct' : 'fee.concession.valueRs'}
        required
        error={errors.value}
      >
        {d.type === 'pct' ? (
          <Input
            id="concession-value"
            inputMode="numeric"
            dir="ltr"
            className="num"
            value={d.value}
            onChange={(e) => setD({ ...d, value: e.target.value.replace(/\D/g, '').slice(0, 3) })}
          />
        ) : (
          <AmountInput
            id="concession-value"
            value={d.value}
            onChange={(v) => setD({ ...d, value: v })}
          />
        )}
      </Field>
      <Field id="concession-head" label="fee.concession.head">
        <Select
          id="concession-head"
          value={d.head}
          onChange={(e) => setD({ ...d, head: e.target.value })}
        >
          <option value="">{t('fee.concession.allTuition')}</option>
          {heads.map((h) => (
            <option key={h.id} value={h.id}>
              {headLabel({ head_name: h.name, head_name_ur: h.name_ur }, i18n.language)}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field id="concession-from" label="fee.concession.from" required error={errors.valid_from}>
          <Input
            id="concession-from"
            type="date"
            value={d.from}
            onChange={(e) => setD({ ...d, from: e.target.value })}
          />
        </Field>
        <Field id="concession-to" label="fee.concession.to" error={errors.valid_to}>
          <Input
            id="concession-to"
            type="date"
            value={d.to}
            onChange={(e) => setD({ ...d, to: e.target.value })}
          />
        </Field>
      </div>
      <Field id="concession-note" label="fee.concession.note">
        <Textarea
          id="concession-note"
          value={d.note}
          maxLength={300}
          onChange={(e) => setD({ ...d, note: e.target.value })}
        />
      </Field>
    </FormDialog>
  );
}

/** End a concession or sponsorship: a date and (concession) a reason; the row is never edited. */
export function EndConcessionDialog({
  concessionId,
  open,
  onOpenChange,
}: {
  concessionId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const invalidate = useFeeInvalidate();
  const [date, setDate] = useState(karachiToday());
  const end = useMutation({
    mutationFn: (reason: string) =>
      sendJson('POST', `/api/fees/concessions/${concessionId}/end`, { ended_at: date, reason }),
    onSuccess: async () => {
      await invalidate();
      onOpenChange(false);
    },
  });
  return (
    <ReasonDialog
      id="concession-end"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.concession.endTitle')}
      confirmLabel={t('fee.concession.end')}
      pending={end.isPending}
      error={end.error}
      onConfirm={(r) => end.mutate(r)}
    >
      <Field id="concession-end-date" label="fee.concession.endDate" required>
        <Input
          id="concession-end-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
    </ReasonDialog>
  );
}

export function EndSponsorshipDialog({
  sponsorshipId,
  open,
  onOpenChange,
}: {
  sponsorshipId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const invalidate = useFeeInvalidate();
  const [date, setDate] = useState(karachiToday());
  const end = useMutation({
    mutationFn: () =>
      sendJson('POST', `/api/fees/sponsorships/${sponsorshipId}/end`, { valid_to: date }),
    onSuccess: async () => {
      await invalidate();
      onOpenChange(false);
    },
  });
  return (
    <FormDialog
      id="sponsorship-end"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.sponsor.end')}
      onSubmit={() => end.mutate()}
      pending={end.isPending}
      error={end.error}
      submitLabel={t('fee.sponsor.end')}
    >
      <Field id="sponsorship-end-date" label="fee.sponsor.endDate" required>
        <Input
          id="sponsorship-end-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

/** Student picker for the sponsor screen: search by name / admission no. (existing students API). */
function StudentPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['students', 'picker', q],
    queryFn: () =>
      getJson<Paged<StudentListItem>>(`/api/students?q=${encodeURIComponent(q)}&status=active`),
    enabled: q.trim().length >= 2,
  });
  return (
    <div className="flex flex-col gap-2">
      <Input
        id="sponsorship-student-search"
        type="search"
        value={q}
        aria-label={t('fee.counter.searchLabel')}
        onChange={(e) => setQ(e.target.value)}
      />
      <Select id="sponsorship-student" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {list.data?.items.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} · {s.admission_no}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** Link a sponsor to a student with a share % and dates (PLAN §14.7). */
export function SponsorshipDialog({
  studentId,
  sponsorId,
  open,
  onOpenChange,
}: {
  studentId?: string;
  sponsorId?: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const invalidate = useFeeInvalidate();
  const heads = (useFeeHeads().data?.heads ?? []).filter((h) => !h.archived);
  const sponsors = useQuery({
    queryKey: ['fee-sponsors'],
    queryFn: () => getJson<{ sponsors: SponsorListItemDto[] }>('/api/fees/sponsors'),
    enabled: !sponsorId,
  });
  const [d, setD] = useState({
    sponsor: sponsorId ?? '',
    student: studentId ?? '',
    head: '',
    share: '100',
    from: karachiToday(),
    to: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: () =>
      sendJson('POST', '/api/fees/sponsorships', {
        sponsor_id: d.sponsor,
        student_id: d.student,
        fee_head_id: d.head || null,
        share_pct: Number(d.share),
        valid_from: d.from,
        valid_to: d.to || null,
      }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('fee.sponsor.saved'));
      onOpenChange(false);
    },
  });
  const submit = () => {
    const e: FieldErrors = {};
    if (!d.sponsor) e.sponsor = 'required';
    if (!d.student) e.student = 'required';
    const n = Number(d.share);
    if (!Number.isInteger(n) || n < 1 || n > 100) e.share = 'max_100';
    if (!d.from) e.from = 'required';
    if (d.to && d.to < d.from) e.to = 'end_before_start';
    setErrors(e);
    if (!Object.keys(e).length) save.mutate();
  };
  return (
    <FormDialog
      id="sponsorship"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.sponsor.addSponsorship')}
      onSubmit={submit}
      pending={save.isPending}
      error={save.error}
    >
      {!sponsorId && (
        <Field id="sponsorship-sponsor" label="fee.sponsor.choose" required error={errors.sponsor}>
          <Select
            id="sponsorship-sponsor"
            value={d.sponsor}
            onChange={(e) => setD({ ...d, sponsor: e.target.value })}
          >
            <option value="">—</option>
            {sponsors.data?.sponsors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {!studentId && (
        <Field id="sponsorship-student" label="fee.sponsor.student" required error={errors.student}>
          <StudentPicker value={d.student} onChange={(v) => setD({ ...d, student: v })} />
        </Field>
      )}
      <Field id="sponsorship-head" label="fee.concession.head">
        <Select
          id="sponsorship-head"
          value={d.head}
          onChange={(e) => setD({ ...d, head: e.target.value })}
        >
          <option value="">{t('fee.sponsor.allHeads')}</option>
          {heads.map((h) => (
            <option key={h.id} value={h.id}>
              {headLabel({ head_name: h.name, head_name_ur: h.name_ur }, i18n.language)}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="sponsorship-share" label="fee.sponsor.share" required error={errors.share}>
        <Input
          id="sponsorship-share"
          inputMode="numeric"
          dir="ltr"
          className="num"
          value={d.share}
          onChange={(e) => setD({ ...d, share: e.target.value.replace(/\D/g, '').slice(0, 3) })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field id="sponsorship-from" label="fee.sponsor.from" required error={errors.from}>
          <Input
            id="sponsorship-from"
            type="date"
            value={d.from}
            onChange={(e) => setD({ ...d, from: e.target.value })}
          />
        </Field>
        <Field id="sponsorship-to" label="fee.sponsor.to" error={errors.to}>
          <Input
            id="sponsorship-to"
            type="date"
            value={d.to}
            onChange={(e) => setD({ ...d, to: e.target.value })}
          />
        </Field>
      </div>
    </FormDialog>
  );
}

/** Go-live carry-in (once per student): owed (positive) or advance held (credit, negative). */
export function OpeningBalanceDialog({
  studentId,
  open,
  onOpenChange,
}: {
  studentId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const invalidate = useFeeInvalidate();
  const [dir, setDir] = useState<'owed' | 'credit'>('owed');
  const [amount, setAmount] = useState('');
  const [asOf, setAsOf] = useState(karachiToday());
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (paisa: number) =>
      sendJson('POST', '/api/fees/opening-balances', {
        student_id: studentId,
        amount: dir === 'owed' ? paisa : -paisa,
        as_of: asOf,
        note,
      }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('fee.opening.saved'));
      onOpenChange(false);
    },
  });
  return (
    <FormDialog
      id="opening"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.opening.title')}
      description={t('fee.opening.explain')}
      onSubmit={() => {
        const p = rupeesToPaisa(amount);
        if (!p) return setErr(amount ? 'amount_invalid' : 'amount_required');
        setErr(undefined);
        save.mutate(p);
      }}
      pending={save.isPending}
      error={save.error}
    >
      <fieldset aria-label={t('fee.opening.direction')} className="flex flex-wrap gap-2">
        {(['owed', 'credit'] as const).map((k) => (
          <Button
            key={k}
            type="button"
            id={`opening-${k}`}
            aria-pressed={dir === k}
            variant={dir === k ? 'default' : 'outline'}
            onClick={() => setDir(k)}
          >
            {t(`fee.opening.${k}`)}
          </Button>
        ))}
      </fieldset>
      <Field id="opening-amount" label="fee.opening.amount" required error={err}>
        <AmountInput id="opening-amount" value={amount} onChange={setAmount} />
      </Field>
      <Field id="opening-as-of" label="fee.opening.asOf" required>
        <Input
          id="opening-as-of"
          type="date"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </Field>
      <Field id="opening-note" label="fee.opening.note">
        <Input
          id="opening-note"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </FormDialog>
  );
}

/**
 * Void a fee billed by mistake (admin/owner, reason). A fee root voids its whole unit (family and
 * sponsor roots of the same student, head and period): both lines are listed before confirming.
 */
export function VoidChargeDialog({
  line,
  unit,
  open,
  onOpenChange,
}: {
  line: FeeLineDto;
  unit: readonly FeeLineDto[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const invalidate = useFeeInvalidate();
  const v = useMutation({
    mutationFn: (reason: string) => sendJson('POST', `/api/charges/${line.id}/void`, { reason }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('fee.family.voided'));
      onOpenChange(false);
    },
  });
  return (
    <ReasonDialog
      id="void"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.family.voidTitle')}
      body={t('fee.family.voidBody')}
      confirmLabel={t('fee.family.void')}
      pending={v.isPending}
      error={v.error}
      onConfirm={(r) => v.mutate(r)}
    >
      <div className="text-sm">
        <p className="font-medium">{t('fee.family.voidAlso')}</p>
        <ul className="flex flex-col gap-1" id="void-unit">
          {unit.map((l) => (
            <li key={l.id} className="flex flex-wrap gap-2">
              <bdi>{l.student_name}</bdi>
              <Num>{l.period_key}</Num>
              <bdi>{headLabel(l, i18n.language)}</bdi>
              <span className="text-muted-foreground">
                {l.payer_type === 'sponsor' ? t('fee.col.sponsor') : t('fee.col.family')}
              </span>
              <span className="ms-auto">
                <Money paisa={l.net} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ReasonDialog>
  );
}

/** The lines voided together with `line` (PLAN M3b: void a fee = the whole unit). */
export const voidUnit = (line: FeeLineDto, all: readonly FeeLineDto[]) =>
  line.head_kind === 'fine'
    ? [line]
    : all.filter(
        (l) =>
          l.student_id === line.student_id &&
          l.fee_head_id === line.fee_head_id &&
          l.period_key === line.period_key,
      );

/** Waive a late fine (admin/owner, reason): POST /api/fees/fines/:id/waive; the waiver is audited. */
export function WaiveFineDialog({
  fine,
  line,
  open,
  onOpenChange,
}: {
  fine: FineDto;
  line?: FeeLineDto | undefined;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const invalidate = useFeeInvalidate();
  const w = useMutation({
    mutationFn: (reason: string) =>
      sendJson('POST', `/api/fees/fines/${fine.id}/waive`, { reason }),
    onSuccess: async () => {
      await invalidate();
      toast.success(t('fee.family.waived'));
      onOpenChange(false);
    },
  });
  return (
    <ReasonDialog
      id="waive"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.family.waiveTitle')}
      body={t('fee.family.waiveBody')}
      confirmLabel={t('fee.counter.waiveFine')}
      pending={w.isPending}
      error={w.error}
      onConfirm={(r) => w.mutate(r)}
    >
      <p className="flex flex-wrap gap-2 text-sm" id="waive-line">
        {line && <bdi>{line.student_name}</bdi>}
        <Num>{fine.period_key}</Num>
        {line && <bdi>{headLabel(line, i18n.language)}</bdi>}
        <span className="ms-auto">
          <Money paisa={fine.left} />
        </span>
      </p>
    </ReasonDialog>
  );
}

/** The body POST /api/refunds gets from the refund dialog (exported for tests). */
export function refundBody(o: {
  key: string;
  payerType: 'family' | 'sponsor';
  payerId: string;
  amount: number;
  method: PaymentMethod;
  account: string;
  reason: string;
}): RefundInput {
  return {
    idempotency_key: o.key,
    payer_type: o.payerType,
    payer_id: o.payerId,
    amount: o.amount,
    method: o.method,
    ...(needsAccount(o.method) ? { account_id: o.account } : {}),
    reason: o.reason,
  };
}

/**
 * Refund from the payer's advance (admin/owner; today only). Amount ≤ credit, method, account for
 * non-cash, reason. One idempotency key per attempt, kept while the outcome is unknown (a retry
 * after a lost answer replays the same refund). Success opens the refund receipt.
 */
export function RefundDialog({
  payerType = 'family',
  payerId,
  credit,
  open,
  onOpenChange,
}: {
  payerType?: 'family' | 'sponsor';
  payerId: string;
  credit: number;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const invalidate = useFeeInvalidate();
  const accounts = useAccounts().data?.accounts ?? [];
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [account, setAccount] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<RefundInput | null>(null);
  const choices = accountsFor(method, accounts);
  const r = useMutation({
    mutationFn: (body: RefundInput) =>
      sendJson<{ receipt: ReceiptDetailDto; replayed: boolean }>('POST', '/api/refunds', body),
    onSuccess: async (res) => {
      setPending(null);
      await invalidate();
      toast.success(t('fee.family.refundDone'));
      onOpenChange(false);
      navigate(`/receipts/${res.receipt.id}`);
    },
    onError: (err) => {
      if (!outcomeUnknown(err)) setPending(null);
    },
  });
  const locked = pending !== null;
  return (
    <ReasonDialog
      id="refund"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.family.refundTitle')}
      body={t('fee.family.refundBody')}
      confirmLabel={t('fee.family.refund')}
      pending={r.isPending}
      error={r.error}
      onConfirm={(reason) => {
        if (pending) return r.mutate(pending);
        const amount = rupeesToPaisa(amountText);
        const e: Record<string, string> = {};
        if (!amountText.trim()) e.amount = 'amount_required';
        else if (!amount) e.amount = 'amount_invalid';
        else if (amount > credit) e.amount = 'exceeds_credit';
        if (needsAccount(method) && !account) e.account = 'account_required';
        setErrors(e);
        if (Object.keys(e).length || !amount) return;
        const body = refundBody({
          key: mintAttemptKey('rfd'),
          payerType,
          payerId,
          amount,
          method,
          account,
          reason,
        });
        setPending(body);
        r.mutate(body);
      }}
    >
      <Field
        id="refund-amount"
        label="fee.cash.amount"
        required
        error={errors.amount}
        hint={t('fee.family.refundMax', { max: `\u2068${money(credit)}\u2069` })}
      >
        <fieldset disabled={locked} className="contents">
          <AmountInput id="refund-amount" value={amountText} onChange={setAmountText} />
        </fieldset>
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('fee.family.refundMethod')}</span>
        <fieldset disabled={locked} className="contents">
          <MethodChips
            name="refund-method"
            value={method}
            onChange={(m) => {
              setMethod(m);
              setAccount('');
            }}
          />
        </fieldset>
      </div>
      {needsAccount(method) && (
        <Field id="refund-account" label="fee.family.refundAccount" required error={errors.account}>
          <Select
            id="refund-account"
            value={account}
            disabled={locked}
            onChange={(e) => setAccount(e.target.value)}
          >
            <option value="">{t('fee.counter.chooseAccount')}</option>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </ReasonDialog>
  );
}

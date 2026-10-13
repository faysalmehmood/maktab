import {
  FEE_CADENCES,
  FEE_HEAD_KINDS,
  type FeeHeadDto,
  type FeeRateDto,
  type FeeSettingsDto,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReceiptSeries } from '@/components/backup/DataPanel';
import { AmountInput, Money } from '@/components/fees/common';
import { ErrorNote, Field, Num } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { getJson, sendJson } from '@/lib/api';
import {
  type Account,
  karachiToday,
  paisaToRupeeText,
  rupeesToPaisa,
  useAccounts,
  useFeeHeads,
  useFeeSettings,
} from '@/lib/fees';
import type { FieldErrors } from '@/lib/form';
import { useGroups, useProgrammes, useStaff } from '@/lib/queries';
import { useRoles } from '@/lib/roles';

function H({ children }: { children: string }) {
  return <h3 className="text-base font-semibold">{children}</h3>;
}

function HeadsEditor() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const heads = useFeeHeads().data?.heads ?? [];
  const [d, setD] = useState({ name: '', name_ur: '', kind: 'tuition', cadence: 'monthly' });
  const [err, setErr] = useState<FieldErrors>({});
  const add = useMutation({
    mutationFn: () => sendJson('POST', '/api/fees/heads', d),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['fee-heads'] });
      setD({ name: '', name_ur: '', kind: 'tuition', cadence: 'monthly' });
      toast.success(t('fee.setup.saved'));
    },
  });
  const archive = useMutation({
    mutationFn: (h: FeeHeadDto) =>
      sendJson('PATCH', `/api/fees/heads/${h.id}`, { archived: !h.archived }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fee-heads'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!d.name.trim()) return setErr({ name: 'required' });
    setErr({});
    add.mutate();
  };
  return (
    <div className="flex flex-col gap-3">
      <H>{t('fee.setup.heads')}</H>
      <ul className="flex flex-col divide-y" id="fee-heads">
        {heads.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-2 py-1">
            <bdi className="font-medium">{h.name}</bdi>
            {h.name_ur && <bdi lang="ur">{h.name_ur}</bdi>}
            <Badge variant="outline">{t(`fee.setup.kinds.${h.kind}`)}</Badge>
            <Badge variant="secondary">{t(`fee.setup.cadences.${h.cadence}`)}</Badge>
            {h.archived && <Badge variant="destructive">{t('fee.setup.archived')}</Badge>}
            {h.kind !== 'fine' && (
              <Button
                size="sm"
                variant="ghost"
                className="ms-auto"
                onClick={() => archive.mutate(h)}
              >
                {h.archived ? t('fee.setup.unarchive') : t('fee.setup.archive')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2" noValidate>
        <Field id="head-name" label="fee.setup.headName" required error={err.name}>
          <Input
            id="head-name"
            value={d.name}
            maxLength={60}
            onChange={(e) => setD({ ...d, name: e.target.value })}
          />
        </Field>
        <Field id="head-name-ur" label="fee.setup.headNameUr">
          <Input
            id="head-name-ur"
            lang="ur"
            dir="rtl"
            value={d.name_ur}
            maxLength={60}
            onChange={(e) => setD({ ...d, name_ur: e.target.value })}
          />
        </Field>
        <Field id="head-kind" label="fee.setup.kind">
          <Select
            id="head-kind"
            value={d.kind}
            onChange={(e) => setD({ ...d, kind: e.target.value })}
          >
            {FEE_HEAD_KINDS.filter((k) => k !== 'fine').map((k) => (
              <option key={k} value={k}>
                {t(`fee.setup.kinds.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="head-cadence" label="fee.setup.cadence">
          <Select
            id="head-cadence"
            value={d.cadence}
            onChange={(e) => setD({ ...d, cadence: e.target.value })}
          >
            {FEE_CADENCES.map((k) => (
              <option key={k} value={k}>
                {t(`fee.setup.cadences.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={add.error ?? archive.error} />
        <Button type="submit" variant="outline" className="sm:col-span-2" disabled={add.isPending}>
          <Plus aria-hidden />
          {t('fee.setup.addHead')}
        </Button>
      </form>
    </div>
  );
}

/** Rates grouped by (head, target), newest first: the first is current, the rest is history. */
export function rateHistory(rates: readonly FeeRateDto[], today: string) {
  const groups = new Map<string, FeeRateDto[]>();
  for (const r of rates) {
    const k = `${r.fee_head_id}|${r.programme_id ?? ''}|${r.grp_id ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort((a, b) =>
      a.effective_from === b.effective_from
        ? b.created_at.localeCompare(a.created_at)
        : b.effective_from.localeCompare(a.effective_from),
    );
    const current = sorted.find((r) => r.effective_from <= today) ?? null;
    return { key: `${sorted[0]?.fee_head_id}`, rates: sorted, current };
  });
}

function RatesEditor() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const allHeads = useFeeHeads().data?.heads ?? [];
  const heads = allHeads.filter((h) => !h.archived && h.kind !== 'fine');
  const programmes = useProgrammes().data?.items ?? [];
  const groups = useGroups().data?.items ?? [];
  const rates = useQuery({
    queryKey: ['fee-rates'],
    queryFn: () => getJson<{ rates: FeeRateDto[] }>('/api/fees/rates'),
  });
  const [d, setD] = useState({
    head: '',
    target: 'programme' as 'programme' | 'group',
    id: '',
    amount: '',
    from: karachiToday(),
  });
  const [err, setErr] = useState<FieldErrors>({});
  const add = useMutation({
    mutationFn: (amount: number) =>
      sendJson('POST', '/api/fees/rates', {
        fee_head_id: d.head,
        ...(d.target === 'programme' ? { programme_id: d.id } : { grp_id: d.id }),
        amount,
        effective_from: d.from,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['fee-rates'] });
      setD({ ...d, amount: '' });
      toast.success(t('fee.setup.saved'));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const e2: FieldErrors = {};
    if (!d.head) e2.head = 'required';
    if (!d.id) e2.id = 'programme_or_group';
    const amount = rupeesToPaisa(d.amount);
    if (amount === null) e2.amount = d.amount ? 'amount_invalid' : 'required';
    if (!d.from) e2.from = 'required';
    setErr(e2);
    if (!Object.keys(e2).length && amount !== null) add.mutate(amount);
  };
  const headName = (id: string) => {
    const h = allHeads.find((x) => x.id === id);
    return h ? (i18n.language === 'ur' && h.name_ur ? h.name_ur : h.name) : id;
  };
  const target = (r: FeeRateDto) => {
    if (r.programme_id) return programmes.find((p) => p.id === r.programme_id)?.name ?? '';
    const g = groups.find((x) => x.id === r.grp_id);
    return g ? `${g.programme_name} ${g.name}` : '';
  };
  const today = karachiToday();
  return (
    <div className="flex flex-col gap-3">
      <H>{t('fee.setup.rates')}</H>
      <p className="text-xs text-muted-foreground">{t('fee.setup.appendOnly')}</p>
      <form onSubmit={submit} className="grid gap-2 sm:grid-cols-2" noValidate id="rate-form">
        <Field id="rate-head" label="fee.setup.rateHead" required error={err.head}>
          <Select
            id="rate-head"
            value={d.head}
            onChange={(e) => setD({ ...d, head: e.target.value })}
          >
            <option value="">—</option>
            {heads.map((h) => (
              <option key={h.id} value={h.id}>
                {i18n.language === 'ur' && h.name_ur ? h.name_ur : h.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="rate-target" label="fee.setup.rateFor" required error={err.id}>
          <div className="flex gap-2">
            <Select
              id="rate-target-kind"
              className="w-auto"
              aria-label={t('fee.setup.rateFor')}
              value={d.target}
              onChange={(e) =>
                setD({ ...d, target: e.target.value as 'programme' | 'group', id: '' })
              }
            >
              <option value="programme">{t('fee.setup.programme')}</option>
              <option value="group">{t('fee.setup.group')}</option>
            </Select>
            <Select
              id="rate-target"
              value={d.id}
              onChange={(e) => setD({ ...d, id: e.target.value })}
            >
              <option value="">—</option>
              {d.target === 'programme'
                ? programmes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                : groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.programme_name} {g.name}
                    </option>
                  ))}
            </Select>
          </div>
        </Field>
        <Field id="rate-amount" label="fee.setup.amount" required error={err.amount}>
          <AmountInput
            id="rate-amount"
            value={d.amount}
            onChange={(v) => setD({ ...d, amount: v })}
          />
        </Field>
        <Field id="rate-from" label="fee.setup.effectiveFrom" required error={err.from}>
          <Input
            id="rate-from"
            type="date"
            value={d.from}
            onChange={(e) => setD({ ...d, from: e.target.value })}
          />
        </Field>
        <ErrorNote error={add.error} />
        <Button
          type="submit"
          variant="outline"
          className="sm:col-span-2"
          id="rate-add"
          disabled={add.isPending}
        >
          <Plus aria-hidden />
          {t('fee.setup.addRate')}
        </Button>
      </form>
      {rates.data && rates.data.rates.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('fee.setup.noRates')}</p>
      )}
      {rates.data && rates.data.rates.length > 0 && (
        <Table id="rate-history">
          <TableHeader>
            <TableRow>
              <TableHead>{t('fee.setup.rateHead')}</TableHead>
              <TableHead>{t('fee.setup.rateFor')}</TableHead>
              <TableHead>{t('fee.setup.effectiveFrom')}</TableHead>
              <TableHead className="text-end">{t('fee.setup.amount')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rateHistory(rates.data.rates, today).flatMap((g) =>
              g.rates.map((r) => (
                <TableRow
                  key={r.id}
                  data-rate={r.id}
                  className={r === g.current ? 'font-medium' : 'text-muted-foreground'}
                >
                  <TableCell>
                    <bdi>{headName(r.fee_head_id)}</bdi>
                  </TableCell>
                  <TableCell>
                    <bdi>{target(r)}</bdi>
                  </TableCell>
                  <TableCell>
                    <Num>{r.effective_from}</Num>
                  </TableCell>
                  <TableCell className="text-end">
                    <Money paisa={r.amount} />
                  </TableCell>
                  <TableCell>
                    {r === g.current ? (
                      <Badge>{t('fee.setup.current')}</Badge>
                    ) : r.effective_from > today ? (
                      <Badge variant="secondary" data-upcoming={r.id}>
                        {t('fee.setup.upcoming')}
                      </Badge>
                    ) : (
                      <Badge variant="outline">{t('fee.setup.history')}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export type FineDraft = {
  enabled: boolean;
  grace_day: string;
  type: 'fixed' | 'pct';
  value: string;
  cap: string;
};

/** Client checks matching fineRuleSchema; values are rupees (fixed, cap) or percent. */
export function validateFineRule(d: FineDraft): {
  errors: FieldErrors;
  rule: FeeSettingsDto['fine_rule'];
} {
  const errors: FieldErrors = {};
  const grace = Number(d.grace_day);
  if (!Number.isInteger(grace) || grace < 1 || grace > 28) errors.grace_day = 'invalid';
  let value = 0;
  if (d.type === 'pct') {
    value = Number(d.value);
    if (!d.value.trim()) errors.value = 'fine_value_required';
    else if (!Number.isInteger(value) || value < 1 || value > 100) errors.value = 'fine_value_pct';
  } else {
    const p = rupeesToPaisa(d.value);
    if (!d.value.trim()) errors.value = 'fine_value_required';
    else if (!p) errors.value = 'amount_invalid';
    value = p ?? 0;
  }
  let cap: number | null = null;
  if (d.cap.trim()) {
    cap = rupeesToPaisa(d.cap);
    if (!cap) errors.cap = 'amount_invalid';
  }
  if (!d.enabled) return { errors: {}, rule: null };
  return { errors, rule: { enabled: true, grace_day: grace, type: d.type, value, cap } };
}

function RulesEditor({ fees }: { fees: FeeSettingsDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fr = fees.fine_rule;
  const [fine, setFine] = useState<FineDraft>({
    enabled: !!fr?.enabled,
    grace_day: String(fr?.grace_day ?? 15),
    type: fr?.type ?? 'fixed',
    value: fr ? (fr.type === 'pct' ? String(fr.value) : paisaToRupeeText(fr.value)) : '',
    cap: fr?.cap ? paisaToRupeeText(fr.cap) : '',
  });
  const [siblings, setSiblings] = useState(
    fees.sibling_rule.map((r) => ({ nth: String(r.nth), pct: String(r.pct) })),
  );
  const [cooldown, setCooldown] = useState(String(fees.reminder_cooldown_days));
  const [errors, setErrors] = useState<FieldErrors>({});
  const save = useMutation({
    mutationFn: (body: unknown) => sendJson('PUT', '/api/school/fees', body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['fee-settings'] });
      toast.success(t('fee.setup.saved'));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = validateFineRule(fine);
    const errs = { ...v.errors };
    const cd = Number(cooldown);
    if (!Number.isInteger(cd) || cd < 1 || cd > 90) errs.cooldown = 'invalid';
    const rules = siblings.map((s) => ({ nth: Number(s.nth), pct: Number(s.pct) }));
    rules.forEach((r, i) => {
      if (!Number.isInteger(r.nth) || r.nth < 2 || r.nth > 10) errs[`sib.${i}.nth`] = 'invalid';
      if (!Number.isInteger(r.pct) || r.pct < 1 || r.pct > 100) errs[`sib.${i}.pct`] = 'max_100';
    });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      fine_rule: v.rule ?? (fr ? { ...fr, enabled: false } : null),
      sibling_rule: rules,
      reminder_cooldown_days: cd,
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate id="fee-rules">
      <H>{t('fee.setup.fineRule')}</H>
      <p className="text-xs text-muted-foreground">{t('fee.setup.dueDay', { n: fees.due_day })}</p>
      <Checkbox
        id="fine-enabled"
        checked={fine.enabled}
        onChange={(e) => setFine({ ...fine, enabled: e.target.checked })}
        label={t('fee.setup.fineEnabled')}
      />
      {fine.enabled && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field id="fine-grace" label="fee.setup.graceDay" required error={errors.grace_day}>
            <Input
              id="fine-grace"
              inputMode="numeric"
              dir="ltr"
              className="num"
              value={fine.grace_day}
              onChange={(e) =>
                setFine({ ...fine, grace_day: e.target.value.replace(/\D/g, '').slice(0, 2) })
              }
            />
          </Field>
          <Field id="fine-type" label="fee.setup.fineType">
            <Select
              id="fine-type"
              value={fine.type}
              onChange={(e) =>
                setFine({ ...fine, type: e.target.value as 'fixed' | 'pct', value: '' })
              }
            >
              <option value="fixed">{t('fee.setup.fineFixed')}</option>
              <option value="pct">{t('fee.setup.finePct')}</option>
            </Select>
          </Field>
          <Field id="fine-value" label="fee.setup.fineValue" required error={errors.value}>
            <Input
              id="fine-value"
              inputMode="decimal"
              dir="ltr"
              className="num"
              value={fine.value}
              onChange={(e) => setFine({ ...fine, value: e.target.value })}
            />
          </Field>
          <Field id="fine-cap" label="fee.setup.fineCap" error={errors.cap}>
            <Input
              id="fine-cap"
              inputMode="decimal"
              dir="ltr"
              className="num"
              value={fine.cap}
              onChange={(e) => setFine({ ...fine, cap: e.target.value })}
            />
          </Field>
        </div>
      )}
      <H>{t('fee.setup.sibling')}</H>
      {siblings.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved
        <div key={i} className="flex items-end gap-2">
          <Field id={`sib-${i}-nth`} label="fee.setup.nth" error={errors[`sib.${i}.nth`]}>
            <Input
              id={`sib-${i}-nth`}
              inputMode="numeric"
              dir="ltr"
              className="num w-20"
              value={s.nth}
              onChange={(e) =>
                setSiblings(
                  siblings.map((x, j) =>
                    j === i ? { ...x, nth: e.target.value.replace(/\D/g, '') } : x,
                  ),
                )
              }
            />
          </Field>
          <Field id={`sib-${i}-pct`} label="fee.setup.pct" error={errors[`sib.${i}.pct`]}>
            <Input
              id={`sib-${i}-pct`}
              inputMode="numeric"
              dir="ltr"
              className="num w-20"
              value={s.pct}
              onChange={(e) =>
                setSiblings(
                  siblings.map((x, j) =>
                    j === i ? { ...x, pct: e.target.value.replace(/\D/g, '') } : x,
                  ),
                )
              }
            />
          </Field>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setSiblings(siblings.filter((_, j) => j !== i))}
          >
            {t('fee.setup.remove')}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setSiblings([...siblings, { nth: String(siblings.length + 2), pct: '10' }])}
      >
        <Plus aria-hidden />
        {t('fee.setup.addSibling')}
      </Button>
      <Field id="fee-cooldown" label="fee.setup.cooldown" required error={errors.cooldown}>
        <Input
          id="fee-cooldown"
          inputMode="numeric"
          dir="ltr"
          className="num w-24"
          value={cooldown}
          onChange={(e) => setCooldown(e.target.value.replace(/\D/g, '').slice(0, 2))}
        />
      </Field>
      <ErrorNote error={save.error} />
      <Button type="submit" id="fee-rules-save" disabled={save.isPending} className="self-start">
        {t('common.save')}
      </Button>
    </form>
  );
}

function PrefixInfo({ fees }: { fees: FeeSettingsDto }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1" id="receipt-prefix">
      <H>{t('fee.setup.receiptPrefix')}</H>
      <p className="flex items-center gap-2">
        <Num>{fees.receipt_prefix}</Num>
        {fees.receipts_issued && <Lock className="size-4" aria-hidden />}
      </p>
      <p className="text-xs text-muted-foreground">
        {fees.receipts_issued ? t('fee.setup.prefixLocked') : t('fee.setup.prefixWhere')}
      </p>
    </div>
  );
}

/**
 * Pre-pilot opening balance of one account (owner only, once, before any money moves through it;
 * the API answers 409 otherwise). Rupees in, paisa out.
 */
function OpeningForm({ account }: { account: Account }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [asOf, setAsOf] = useState(karachiToday());
  const [err, setErr] = useState<string | undefined>();
  const save = useMutation({
    mutationFn: (paisa: number) =>
      sendJson('POST', `/api/accounts/${account.id}/opening`, { amount: paisa, as_of: asOf }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['accounts'] });
      toast.success(t('fee.setup.openingSaved'));
    },
  });
  return (
    <form
      className="flex w-full flex-wrap items-end gap-2"
      noValidate
      id={`opening-form-${account.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        const p = rupeesToPaisa(amount);
        if (p === null || p === undefined)
          return setErr(amount ? 'amount_invalid' : 'amount_required');
        setErr(undefined);
        save.mutate(p);
      }}
    >
      <Field id={`opening-amount-${account.id}`} label="fee.setup.opening" error={err}>
        <AmountInput id={`opening-amount-${account.id}`} value={amount} onChange={setAmount} />
      </Field>
      <Field id={`opening-date-${account.id}`} label="fee.setup.openingAsOf">
        <Input
          id={`opening-date-${account.id}`}
          type="date"
          className="num"
          max={karachiToday()}
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="outline" disabled={save.isPending}>
        {t('fee.setup.openingSet')}
      </Button>
      <ErrorNote error={save.error} />
    </form>
  );
}

function AccountsEditor() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const accounts = useAccounts().data?.accounts ?? [];
  const isOwner = useRoles().includes('owner');
  const staff = (useStaff().data?.items ?? []).filter((s) => s.staff_id);
  const [d, setD] = useState({ name: '', kind: 'cash' as Account['kind'], holder: '' });
  const [err, setErr] = useState<string | undefined>();
  const add = useMutation({
    mutationFn: () =>
      sendJson('POST', '/api/accounts', {
        name: d.name,
        kind: d.kind,
        holder_staff_id: d.holder || null,
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['accounts'] });
      setD({ name: '', kind: 'cash', holder: '' });
      toast.success(t('fee.setup.saved'));
    },
  });
  const holder = (id: string | null) =>
    staff.find((s) => s.staff_id === id)?.name ?? t('fee.setup.nobody');
  return (
    <div className="flex flex-col gap-3">
      <H>{t('fee.setup.accounts')}</H>
      <p className="text-xs text-muted-foreground">{t('fee.setup.accountsHint')}</p>
      {isOwner && <p className="text-xs text-muted-foreground">{t('fee.setup.openingHint')}</p>}
      <ul className="flex flex-col divide-y" id="accounts-list">
        {accounts.map((a) => (
          <li key={a.id} className="flex min-h-11 flex-wrap items-center gap-2">
            <bdi className="font-medium">{a.name}</bdi>
            <Badge variant="outline">{t(`fee.setup.accountKinds.${a.kind}`)}</Badge>
            {a.kind === 'cash' && (
              <span className="text-sm text-muted-foreground">
                <bdi>{holder(a.holder_staff_id)}</bdi>
              </span>
            )}
            {a.kind === 'cash' && a.has_movements && (
              <Lock
                className="size-4 text-muted-foreground"
                aria-label={t('fee.setup.holderFixed')}
              >
                <title>{t('fee.setup.holderFixed')}</title>
              </Lock>
            )}
            {a.opening_as_of ? (
              <span className="text-sm text-muted-foreground" data-opening={a.id}>
                {t('fee.setup.opening')}: <Money paisa={a.opening_balance ?? 0} /> ·{' '}
                <Num>{a.opening_as_of}</Num>
              </span>
            ) : (
              isOwner && !a.has_movements && <OpeningForm account={a} />
            )}
          </li>
        ))}
      </ul>
      <form
        className="grid gap-2 sm:grid-cols-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!d.name.trim()) return setErr('required');
          setErr(undefined);
          add.mutate();
        }}
      >
        <Field id="account-name" label="fee.setup.accountName" required error={err}>
          <Input
            id="account-name"
            value={d.name}
            maxLength={60}
            onChange={(e) => setD({ ...d, name: e.target.value })}
          />
        </Field>
        <Field id="account-kind" label="fee.setup.accountKind">
          <Select
            id="account-kind"
            value={d.kind}
            onChange={(e) => setD({ ...d, kind: e.target.value as Account['kind'] })}
          >
            {(['cash', 'bank', 'wallet'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`fee.setup.accountKinds.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field id="account-holder" label="fee.setup.holder">
          <Select
            id="account-holder"
            value={d.holder}
            onChange={(e) => setD({ ...d, holder: e.target.value })}
          >
            <option value="">{t('fee.setup.nobody')}</option>
            {staff.map((s) => (
              <option key={s.staff_id} value={s.staff_id ?? ''}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorNote error={add.error} />
        <Button type="submit" variant="outline" className="sm:col-span-3" disabled={add.isPending}>
          <Plus aria-hidden />
          {t('fee.setup.addAccount')}
        </Button>
      </form>
    </div>
  );
}

/** The setup wizard's Fees step (PLAN §14.1): heads and rates only; rules stay in Settings. */
export function WizardFees() {
  return (
    <div className="flex flex-col gap-6">
      <HeadsEditor />
      <RatesEditor />
    </div>
  );
}

/** Settings → Fees (admin/owner; PLAN §14.12 fee parts). */
export function FeeSetup() {
  const fees = useFeeSettings().data?.fees;
  return (
    <div className="flex flex-col gap-6">
      <HeadsEditor />
      <RatesEditor />
      {fees && <RulesEditor fees={fees} />}
      {fees && <PrefixInfo fees={fees} />}
      <ReceiptSeries />
      <AccountsEditor />
    </div>
  );
}

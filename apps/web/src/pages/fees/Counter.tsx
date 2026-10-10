import type {
  CollectInput,
  CollectResultDto,
  FamilyHitDto,
  FamilyStatementDto,
  FeeLineDto,
  SponsorStatementDto,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Search } from 'lucide-react';
import { type FormEvent, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { AmountInput, Figure, MethodChips, Money, StatusBadge } from '@/components/fees/common';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { ApiError, getJson, sendJson } from '@/lib/api';
import {
  AttemptKey,
  accountsFor,
  addDaysIso,
  familyKey,
  headLabel,
  karachiToday,
  mayBackdate,
  money,
  needsAccount,
  openDuesInOrder,
  type PaymentMethod,
  previewDirected,
  previewOldestFirst,
  rupeesToPaisa,
  useAccounts,
} from '@/lib/fees';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

/** What the counter collects against: a family (normal) or a sponsor (their billed share). */
export type Payer = {
  type: 'family' | 'sponsor';
  id: string;
  name: string;
  lines: FeeLineDto[];
  sponsored: FeeLineDto[];
  students: FamilyStatementDto['students'];
  credit: number;
  dues_hash: string;
  due_before_credit: number;
  net_due: number;
};

export const payerFromFamily = (f: FamilyStatementDto): Payer => ({
  type: 'family',
  id: f.family.id,
  name: f.family.name,
  lines: f.charges,
  sponsored: f.sponsored,
  students: f.students,
  credit: f.credit,
  dues_hash: f.dues_hash,
  due_before_credit: f.totals.due_before_credit,
  net_due: f.totals.due,
});

export const payerFromSponsor = (s: SponsorStatementDto): Payer => {
  const due = s.charges.reduce((a, c) => a + Math.max(0, c.due), 0);
  return {
    type: 'sponsor',
    id: s.sponsor.id,
    name: s.sponsor.name,
    lines: s.charges,
    sponsored: [],
    students: [],
    credit: s.credit,
    dues_hash: s.dues_hash,
    due_before_credit: due,
    net_due: Math.max(0, due - s.credit),
  };
};

function usePayer(family: string | null, sponsor: string | null) {
  return useQuery({
    queryKey: ['fee-payer', sponsor ? 'sponsor' : 'family', sponsor ?? family],
    queryFn: async (): Promise<Payer> =>
      sponsor
        ? payerFromSponsor(
            await getJson<SponsorStatementDto>(`/api/fees/sponsors/${sponsor}/statement`),
          )
        : payerFromFamily(await getJson<FamilyStatementDto>(`/api/fees/family/${family}`)),
    enabled: !!(family || sponsor),
    staleTime: 0,
  });
}

function FamilySearch({ onPick }: { onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const hits = useQuery({
    queryKey: ['fee-search', q],
    queryFn: () =>
      getJson<{ families: FamilyHitDto[] }>(`/api/fees/search?q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQ(text.trim());
  };
  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex flex-col gap-3 px-4">
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor="counter-search" className="text-sm font-medium">
            {t('fee.counter.searchLabel')}
          </label>
          <div className="flex gap-2">
            <Input
              id="counter-search"
              type="search"
              value={text}
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" id="counter-search-go">
              <Search aria-hidden />
              <span className="sr-only sm:not-sr-only">{t('fee.counter.search')}</span>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('fee.counter.searchHint')}</p>
        </form>
        <ErrorNote error={hits.error} />
        {hits.data && hits.data.families.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('fee.counter.noResults')}</p>
        )}
        <ul className="flex flex-col divide-y">
          {hits.data?.families.map((f) => (
            <li key={f.family_id}>
              <button
                type="button"
                id={`family-${f.family_id}`}
                onClick={() => onPick(f.family_id)}
                className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 py-2 text-start hover:bg-accent"
              >
                <span className="font-medium">
                  <bdi>{f.family_name}</bdi>
                </span>
                <span className="text-sm text-muted-foreground">
                  {f.students.map((s, i) => (
                    <span key={s.id}>
                      {i > 0 && '، '}
                      <bdi>{s.name}</bdi> <Num>{s.admission_no}</Num>
                    </span>
                  ))}
                </span>
                <span className="ms-auto">
                  <Money paisa={f.due} className="font-semibold" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** One open root as a phone-sized row: month · fee, due; gross/concession/fine/net/paid below. */
function LineRow({
  line,
  selectable,
  checked,
  onToggle,
  allocated,
}: {
  line: FeeLineDto;
  selectable?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  allocated?: number;
}) {
  const { t, i18n } = useTranslation();
  const head = (
    <span className="flex flex-wrap items-center gap-x-2">
      <Num>{line.period_key}</Num>
      <bdi>{headLabel(line, i18n.language)}</bdi>
      <StatusBadge status={line.status} />
    </span>
  );
  return (
    <li className="flex flex-col gap-1 py-2" data-line={line.id}>
      <div className="flex items-center gap-2">
        {selectable ? (
          <Checkbox
            id={`direct-${line.id}`}
            checked={!!checked}
            onChange={onToggle}
            label={head}
            className="flex-1"
          />
        ) : (
          <span className="flex-1">{head}</span>
        )}
        <Money paisa={line.due} className="font-semibold" />
      </div>
      <dl className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>
          {t('fee.col.gross')} <Money paisa={line.gross} />
        </span>
        {line.concession !== 0 && (
          <span>
            {t('fee.col.concession')} <Money paisa={line.concession} />
          </span>
        )}
        {line.fine !== 0 && (
          <span>
            {t('fee.col.fine')} <Money paisa={line.fine} />
          </span>
        )}
        {line.adjustment !== 0 && (
          <span>
            {t('fee.col.adjustment')} <Money paisa={line.adjustment} />
          </span>
        )}
        <span>
          {t('fee.col.net')} <Money paisa={line.net} />
        </span>
        <span>
          {t('fee.col.paid')} <Money paisa={line.paid} />
        </span>
        {allocated !== undefined && allocated > 0 && (
          <span className="font-medium text-primary">
            → <Money paisa={allocated} />
          </span>
        )}
      </dl>
    </li>
  );
}

/** The family card (PLAN §14.4 step 1): each child with open roots; totals; sponsor shares apart. */
export function PayerCard({
  payer,
  allocation,
  direct,
  chosen,
  onToggle,
}: {
  payer: Payer;
  allocation?: Map<string, number>;
  direct?: boolean;
  chosen?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const open = openDuesInOrder(payer.lines);
  const byStudent = new Map<string, { name: string; lines: FeeLineDto[] }>();
  for (const l of open) {
    const g = byStudent.get(l.student_id) ?? { name: l.student_name, lines: [] };
    g.lines.push(l);
    byStudent.set(l.student_id, g);
  }
  const sponsoredOpen = payer.sponsored.filter((l) => l.due > 0);
  return (
    <Card className="gap-3 py-4" id="payer-card">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <bdi>{payer.name}</bdi>
          {payer.type === 'family' && (
            <Button asChild variant="link" size="sm" className="ms-auto">
              <Link to={`/fees/family/${payer.id}`}>{t('fee.family.title')}</Link>
            </Button>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {payer.students.length > 0 && (
          <p className="flex flex-wrap gap-2 text-sm">
            {payer.students.map((s) => (
              <span key={s.id} className="flex items-center gap-1">
                <bdi>{s.name}</bdi>
                {s.group && (
                  <span className="text-muted-foreground">
                    · <bdi>{s.group}</bdi>
                  </span>
                )}
                {s.sponsored && <Badge variant="outline">{t('fee.family.sponsored_badge')}</Badge>}
              </span>
            ))}
          </p>
        )}
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('fee.counter.noDues')}</p>
        ) : (
          [...byStudent.entries()].map(([sid, g]) => (
            <div key={sid}>
              <h3 className="text-sm font-semibold">
                <bdi>{g.name}</bdi>
              </h3>
              <ul className="flex flex-col divide-y">
                {g.lines.map((l) => (
                  <LineRow
                    key={l.id}
                    line={l}
                    selectable={direct}
                    checked={chosen?.has(l.id)}
                    onToggle={() => onToggle?.(l.id)}
                    allocated={allocation?.get(l.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
        <div className="grid grid-cols-3 gap-2 border-t pt-3" id="payer-totals">
          <Figure label={t('fee.counter.dueBeforeCredit')}>
            <Money paisa={payer.due_before_credit} />
          </Figure>
          <Figure label={t('fee.counter.credit')}>
            <Money paisa={payer.credit} />
          </Figure>
          <Figure label={t('fee.counter.netDue')} tone="strong">
            <span id="payer-net-due">
              <Money paisa={payer.net_due} />
            </span>
          </Figure>
        </div>
        {sponsoredOpen.length > 0 && (
          <div className="rounded-md border border-dashed p-3" id="sponsor-shares">
            <h3 className="text-sm font-semibold">{t('fee.counter.sponsorShare')}</h3>
            <p className="text-xs text-muted-foreground">{t('fee.counter.sponsorNote')}</p>
            <ul className="flex flex-col divide-y opacity-80">
              {sponsoredOpen.map((l) => (
                <LineRow key={l.id} line={l} />
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type Attempt = {
  amount: number;
  method: PaymentMethod;
  account: string;
  reference: string;
  yesterday: boolean;
  reason: string;
  directed: { charge_id: string; amount: number }[] | null;
};

/** The request body exactly as the counter sends it (exported for tests). */
export function collectBody(payer: Payer, a: Attempt, key: string, today: string): CollectInput {
  return {
    idempotency_key: key,
    payer_type: payer.type,
    payer_id: payer.id,
    amount: a.amount,
    method: a.method,
    ...(a.reference.trim() ? { reference: a.reference.trim() } : {}),
    ...(needsAccount(a.method) ? { account_id: a.account } : {}),
    ...(a.yesterday
      ? { business_date: addDaysIso(today, -1), backdate_reason: a.reason.trim() }
      : {}),
    ...(a.directed?.length ? { directed: a.directed } : { expected_due_hash: payer.dues_hash }),
  };
}

function CollectForm({ payer, onStale }: { payer: Payer; onStale: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const roles = useRoles();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accounts = useAccounts().data?.accounts ?? [];
  const [amountText, setAmountText] = useState('');
  const [keypad, setKeypad] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [account, setAccount] = useState('');
  const [reference, setReference] = useState('');
  const [yesterday, setYesterday] = useState(false);
  const [reason, setReason] = useState('');
  const [direct, setDirect] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const attempt = useRef(new AttemptKey());
  const today = karachiToday();

  const amount = rupeesToPaisa(amountText);
  const backdateOk = mayBackdate(roles, method);
  const isYesterday = yesterday && backdateOk;
  const choices = accountsFor(method, accounts);
  const preview = useMemo(() => {
    if (!amount) return null;
    return direct
      ? previewDirected(payer.lines, chosen, amount)
      : previewOldestFirst(payer.lines, amount);
  }, [amount, direct, chosen, payer.lines]);
  const allocation = new Map(preview?.rows.map((r) => [r.line.id, r.amount]) ?? []);

  const current = (): Attempt | null => {
    const e: Record<string, string> = {};
    if (!amountText.trim()) e.amount = 'amount_required';
    else if (!amount) e.amount = 'amount_invalid';
    if (needsAccount(method) && !account) e.account = 'account_required';
    if (isYesterday && !reason.trim()) e.reason = 'backdate_reason_required';
    setErrors(e);
    if (Object.keys(e).length || !amount || !preview) return null;
    return {
      amount,
      method,
      account,
      reference,
      yesterday: isYesterday,
      reason,
      directed: direct
        ? preview.rows
            .filter((r) => r.amount > 0)
            .map((r) => ({ charge_id: r.line.id, amount: r.amount }))
        : null,
    };
  };

  const collect = useMutation({
    mutationFn: (a: Attempt) => {
      const sig = JSON.stringify([payer.type, payer.id, payer.dues_hash, a]);
      const key = attempt.current.for(sig);
      return sendJson<CollectResultDto>('POST', '/api/receipts', collectBody(payer, a, key, today));
    },
    onSuccess: async (r) => {
      attempt.current.reset();
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: ['fee-search'] });
      await qc.invalidateQueries({ queryKey: ['fee-dashboard'] });
      await qc.invalidateQueries({ queryKey: familyKey(payer.id) });
      navigate(`/receipts/${r.receipt.id}`);
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'stale_dues') {
        attempt.current.reset();
        setConfirming(false);
        setChosen(new Set());
        await onStale();
        toast.info(t('fee.counter.reloaded'));
      } else if (err instanceof ApiError && err.code === 'idempotency_conflict') {
        attempt.current.reset();
      }
      // Anything else (network, 5xx): the key is kept, so "Confirm" again replays this attempt.
    },
  });

  const open = (e: FormEvent) => {
    e.preventDefault();
    collect.reset();
    if (current()) setConfirming(true);
  };
  const issue = () => {
    const a = current();
    if (a) collect.mutate(a);
  };
  const networkError =
    collect.error && !(collect.error instanceof ApiError) ? new Error('network') : collect.error;

  return (
    <form onSubmit={open} className="flex flex-col gap-4" id="collect-form" noValidate>
      <PayerCard
        payer={payer}
        allocation={allocation}
        direct={direct}
        chosen={chosen}
        onToggle={(id) =>
          setChosen((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          })
        }
      />
      <Card className="gap-3 py-4">
        <CardContent className="flex flex-col gap-4 px-4">
          <Field id="counter-amount" label="fee.counter.amount" required error={errors.amount}>
            <div className="flex flex-col gap-2">
              <AmountInput
                id="counter-amount"
                value={amountText}
                onChange={setAmountText}
                keypad={keypad}
                invalid={!!errors.amount}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                aria-pressed={keypad}
                onClick={() => setKeypad((k) => !k)}
              >
                <Calculator aria-hidden />
                {t('fee.counter.keypad')}
              </Button>
            </div>
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('fee.counter.method')}</span>
            <MethodChips
              value={method}
              onChange={(m) => {
                setMethod(m);
                setAccount('');
                if (m === 'cash') setYesterday(false);
              }}
            />
          </div>
          {needsAccount(method) && (
            <Field id="counter-account" label="fee.counter.account" required error={errors.account}>
              {choices.length === 0 ? (
                <p className="text-sm text-destructive">{t('fee.counter.noAccounts')}</p>
              ) : (
                <Select
                  id="counter-account"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                  aria-invalid={!!errors.account || undefined}
                >
                  <option value="">{t('fee.counter.chooseAccount')}</option>
                  {choices.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {method !== 'cash' && (
            <Field id="counter-reference" label="fee.counter.reference">
              <Input
                id="counter-reference"
                value={reference}
                maxLength={60}
                dir="ltr"
                onChange={(e) => setReference(e.target.value)}
              />
            </Field>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('fee.counter.date')}</span>
            <p id="counter-date">
              <Num>{isYesterday ? addDaysIso(today, -1) : today}</Num>{' '}
              <span className="text-sm text-muted-foreground">
                {isYesterday ? '' : `(${t('fee.counter.today')})`}
              </span>
            </p>
            {method === 'cash' ? (
              <p className="text-xs text-muted-foreground">{t('fee.counter.cashToday')}</p>
            ) : (
              backdateOk && (
                <>
                  <Checkbox
                    id="counter-yesterday"
                    checked={yesterday}
                    onChange={(e) => setYesterday(e.target.checked)}
                    label={t('fee.counter.yesterday')}
                  />
                  {yesterday && (
                    <Field
                      id="counter-backdate-reason"
                      label="fee.counter.backdateReason"
                      required
                      error={errors.reason}
                      hint={t('fee.counter.yesterdayHint')}
                    >
                      <Input
                        id="counter-backdate-reason"
                        value={reason}
                        maxLength={200}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </Field>
                  )}
                </>
              )
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-3 py-4" id="allocation-preview">
        <CardHeader className="px-4">
          <CardTitle>{t('fee.counter.allocation')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <fieldset className="flex flex-wrap gap-2">
            {[false, true].map((d) => (
              <button
                key={String(d)}
                type="button"
                id={d ? 'alloc-direct' : 'alloc-oldest'}
                aria-pressed={direct === d}
                onClick={() => setDirect(d)}
                className={cn(
                  'min-h-11 rounded-md border px-3 text-sm',
                  direct === d && 'border-primary bg-primary/10 font-medium',
                )}
              >
                {t(d ? 'fee.counter.direct' : 'fee.counter.oldestFirst')}
              </button>
            ))}
          </fieldset>
          {direct && <p className="text-xs text-muted-foreground">{t('fee.counter.directHint')}</p>}
          {preview && (
            <ul className="flex flex-col gap-1 text-sm" id="allocation-rows">
              {preview.rows.map((r) => (
                <li key={r.line.id} className="flex gap-2" data-alloc={r.line.id}>
                  <bdi>{r.line.student_name}</bdi>
                  <Num>{r.line.period_key}</Num>
                  <span className="ms-auto">
                    <Money paisa={r.amount} />
                  </span>
                </li>
              ))}
              <li className="flex gap-2 border-t pt-1" id="allocation-credit">
                {t('fee.counter.toCredit')}
                <span className="ms-auto">
                  <Money paisa={preview.credit} />
                </span>
              </li>
              <li className="flex gap-2 font-medium">
                {t('fee.counter.afterDue')}
                <span className="ms-auto">
                  <Money paisa={Math.max(0, preview.after)} />
                </span>
              </li>
            </ul>
          )}
        </CardContent>
      </Card>

      <ErrorNote error={confirming ? null : networkError} />
      <Button type="submit" size="lg" id="counter-confirm" disabled={collect.isPending}>
        {t('fee.counter.confirm')}
      </Button>

      <Dialog open={confirming} onOpenChange={(o) => !collect.isPending && setConfirming(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('fee.counter.confirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('fee.counter.confirmBody', {
                amount: `⁨${money(amount ?? 0)}⁩`,
                method: t(`fee.methods.${method}`),
                family: `⁨${payer.name}⁩`,
              })}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <p className="text-sm">
              {t('fee.counter.afterDue')}: <Money paisa={Math.max(0, preview.after)} /> ·{' '}
              {t('fee.counter.toCredit')}: <Money paisa={preview.credit} />
            </p>
          )}
          <ErrorNote error={networkError} />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={collect.isPending}
              onClick={() => setConfirming(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button type="button" id="counter-issue" onClick={issue} disabled={collect.isPending}>
              {collect.isPending ? t('fee.counter.confirming') : t('fee.counter.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

/** PLAN §14.4: search → family view → amount, method, preview → confirm → receipt. */
export function CounterPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const family = params.get('family');
  const sponsor = params.get('sponsor');
  const payer = usePayer(family, sponsor);
  const qc = useQueryClient();
  const pick = (id: string) => setParams({ family: id });
  const refetch = () =>
    payer.refetch().then(() => qc.invalidateQueries({ queryKey: ['fee-search'] }));
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <PageTitle
        actions={
          (family || sponsor) && (
            <Button variant="outline" size="sm" onClick={() => setParams({})}>
              {t('fee.counter.change')}
            </Button>
          )
        }
      >
        {t('fee.counter.title')}
      </PageTitle>
      {!family && !sponsor && <FamilySearch onPick={pick} />}
      {payer.isLoading && <p className="text-muted-foreground">{t('common.loading')}</p>}
      <ErrorNote error={payer.error} />
      {payer.data && (
        // Not remounted on reload: after stale_dues the amount stays, the message explains, and the
        // attempt key changes with the new dues hash.
        <CollectForm payer={payer.data} onStale={refetch} />
      )}
    </section>
  );
}

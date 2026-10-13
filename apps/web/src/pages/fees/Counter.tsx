import type {
  CollectInput,
  CollectResultDto,
  FamilyHitDto,
  FamilyStatementDto,
  FeeLineDto,
  FineDto,
  SponsorStatementDto,
} from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Calculator, Search } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { Avatar } from '@/components/avatar';
import { AmountInput, Figure, MethodChips, Money, StatusBadge } from '@/components/fees/common';
import { WaiveFineDialog } from '@/components/fees/dialogs';
import { FeesTabs } from '@/components/fees/FeesTabs';
import { ErrorNote, Field, Num } from '@/components/form';
import { GoLink, ListSkeleton, Page, PageHeader, Panel } from '@/components/page';
import '@/i18n/screens';
import { Badge } from '@/components/ui/badge';
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
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/sonner';
import { ApiError, getJson, sendJson } from '@/lib/api';
import {
  type AllocationPreview,
  accountsFor,
  addDaysIso,
  balanceAfter,
  canConcession,
  familyKey,
  fineOf,
  formatRupeeInput,
  headLabel,
  karachiToday,
  mayBackdate,
  mintAttemptKey,
  money,
  needsAccount,
  openDuesInOrder,
  outcomeUnknown,
  type PaymentMethod,
  paisaToRupeeText,
  previewDirected,
  previewOldestFirst,
  rupeesToPaisa,
  useAccounts,
} from '@/lib/fees';
import { canManageSettings, useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { useOutboxStatus } from '@/offline/sync';

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
  /** Late fines on the payer's roots (family only; sponsors are never fined). */
  fines: FineDto[];
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
  fines: f.fines ?? [],
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
    fines: [],
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
    // On reconnect the counter first replays a pending attempt, then reloads (CollectForm).
    refetchOnReconnect: false,
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
    <Panel bodyClassName="flex flex-col gap-3 p-4">
      <form onSubmit={submit} className="flex flex-col gap-2" data-tour="counter-search">
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
          <Button type="submit" id="counter-search-go" className="min-w-11">
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
              className="flex min-h-12 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-2 text-start hover:bg-accent"
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
    </Panel>
  );
}

/** One open root as a phone-sized row: month · fee, due; gross/concession/fine/net/paid below. */
function LineRow({
  line,
  selectable,
  checked,
  onToggle,
  allocated,
  fine,
  onWaive,
  disabled,
}: {
  line: FeeLineDto;
  disabled?: boolean | undefined;
  selectable?: boolean;
  checked?: boolean;
  onToggle?: () => void;
  allocated?: number;
  fine?: FineDto | undefined;
  onWaive?: (() => void) | undefined;
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
            disabled={disabled}
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
          <span className="rounded bg-brand-soft px-1.5 font-semibold text-brand">
            <span className="rtl:-scale-x-100 inline-block">→</span> <Money paisa={allocated} />
          </span>
        )}
      </dl>
      {fine && (
        <div className="flex flex-wrap items-center gap-2">
          {fine.left > 0 && onWaive ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              id={`waive-${fine.id}`}
              onClick={onWaive}
            >
              {t('fee.counter.waiveFine')}
            </Button>
          ) : fine.left <= 0 ? (
            <Badge variant="outline" data-waived={fine.id}>
              {t('fee.counter.fineWaived')}
            </Badge>
          ) : null}
        </div>
      )}
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
  onWaive,
  locked,
}: {
  payer: Payer;
  /** An unresolved attempt is pending: the ticks are frozen with it. */
  locked?: boolean;
  allocation?: Map<string, number>;
  direct?: boolean;
  chosen?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  /** Present for owner/admin (fee.concession): a fined line offers "Waive fine". */
  onWaive?: (fine: FineDto, line: FeeLineDto) => void;
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
    <Panel
      id="payer-card"
      tour="counter-family"
      title={<bdi>{payer.name}</bdi>}
      action={
        payer.type === 'family' && (
          <GoLink to={`/fees/family/${payer.id}`}>{t('fee.family.title')}</GoLink>
        )
      }
      bodyClassName="flex flex-col"
    >
      {payer.students.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-b px-4 py-3" aria-label={t('fee.col.student')}>
          {payer.students.map((s) => (
            <li
              key={s.id}
              className="flex min-h-10 items-center gap-2 rounded-full border bg-background py-1 ps-1 pe-3 text-sm"
            >
              <Avatar name={s.name} size="sm" />
              <bdi className="font-medium">{s.name}</bdi>
              {s.group && (
                <span className="text-muted-foreground">
                  <bdi>{s.group}</bdi>
                </span>
              )}
              {s.sponsored && <Badge variant="outline">{t('fee.family.sponsored_badge')}</Badge>}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-3 px-4 py-3">
        {open.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t('fee.counter.noDues')}</p>
        ) : (
          [...byStudent.entries()].map(([sid, g]) => (
            <div key={sid}>
              <h3 className="text-meta font-semibold text-muted-foreground">
                <bdi>{g.name}</bdi>
              </h3>
              <ul className="flex flex-col divide-y">
                {g.lines.map((l) => (
                  <LineRow
                    key={l.id}
                    line={l}
                    selectable={direct}
                    checked={chosen?.has(l.id)}
                    disabled={locked}
                    onToggle={() => onToggle?.(l.id)}
                    allocated={allocation?.get(l.id)}
                    fine={fineOf(payer.fines, l.id)}
                    onWaive={onWaive && (() => onWaive(fineOf(payer.fines, l.id) as FineDto, l))}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
        {sponsoredOpen.length > 0 && (
          <div className="rounded-lg border border-dashed p-3" id="sponsor-shares">
            <h3 className="text-sm font-semibold">{t('fee.counter.sponsorShare')}</h3>
            <p className="text-xs text-muted-foreground">{t('fee.counter.sponsorNote')}</p>
            <ul className="flex flex-col divide-y opacity-80">
              {sponsoredOpen.map((l) => (
                <LineRow key={l.id} line={l} />
              ))}
            </ul>
          </div>
        )}
      </div>
      <div
        className="grid grid-cols-1 divide-y border-t bg-muted/40 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:rtl:divide-x-reverse"
        id="payer-totals"
      >
        <div className="px-4 py-3">
          <Figure label={t('fee.counter.dueBeforeCredit')}>
            <Money paisa={payer.due_before_credit} />
          </Figure>
        </div>
        <div className="px-4 py-3">
          <Figure label={t('fee.counter.credit')}>
            <Money paisa={payer.credit} />
          </Figure>
        </div>
        <div className="px-4 py-3">
          <Figure label={t('fee.counter.netDue')} tone="strong">
            <span id="payer-net-due">
              <Money paisa={payer.net_due} />
            </span>
          </Figure>
        </div>
      </div>
    </Panel>
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
/**
 * The "One month" quick amount: what the oldest open month still owes (its open lines' dues, in
 * the server's allocation order), never more than the net due. 0 (no button) when there is
 * nothing open or only one month is open, where "Full due" already says it.
 */
export function oneMonthAmount(payer: Pick<Payer, 'lines' | 'net_due'>): number {
  const open = openDuesInOrder(payer.lines);
  const first = open[0];
  if (!first) return 0;
  const month = open.filter((l) => l.period_key === first.period_key);
  if (month.length === open.length) return 0;
  const sum = month.reduce((n, l) => n + l.due, 0);
  return Math.max(0, Math.min(sum, payer.net_due));
}

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

type PreviewRow = {
  id: string;
  student_name: string;
  period_key: string;
  head_name: string;
  head_name_ur: string | null;
  amount: number;
};
type PreviewSnapshot = { rows: PreviewRow[]; credit: number; balance: number };

/**
 * One collection attempt: its key is minted once (amount + method + payer + collector + a nonce,
 * never the dues hash) and the body is frozen with it. It stays until success, `stale_dues`,
 * `idempotency_conflict`, a definite refusal, or "Start over"; while it stays, every retry —
 * including the automatic one on reconnect — re-sends this exact body, so a lost answer replays
 * the original receipt instead of charging twice.
 */
export type PendingAttempt = {
  key: string;
  body: CollectInput;
  attempt: Attempt;
  preview: PreviewSnapshot;
};

export const pendingStorageKey = (payer: Pick<Payer, 'type' | 'id'>) =>
  `maktab.counter.pending.${payer.type}.${payer.id}`;

function loadPending(k: string): PendingAttempt | null {
  try {
    const raw = sessionStorage.getItem(k);
    return raw ? (JSON.parse(raw) as PendingAttempt) : null;
  } catch {
    return null;
  }
}
function savePending(k: string, p: PendingAttempt | null): void {
  try {
    if (p) sessionStorage.setItem(k, JSON.stringify(p));
    else sessionStorage.removeItem(k);
  } catch {
    // Private mode / storage blocked: the attempt still lives in memory for this page.
  }
}

const snapshot = (p: AllocationPreview<FeeLineDto>, payerCredit: number): PreviewSnapshot => ({
  rows: p.rows.map((r) => ({
    id: r.line.id,
    student_name: r.line.student_name,
    period_key: r.line.period_key,
    head_name: r.line.head_name,
    head_name_ur: r.line.head_name_ur,
    amount: r.amount,
  })),
  credit: p.credit,
  balance: balanceAfter(p, payerCredit),
});

function CollectForm({
  payer,
  onStale,
  onRefresh,
}: {
  payer: Payer;
  onStale: () => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
}) {
  const { t, i18n } = useTranslation();
  const roles = useRoles();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const accounts = useAccounts().data?.accounts ?? [];
  const storageKey = pendingStorageKey(payer);
  const restored = useMemo(() => loadPending(storageKey), [storageKey]);
  const [pending, setPendingState] = useState<PendingAttempt | null>(restored);
  const pendingRef = useRef(pending);
  const setPending = useCallback(
    (p: PendingAttempt | null) => {
      pendingRef.current = p;
      setPendingState(p);
      savePending(storageKey, p);
    },
    [storageKey],
  );
  const a0 = restored?.attempt;
  const [amountText, setAmountText] = useState(
    a0 ? formatRupeeInput(paisaToRupeeText(a0.amount)) : '',
  );
  const [keypad, setKeypad] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>(a0?.method ?? 'cash');
  const [account, setAccount] = useState(a0?.account ?? '');
  const [reference, setReference] = useState(a0?.reference ?? '');
  const [yesterday, setYesterday] = useState(a0?.yesterday ?? false);
  const [reason, setReason] = useState(a0?.reason ?? '');
  const [direct, setDirect] = useState(!!a0?.directed);
  const [chosen, setChosen] = useState<Set<string>>(
    new Set(a0?.directed?.map((d) => d.charge_id) ?? []),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [waiving, setWaiving] = useState<{ fine: FineDto; line: FeeLineDto } | null>(null);
  const today = karachiToday();
  const locked = pending !== null;

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
  const directEmpty = direct && chosen.size === 0;
  const amountHigh = !!amount && payer.net_due > 0 && amount > 3 * payer.net_due;
  const oneMonth = oneMonthAmount(payer);

  // After a reload (stale_dues, refocus): ticks on lines that are no longer due are dropped; if
  // that leaves "Choose lines" with nothing ticked, the mode goes back to oldest-first, so the mode
  // always matches the ticks. A pending attempt keeps its frozen ticks.
  const openIds = useMemo(
    () => new Set(openDuesInOrder(payer.lines).map((l) => l.id)),
    [payer.lines],
  );
  useEffect(() => {
    if (pending) return;
    const kept = new Set([...chosen].filter((id) => openIds.has(id)));
    if (kept.size === chosen.size) return;
    setChosen(kept);
    if (kept.size === 0 && direct) {
      setDirect(false);
      toast.info(t('fee.counter.directReset'));
    }
  }, [openIds, chosen, direct, pending, t]);

  const current = (): Attempt | null => {
    const e: Record<string, string> = {};
    if (!amountText.trim()) e.amount = 'amount_required';
    else if (!amount) e.amount = 'amount_invalid';
    if (needsAccount(method) && !account) e.account = 'account_required';
    if (isYesterday && !reason.trim()) e.reason = 'backdate_reason_required';
    setErrors(e);
    if (Object.keys(e).length || !amount || !preview || directEmpty) return null;
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
    mutationFn: (p: PendingAttempt) => sendJson<CollectResultDto>('POST', '/api/receipts', p.body),
    onSuccess: async (r) => {
      setPending(null);
      setConfirming(false);
      if (r.replayed) toast.info(t('fee.counter.replayed'));
      await qc.invalidateQueries({ queryKey: ['fee-search'] });
      await qc.invalidateQueries({ queryKey: ['fee-dashboard'] });
      await qc.invalidateQueries({ queryKey: familyKey(payer.id) });
      navigate(`/receipts/${r.receipt.id}`);
    },
    onError: async (err) => {
      if (err instanceof ApiError && err.code === 'stale_dues') {
        // The server refused before writing anything: the attempt is over; a new key is minted
        // only when the collector confirms again against the reloaded dues.
        setPending(null);
        setConfirming(false);
        await onStale();
        toast.info(t('fee.counter.reloaded'));
      } else if (err instanceof ApiError && err.code === 'idempotency_conflict') {
        setPending(null);
      } else if (!outcomeUnknown(err)) {
        // A definite refusal (validation, permission, closed drawer): nothing was written.
        setPending(null);
      }
      // Unknown outcome (no answer, 5xx): the attempt stays pending and locked; only the same key
      // is ever sent for it again.
    },
  });
  const mutateRef = useRef(collect.mutate);
  mutateRef.current = collect.mutate;
  const busyRef = useRef(false);
  busyRef.current = collect.isPending;

  // Reconnect: replay the pending attempt (same key, same body) before anything else; only then
  // reload the payer. Without a pending attempt, just reload.
  useEffect(() => {
    const onOnline = () => {
      const p = pendingRef.current;
      if (p && !busyRef.current) {
        toast.info(t('fee.counter.backOnline'));
        mutateRef.current(p, { onSettled: () => void onRefresh() });
      } else if (!p) void onRefresh();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [onRefresh, t]);

  const open = (e: FormEvent) => {
    e.preventDefault();
    collect.reset();
    if (pending || current()) setConfirming(true);
  };
  const issue = () => {
    if (pendingRef.current) return collect.mutate(pendingRef.current);
    const a = current();
    if (!a || !preview) return;
    const key = mintAttemptKey();
    const p: PendingAttempt = {
      key,
      body: collectBody(payer, a, key, today),
      attempt: a,
      preview: snapshot(preview, payer.credit),
    };
    setPending(p);
    collect.mutate(p);
  };
  const startOver = () => {
    setPending(null);
    collect.reset();
    setConfirming(false);
  };
  const networkError =
    collect.error && !(collect.error instanceof ApiError) ? new Error('network') : collect.error;
  const offline = useOutboxStatus().offline;

  // What the confirm dialog shows: the frozen attempt when one is pending, else the form.
  const shown: { a: Attempt; view: PreviewSnapshot } | null = pending
    ? { a: pending.attempt, view: pending.preview }
    : amount && preview
      ? {
          a: {
            amount,
            method,
            account,
            reference,
            yesterday: isYesterday,
            reason,
            directed: null,
          },
          view: snapshot(preview, payer.credit),
        }
      : null;
  const shownDate = shown?.a.yesterday ? addDaysIso(today, -1) : today;
  const shownAccount = shown && accounts.find((x) => x.id === shown.a.account);

  return (
    <form
      onSubmit={open}
      className="grid gap-4 pb-24 md:pb-0 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] lg:items-start"
      id="collect-form"
      noValidate
    >
      {pending && (
        <div
          role="alert"
          id="counter-pending"
          className="flex flex-col gap-2 rounded-xl border border-warn bg-warn-soft p-4 text-sm lg:col-span-2"
        >
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            {t('fee.counter.pendingTitle')}
          </p>
          <p>{t('fee.counter.pendingBody')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              id="counter-retry"
              disabled={collect.isPending}
              onClick={() => collect.mutate(pending)}
            >
              {collect.isPending ? t('fee.counter.confirming') : t('fee.counter.retry')}
            </Button>
            <Button
              type="button"
              variant="outline"
              id="counter-start-over"
              disabled={collect.isPending}
              onClick={startOver}
            >
              {t('fee.counter.startOver')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('fee.counter.startOverNote')}</p>
        </div>
      )}
      <PayerCard
        payer={payer}
        allocation={allocation}
        direct={direct}
        chosen={chosen}
        locked={locked}
        onToggle={(id) =>
          !locked &&
          setChosen((s) => {
            const n = new Set(s);
            if (n.has(id)) n.delete(id);
            else n.add(id);
            return n;
          })
        }
        {...(canConcession(roles) && payer.type === 'family'
          ? { onWaive: (fine: FineDto, line: FeeLineDto) => setWaiving({ fine, line }) }
          : {})}
      />
      <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-18">
        <Panel title={t('screens.fees.payment')} bodyClassName="p-4">
          <fieldset disabled={locked} className="flex min-w-0 flex-col gap-4" id="counter-inputs">
            <Field
              id="counter-amount"
              tour="counter-amount"
              label="fee.counter.amount"
              required
              error={errors.amount}
            >
              <div className="flex flex-col gap-2">
                <AmountInput
                  id="counter-amount"
                  value={amountText}
                  onChange={setAmountText}
                  keypad={keypad && !locked}
                  invalid={!!errors.amount}
                />
                {amountHigh && (
                  <p
                    role="status"
                    id="counter-amount-high"
                    className="text-sm font-medium text-warn"
                  >
                    {t('fee.counter.amountHigh', { due: `⁨${money(payer.net_due)}⁩` })}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {payer.net_due > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      id="counter-full-due"
                      onClick={() =>
                        setAmountText(formatRupeeInput(paisaToRupeeText(payer.net_due)))
                      }
                    >
                      {t('screens.fees.fullDue')} <Money paisa={payer.net_due} />
                    </Button>
                  )}
                  {oneMonth > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      id="counter-one-month"
                      onClick={() => setAmountText(formatRupeeInput(paisaToRupeeText(oneMonth)))}
                    >
                      {t('screens.fees.oneMonth')} <Money paisa={oneMonth} />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={keypad}
                    onClick={() => setKeypad((k) => !k)}
                  >
                    <Calculator aria-hidden />
                    {t('fee.counter.keypad')}
                  </Button>
                </div>
              </div>
            </Field>
            <div className="flex flex-col gap-1.5" data-tour="counter-method">
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
              <Field
                id="counter-account"
                label="fee.counter.account"
                required
                error={errors.account}
              >
                {choices.length === 0 ? (
                  <p className="text-sm text-destructive" id="counter-no-accounts">
                    {t(
                      canManageSettings(roles)
                        ? 'fee.counter.noAccounts'
                        : 'fee.counter.noAccountsAsk',
                    )}
                  </p>
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
          </fieldset>
        </Panel>

        <Panel
          id="allocation-preview"
          title={t('fee.counter.allocation')}
          bodyClassName="flex flex-col gap-3 p-4"
        >
          <fieldset className="flex flex-wrap gap-2" disabled={locked}>
            {[false, true].map((d) => (
              <button
                key={String(d)}
                type="button"
                id={d ? 'alloc-direct' : 'alloc-oldest'}
                aria-pressed={direct === d}
                onClick={() => setDirect(d)}
                className={cn(
                  'min-h-11 rounded-md border px-3 text-sm font-medium',
                  direct === d
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'bg-card hover:bg-accent',
                )}
              >
                {t(d ? 'fee.counter.direct' : 'fee.counter.oldestFirst')}
              </button>
            ))}
          </fieldset>
          {direct && <p className="text-xs text-muted-foreground">{t('fee.counter.directHint')}</p>}
          {directEmpty && (
            <p
              role="status"
              id="alloc-direct-empty"
              className="text-sm font-medium text-destructive"
            >
              {t('fee.counter.directEmpty')}
            </p>
          )}
          {preview && !directEmpty && (
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
              <li className="flex gap-2 font-semibold" id="allocation-after">
                {t('fee.counter.balanceAfter')}
                <span className="ms-auto">
                  <Money paisa={balanceAfter(preview, payer.credit)} />
                </span>
              </li>
            </ul>
          )}
          {!preview && !directEmpty && (
            <p className="text-sm text-muted-foreground">{t('screens.fees.previewEmpty')}</p>
          )}
        </Panel>

        <ErrorNote error={confirming ? null : networkError} />
        {offline && !pending && (
          <p
            id="counter-offline"
            role="status"
            className="rounded-lg bg-warn-soft p-3 text-sm font-medium text-warn"
          >
            {t('fee.counter.offlineReadOnly')}
          </p>
        )}
        <div
          data-action-bar
          style={{ bottom: 'var(--tabbar-h, 0px)' }}
          className="fixed inset-x-0 z-10 flex items-center gap-3 border-t bg-card/95 p-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0"
        >
          {amount ? (
            <span className="flex min-w-0 flex-col md:hidden">
              <span className="text-meta text-muted-foreground">{t('fee.counter.amount')}</span>
              <Money paisa={amount} className="text-lg font-bold" />
            </span>
          ) : null}
          <Button
            type="submit"
            size="lg"
            id="counter-confirm"
            data-tour="counter-confirm"
            className="ms-auto min-w-40 md:w-full"
            // Offline the family view is a read-only copy (M7): no new collection until the phone is
            // back online. An attempt already made keeps its own retry (same idempotency key).
            disabled={collect.isPending || (!locked && directEmpty) || (offline && !pending)}
          >
            {t('fee.counter.confirm')}
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={(o) => !collect.isPending && setConfirming(o)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('fee.counter.confirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('fee.counter.confirmBody', {
                amount: `⁨${money(shown?.a.amount ?? 0)}⁩`,
                method: t(`fee.methods.${shown?.a.method ?? method}`),
                family: `⁨${payer.name}⁩`,
              })}
            </DialogDescription>
          </DialogHeader>
          {shown && (
            <div className="flex flex-col gap-3 text-sm" id="confirm-details">
              {shown.a.yesterday && (
                <p
                  role="alert"
                  id="confirm-yesterday"
                  className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-base font-semibold text-destructive"
                >
                  <AlertTriangle className="size-5 shrink-0" aria-hidden />
                  {t('fee.counter.yesterdayWarning', { date: `⁨${shownDate}⁩` })}
                </p>
              )}
              <ul className="flex flex-col divide-y" id="confirm-rows">
                {shown.view.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-x-2 py-1" data-confirm-row={r.id}>
                    <bdi>{r.student_name}</bdi>·<Num>{r.period_key}</Num>·
                    <bdi>{headLabel(r, i18n.language)}</bdi>
                    <span className="ms-auto">
                      <Money paisa={r.amount} />
                    </span>
                  </li>
                ))}
              </ul>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-t pt-3 [&>dd]:text-end [&>dd]:whitespace-nowrap">
                {needsAccount(shown.a.method) && (
                  <>
                    <dt className="text-muted-foreground">{t('fee.counter.confirmAccount')}</dt>
                    <dd id="confirm-account">{shownAccount?.name ?? ''}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">{t('fee.counter.confirmDate')}</dt>
                <dd id="confirm-date">
                  <Num>{shownDate}</Num>{' '}
                  {!shown.a.yesterday && (
                    <span className="text-muted-foreground">({t('fee.counter.today')})</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">{t('fee.counter.toCredit')}</dt>
                <dd id="confirm-credit">
                  <Money paisa={shown.view.credit} />
                </dd>
                <dt className="text-muted-foreground">{t('fee.counter.balanceAfter')}</dt>
                <dd id="confirm-after">
                  <Money paisa={shown.view.balance} />
                </dd>
              </dl>
            </div>
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
      {waiving && (
        <WaiveFineDialog
          open
          fine={waiving.fine}
          line={waiving.line}
          onOpenChange={(o) => !o && setWaiving(null)}
        />
      )}
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
  const { refetch: refetchPayer } = payer;
  const refetch = useCallback(
    () => refetchPayer().then(() => qc.invalidateQueries({ queryKey: ['fee-search'] })),
    [refetchPayer, qc],
  );
  return (
    <Page width={family || sponsor ? 'detail' : 'form'}>
      <PageHeader
        title={t('fee.counter.title')}
        help="collect-fee"
        actions={
          (family || sponsor) && (
            <Button variant="outline" onClick={() => setParams({})}>
              {t('fee.counter.change')}
            </Button>
          )
        }
      />
      <FeesTabs />
      {!family && !sponsor && <FamilySearch onPick={pick} />}
      {payer.isLoading && (
        <Panel>
          <ListSkeleton rows={4} />
        </Panel>
      )}
      <ErrorNote error={payer.error} />
      {payer.data && (
        // Not remounted on reload: after stale_dues the amount stays and the message explains; a
        // new key is minted only when the collector confirms again. Keyed by payer so another
        // family never inherits this one's pending attempt.
        <CollectForm
          key={`${payer.data.type}:${payer.data.id}`}
          payer={payer.data}
          onStale={refetch}
          onRefresh={refetch}
        />
      )}
    </Page>
  );
}

import type { GenerateResultDto, UnbilledDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Play, RotateCcw, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Column, DataTable } from '@/components/data-table';
import { DateText } from '@/components/date-text';
import { useFeeInvalidate } from '@/components/fees/dialogs';
import { FeesTabs } from '@/components/fees/FeesTabs';
import { ErrorNote, Field, Num } from '@/components/form';
import { MonthInput } from '@/components/month-input';
import { EmptyState, Mny, Page, PageHeader, Panel, StatusBadge } from '@/components/page';
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
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson } from '@/lib/api';
import { karachiToday } from '@/lib/fees';
import { useGroups } from '@/lib/queries';
import { cn } from '@/lib/utils';
import '@/i18n/screens';

type Counts = GenerateResultDto['counts'];
export type GenerateSummary = {
  byGroup: Map<string, Counts>;
  totals: Counts;
  failed: NonNullable<GenerateResultDto['failed']>[];
  requests: number;
};

const zero = (): Counts => ({ fees: 0, concessions: 0, sponsored: 0, allocations: 0 });
const add = (a: Counts, b: Counts): Counts => ({
  fees: a.fees + b.fees,
  concessions: a.concessions + b.concessions,
  sponsored: a.sponsored + b.sponsored,
  allocations: a.allocations + b.allocations,
});

/**
 * A dry run plans each group from ALL of its students' enrolments (primary first), so a student in a
 * class and a batch is planned in both groups' previews — while the commit bills them once (the
 * second group finds the rows already there). The preview therefore counts each (student, head,
 * period) once — per payer for sponsor lines — and credits it to the first group that planned it,
 * so preview == commit (M4 fix pass, C3).
 */
export function dedupedCounts(planned: GenerateResultDto['planned'], seen: Set<string>): Counts {
  const c = zero();
  for (const p of planned) {
    const key = `${p.kind}|${p.student_id}|${p.fee_head_id}|${p.period_key}|${p.payer_type}|${
      p.payer_type === 'sponsor' ? p.payer_id : ''
    }`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.kind === 'concession') c.concessions++;
    else if (p.payer_type === 'sponsor') c.sponsored++;
    else c.fees++;
  }
  return c;
}

/**
 * The client loop over POST /api/fees/generate (one ≤ 200-row chunk per request, PLAN §15): send
 * `next` back until it is null; a `failed` group is collected and skipped (the server's `next`
 * already moves past it). A guard stops a server that never finishes.
 */
export async function runGenerate(
  post: (body: Record<string, unknown>) => Promise<GenerateResultDto>,
  o: {
    period: string;
    dryRun: boolean;
    proRata?: boolean;
    onProgress?: (s: GenerateSummary) => void;
  },
): Promise<GenerateSummary> {
  const s: GenerateSummary = { byGroup: new Map(), totals: zero(), failed: [], requests: 0 };
  const seen = new Set<string>();
  let next: GenerateResultDto['next'] = null;
  do {
    const r: GenerateResultDto = await post({
      period: o.period,
      dry_run: o.dryRun,
      pro_rata: !!o.proRata,
      ...(next ? { grp_id: next.grp_id, after_student_id: next.after_student_id } : {}),
    });
    s.requests++;
    const counts = o.dryRun && r.planned.length ? dedupedCounts(r.planned, seen) : r.counts;
    if (r.grp_id) s.byGroup.set(r.grp_id, add(s.byGroup.get(r.grp_id) ?? zero(), counts));
    s.totals = add(s.totals, counts);
    if (r.failed) s.failed.push(r.failed);
    o.onProgress?.({ ...s, byGroup: new Map(s.byGroup) });
    next = r.next;
  } while (next && s.requests < 2000);
  return s;
}

type Runs = {
  period: string;
  complete: boolean;
  failing: {
    grp_id: string;
    fail_streak: number;
    error_code: string | null;
    retry_after: string | null;
    attention_required: boolean;
  }[];
  attention_required: number;
  /** Groups finished with no fees (rates were missing): "Re-open period" (C4). */
  reopenable?: string[];
  chunks: {
    id: string;
    grp_id: string | null;
    status: string;
    fees: number;
    concessions: number;
    sponsored: number;
    fines: number;
    error_code?: string | null;
    created_at: string;
  }[];
};

type PlannedFine = {
  id: string;
  student_id: string;
  student_name: string | null;
  admission_no: string | null;
  period_key: string;
  amount: number;
};
type Fines = { enabled: boolean; planned: PlannedFine[]; applied: number; dry_run: boolean };

/** An ISO instant (UTC) as the school's wall clock, Asia/Karachi (UTC+5, no DST): "YYYY-MM-DD HH:mm". */
export function karachiTime(iso: string): string {
  const ms = Date.parse(iso.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms + 5 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

const CODES = ['duplicate_charge', 'conflict', 'foreign_key', 'constraint', 'internal'] as const;
type BillingCode = (typeof CODES)[number] | 'unknown';
/** A billing error code as a sentence (en/ur); unknown codes get a generic word. */
export const billingCodeKey = (
  code: string | null | undefined,
): `fee.billing.codes.${BillingCode}` =>
  `fee.billing.codes.${(CODES as readonly string[]).includes(code ?? '') ? (code as BillingCode) : 'unknown'}`;

type Chunk = Runs['chunks'][number];
const RUNS_SHOWN = 6;
type Unbilled = UnbilledDto['items'][number];

/**
 * PLAN §14.5: period → preview (dry run) → generate (loop) → fines → runs. One "needs attention"
 * panel collects what is wrong (groups failing, last run's failures, months finished with no fees)
 * above the work; the month's work and the side jobs (fines, unbilled) sit side by side on desktop.
 */
export function BillingPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const groups = useGroups().data?.items ?? [];
  const name = (id: string) => {
    const g = groups.find((x) => x.id === id);
    return g ? `${g.programme_name} ${g.name}` : id;
  };
  const [period, setPeriod] = useState(karachiToday().slice(0, 7));
  const [proRata, setProRata] = useState(false);
  const [progress, setProgress] = useState<GenerateSummary | null>(null);
  const [mode, setMode] = useState<'preview' | 'generate'>('preview');
  // "Generate" needs a finished preview of the same month and options; its totals are confirmed.
  const [previewed, setPreviewed] = useState<{ key: string; totals: Counts } | null>(null);
  const [confirmGen, setConfirmGen] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
  const previewKey = `${period}|${proRata}`;
  const previewReady = previewed?.key === previewKey;
  const validPeriod = /^\d{4}-\d{2}$/.test(period);
  const runs = useQuery({
    queryKey: ['fee-runs', period],
    queryFn: () => getJson<Runs>(`/api/fees/runs?period=${period}`),
    enabled: validPeriod,
  });
  const post = (body: Record<string, unknown>) =>
    sendJson<GenerateResultDto>('POST', '/api/fees/generate', body);
  const gen = useMutation({
    mutationFn: (dryRun: boolean) => {
      setMode(dryRun ? 'preview' : 'generate');
      setProgress(null);
      return runGenerate(post, { period, dryRun, proRata, onProgress: setProgress });
    },
    onSuccess: async (sum, dryRun) => {
      if (dryRun) setPreviewed({ key: previewKey, totals: sum.totals });
      else setPreviewed(null);
      await qc.invalidateQueries({ queryKey: ['fee-runs'] });
      await qc.invalidateQueries({ queryKey: ['fee-dashboard'] });
      await qc.invalidateQueries({ queryKey: ['fee-unbilled'] });
    },
  });
  const unbilled = useQuery({
    queryKey: ['fee-unbilled', period],
    queryFn: () => getJson<UnbilledDto>(`/api/fees/unbilled?period=${period}`),
    enabled: validPeriod,
  });
  const invalidate = useFeeInvalidate();
  const billNow = useMutation({
    mutationFn: (studentId: string) =>
      sendJson<GenerateResultDto>('POST', '/api/fees/regenerate', {
        student_id: studentId,
        period,
      }),
    onSuccess: async (r) => {
      toast.success(
        r.counts.fees > 0
          ? t('fee.billing.billed', { count: r.counts.fees })
          : t('fee.billing.billedNothing'),
      );
      await invalidate();
      await qc.invalidateQueries({ queryKey: ['fee-unbilled'] });
      await qc.invalidateQueries({ queryKey: ['fee-runs'] });
    },
  });
  const fines = useMutation({
    mutationFn: (dryRun: boolean) =>
      sendJson<Fines>('POST', '/api/fees/fines/apply', { dry_run: dryRun }),
  });
  // C4: a group that finished the month with no fees (rates added late) can be re-opened.
  const reopen = useMutation({
    mutationFn: (grpId: string) =>
      sendJson('POST', '/api/fees/runs/reopen', { period, grp_id: grpId }),
    onSuccess: async () => {
      toast.success(t('fee.billing.reopened'));
      setPreviewed(null);
      await qc.invalidateQueries({ queryKey: ['fee-runs'] });
    },
  });
  const s = gen.data ?? progress;
  const failing = runs.data?.failing ?? [];
  const reopenable = runs.data?.reopenable ?? [];
  const failed = s?.failed ?? [];
  const attention = runs.data?.attention_required ?? 0;
  // Failures are an alarm (red); months that only finished with no fees are a to-do (amber).
  const alarm = attention > 0 || failing.length > 0 || failed.length > 0;
  const needsAttention = alarm || reopenable.length > 0;

  const groupCols: Column<[string, Counts]>[] = [
    {
      id: 'group',
      header: t('fee.col.group'),
      primary: true,
      cell: ([g]) => <bdi>{name(g)}</bdi>,
    },
    { id: 'fees', header: t('fee.col.head'), numeric: true, cell: ([, c]) => <Num>{c.fees}</Num> },
    {
      id: 'concessions',
      header: t('fee.col.concession'),
      numeric: true,
      cell: ([, c]) => <Num>{c.concessions}</Num>,
    },
    {
      id: 'sponsored',
      header: t('fee.col.sponsor'),
      numeric: true,
      cell: ([, c]) => <Num>{c.sponsored}</Num>,
    },
  ];
  const fineCols: Column<PlannedFine>[] = [
    {
      id: 'student',
      header: t('fee.col.student'),
      primary: true,
      cell: (f) => (
        <span className="flex flex-col items-start">
          <bdi>{f.student_name ?? ''}</bdi>
          {f.admission_no && (
            <bdi className="num text-meta font-normal text-muted-foreground">{f.admission_no}</bdi>
          )}
        </span>
      ),
    },
    { id: 'period', header: t('fee.col.period'), cell: (f) => <Num>{f.period_key}</Num> },
    {
      id: 'amount',
      header: t('fee.col.fine'),
      numeric: true,
      cell: (f) => <Mny paisa={f.amount} />,
    },
  ];
  const unbilledCols: Column<Unbilled>[] = [
    {
      id: 'student',
      header: t('fee.col.student'),
      primary: true,
      cell: (u) => (
        <span className="flex flex-col items-start" data-unbilled={u.student_id}>
          <bdi>{u.student_name}</bdi>
          <bdi className="num text-meta font-normal text-muted-foreground">{u.admission_no}</bdi>
        </span>
      ),
    },
    { id: 'group', header: t('fee.col.group'), cell: (u) => <bdi>{u.group_name}</bdi> },
    { id: 'start', header: t('fee.col.from'), cell: (u) => <DateText iso={u.start_date} /> },
  ];
  const chunkStatus = (c: Chunk) => {
    const known = c.status === 'ok' || c.status === 'failed' || c.status === 'reopened';
    const tone = c.status === 'ok' ? 'ok' : c.status === 'failed' ? 'bad' : 'neutral';
    return (
      <span className="flex flex-col items-start gap-0.5" title={c.error_code ?? undefined}>
        <StatusBadge tone={tone}>
          {known ? t(`fee.billing.statuses.${c.status as 'ok' | 'failed' | 'reopened'}`) : c.status}
        </StatusBadge>
        {c.status === 'failed' && (
          <span className="text-meta text-muted-foreground">{t(billingCodeKey(c.error_code))}</span>
        )}
      </span>
    );
  };
  const chunkCols: Column<Chunk>[] = [
    {
      id: 'group',
      header: t('fee.billing.chunk'),
      primary: true,
      cell: (c) => <bdi>{c.grp_id ? name(c.grp_id) : '—'}</bdi>,
    },
    { id: 'when', header: t('fee.col.date'), cell: (c) => <Num>{karachiTime(c.created_at)}</Num> },
    { id: 'status', header: t('fee.col.status'), cell: chunkStatus },
    { id: 'fees', header: t('fee.col.head'), numeric: true, cell: (c) => <Num>{c.fees}</Num> },
    {
      id: 'fines',
      header: t('fee.col.fine'),
      numeric: true,
      hideOnPhone: true,
      cell: (c) => <Num>{c.fines}</Num>,
    },
  ];
  // A month can have dozens of chunks: the latest few first, the rest on request.
  const chunks = runs.data?.chunks;
  const shownChunks =
    chunks && !allRuns ? chunks.slice(-RUNS_SHOWN).reverse() : chunks?.slice().reverse();

  return (
    <Page width="full" className="max-w-[1280px]">
      <PageHeader title={t('fee.billing.title')} subtitle={t('screens.fees.billingHint')} />
      <FeesTabs />

      {needsAttention && (
        <Panel
          id="billing-attention-panel"
          title={
            <span className={cn('flex items-center gap-2', alarm ? 'text-bad' : 'text-warn')}>
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              {alarm ? t('fee.billing.banner') : t('fee.billing.reopenTitle')}
            </span>
          }
          className={alarm ? 'border-bad/40' : 'border-warn/40'}
          bodyClassName="flex flex-col divide-y"
        >
          {attention > 0 && (
            <p
              role="alert"
              id="billing-attention"
              className="bg-bad-soft px-4 py-3 text-sm text-bad"
            >
              {t('fee.billing.attention', { count: attention })}
            </p>
          )}
          {failing.length > 0 && (
            <ul className="flex flex-col divide-y" id="billing-failing">
              {failing.map((f) => (
                <li
                  key={f.grp_id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                >
                  <bdi className="font-semibold">{name(f.grp_id)}</bdi>
                  <StatusBadge tone={f.attention_required ? 'bad' : 'warn'}>
                    {t(billingCodeKey(f.error_code))}
                  </StatusBadge>
                  <span className="text-meta text-muted-foreground">
                    {t('fee.billing.streak')} <Num>{f.fail_streak}</Num>
                  </span>
                  {f.retry_after && (
                    <span className="text-meta text-muted-foreground">
                      {t('fee.billing.retryAfter')} <Num>{karachiTime(f.retry_after)}</Num>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {failed.length > 0 && (
            <div role="alert" id="billing-failed" className="flex flex-col gap-1 px-4 py-3 text-sm">
              <ul className="flex flex-col gap-1">
                {failed.map((f) => (
                  <li key={f.grp_id} className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-bad">{t('fee.billing.failed')}:</span>
                    <bdi>{name(f.grp_id)}</bdi>
                    <StatusBadge tone="bad">{t(billingCodeKey(f.code))}</StatusBadge>
                  </li>
                ))}
              </ul>
              <p className="text-meta text-muted-foreground">{t('fee.billing.failedNote')}</p>
            </div>
          )}
          {reopenable.length > 0 && (
            <div className="flex flex-col gap-2 px-4 py-3" id="billing-reopenable">
              {alarm && <p className="text-sm font-semibold">{t('fee.billing.reopenTitle')}</p>}
              <p className="text-meta text-muted-foreground">{t('fee.billing.reopenHint')}</p>
              <ul className="flex flex-col divide-y">
                {reopenable.map((g) => (
                  <li key={g} className="flex flex-wrap items-center gap-2 py-1.5">
                    <bdi>{name(g)}</bdi>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ms-auto min-h-11"
                      id={`billing-reopen-${g}`}
                      disabled={reopen.isPending}
                      onClick={() => reopen.mutate(g)}
                    >
                      <RotateCcw aria-hidden />
                      {t('fee.billing.reopen')}
                    </Button>
                  </li>
                ))}
              </ul>
              <ErrorNote error={reopen.error} />
            </div>
          )}
        </Panel>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel
            id="billing-month"
            title={t('screens.fees.billMonth')}
            action={
              runs.data && (
                <StatusBadge tone={runs.data.complete ? 'ok' : 'warn'}>
                  {runs.data.complete ? t('screens.fees.billed') : t('screens.fees.notBilled')}
                </StatusBadge>
              )
            }
            bodyClassName="flex flex-col gap-4 p-4"
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-end">
              <Field id="billing-period" label="fee.billing.period">
                <MonthInput id="billing-period" value={period} onChange={(v) => setPeriod(v)} />
              </Field>
              <Checkbox
                id="billing-prorata"
                checked={proRata}
                onChange={(e) => setProRata(e.target.checked)}
                label={t('fee.billing.proRata')}
              />
            </div>
            <div className="flex flex-wrap gap-2 max-sm:[&>button]:flex-1">
              <Button
                id="billing-preview"
                variant="outline"
                disabled={gen.isPending}
                onClick={() => gen.mutate(true)}
              >
                <ScanSearch aria-hidden />
                {t('fee.billing.preview')}
              </Button>
              <Button
                id="billing-generate"
                disabled={gen.isPending || !previewReady}
                onClick={() => setConfirmGen(true)}
              >
                <Play aria-hidden />
                {t('fee.billing.generate')}
              </Button>
            </div>
            {!previewReady && !gen.isPending && (
              <p className="text-meta text-muted-foreground" id="billing-preview-first">
                {t('fee.billing.previewFirst')}
              </p>
            )}
            {gen.isPending && (
              <p role="status" className="text-sm">
                {mode === 'preview'
                  ? t('fee.billing.previewing')
                  : t('fee.billing.generating', { count: s?.byGroup.size ?? 0 })}
              </p>
            )}
            <ErrorNote error={gen.error} />
            {s && !gen.isPending && (
              <p
                role="status"
                id="billing-result"
                className="rounded-lg bg-info-soft px-3 py-2 text-sm font-medium text-info"
              >
                {mode === 'preview'
                  ? t('fee.billing.previewDone', s.totals)
                  : s.totals.fees + s.totals.concessions + s.totals.sponsored === 0
                    ? t('fee.billing.nothingNew')
                    : t('fee.billing.done', s.totals)}
              </p>
            )}
          </Panel>
          {s && s.byGroup.size > 0 && (
            <Panel title={t('fee.billing.perGroup')}>
              <DataTable
                id="billing-groups"
                caption={t('fee.billing.perGroup')}
                columns={groupCols}
                rows={[...s.byGroup.entries()]}
                rowKey={([g]) => g}
              />
            </Panel>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Panel
            id="billing-fines"
            title={t('fee.billing.fines')}
            bodyClassName="flex flex-col gap-3 p-4"
          >
            <div className="flex flex-wrap gap-2">
              <Button
                id="fines-preview"
                variant="outline"
                disabled={fines.isPending}
                onClick={() => fines.mutate(true)}
              >
                <ScanSearch aria-hidden />
                {t('fee.billing.finesPreview')}
              </Button>
              {fines.data?.dry_run && fines.data.enabled && fines.data.planned.length > 0 && (
                <Button
                  id="fines-apply"
                  disabled={fines.isPending}
                  onClick={() => fines.mutate(false)}
                >
                  {t('fee.billing.finesApply')}
                </Button>
              )}
            </div>
            <ErrorNote error={fines.error} />
            {fines.data && (
              <p role="status" id="fines-result" className="text-sm">
                {!fines.data.enabled
                  ? t('fee.billing.finesOff')
                  : fines.data.dry_run
                    ? fines.data.planned.length === 0
                      ? t('fee.billing.finesNone')
                      : t('fee.billing.finesPlanned', { count: fines.data.planned.length })
                    : t('fee.billing.finesApplied', { count: fines.data.applied })}
              </p>
            )}
            {fines.data?.dry_run && fines.data.planned.length > 0 && (
              <div className="-mx-4 -mb-4 border-t">
                <DataTable
                  id="fines-planned"
                  caption={t('fee.billing.fines')}
                  columns={fineCols}
                  rows={fines.data.planned}
                  rowKey={(f) => f.id}
                />
              </div>
            )}
          </Panel>

          <Panel id="billing-unbilled" title={t('fee.billing.unbilled')}>
            <ErrorNote error={unbilled.error ?? billNow.error} />
            <DataTable
              id="billing-unbilled-list"
              caption={t('fee.billing.unbilled')}
              columns={unbilledCols}
              rows={unbilled.data?.items}
              rowKey={(u) => u.enrolment_id}
              loading={unbilled.isPending && validPeriod}
              rowActions={(u) => (
                <Button
                  size="sm"
                  variant="outline"
                  id={`bill-now-${u.student_id}`}
                  disabled={billNow.isPending}
                  onClick={() => billNow.mutate(u.student_id)}
                >
                  {t('fee.billing.billNow')}
                </Button>
              )}
              empty={
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  {t('fee.billing.unbilledNone')}
                </p>
              }
            />
            {unbilled.data?.more && (
              <p className="border-t px-4 py-2 text-meta text-muted-foreground">
                {t('fee.billing.unbilledMore')}
              </p>
            )}
          </Panel>
        </div>
      </div>

      <Panel
        id="billing-runs"
        title={t('fee.billing.runs')}
        action={
          runs.data && (
            <span className="text-meta text-muted-foreground">
              {runs.data.complete ? t('fee.billing.complete') : t('fee.billing.incomplete')}
            </span>
          )
        }
      >
        <DataTable
          id="billing-chunks"
          caption={t('fee.billing.runs')}
          columns={chunkCols}
          rows={shownChunks}
          rowKey={(c) => c.id}
          loading={runs.isPending && validPeriod}
          error={runs.error ? <ErrorNote error={runs.error} /> : undefined}
          empty={
            <EmptyState
              icon={CalendarClock}
              title={t('fee.billing.noRuns')}
              body={t('fee.billing.previewFirst')}
            />
          }
        />
        {chunks && chunks.length > RUNS_SHOWN && (
          <div className="border-t px-4 py-1">
            <Button
              variant="ghost"
              size="sm"
              id="billing-runs-all"
              aria-expanded={allRuns}
              onClick={() => setAllRuns((a) => !a)}
            >
              {allRuns
                ? t('screens.fees.runsFewer')
                : t('screens.fees.runsAll', { count: chunks.length })}
            </Button>
          </div>
        )}
      </Panel>

      <Dialog open={confirmGen} onOpenChange={setConfirmGen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('fee.billing.confirmTitle')}</DialogTitle>
            <DialogDescription id="billing-confirm-body">
              {previewed &&
                t('fee.billing.confirmBody', {
                  period: `⁨${period}⁩`,
                  ...previewed.totals,
                })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmGen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              id="billing-generate-confirm"
              onClick={() => {
                setConfirmGen(false);
                gen.mutate(false);
              }}
            >
              {t('fee.billing.generate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

import type { GenerateResultDto, UnbilledDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Play, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Money } from '@/components/fees/common';
import { useFeeInvalidate } from '@/components/fees/dialogs';
import { ErrorNote, Field, Num, PageTitle } from '@/components/form';
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
import { karachiToday } from '@/lib/fees';
import { useGroups } from '@/lib/queries';

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
  let next: GenerateResultDto['next'] = null;
  do {
    const r: GenerateResultDto = await post({
      period: o.period,
      dry_run: o.dryRun,
      pro_rata: !!o.proRata,
      ...(next ? { grp_id: next.grp_id, after_student_id: next.after_student_id } : {}),
    });
    s.requests++;
    if (r.grp_id) s.byGroup.set(r.grp_id, add(s.byGroup.get(r.grp_id) ?? zero(), r.counts));
    s.totals = add(s.totals, r.counts);
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

/** PLAN §14.5: period → preview (dry run) → generate (loop) → fines → runs. */
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
  const previewKey = `${period}|${proRata}`;
  const previewReady = previewed?.key === previewKey;
  const runs = useQuery({
    queryKey: ['fee-runs', period],
    queryFn: () => getJson<Runs>(`/api/fees/runs?period=${period}`),
    enabled: /^\d{4}-\d{2}$/.test(period),
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
    enabled: /^\d{4}-\d{2}$/.test(period),
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
          ? t('fee.billing.billed', { n: r.counts.fees })
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
  const s = gen.data ?? progress;
  const failing = runs.data?.failing ?? [];
  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageTitle>{t('fee.billing.title')}</PageTitle>
      {(runs.data?.attention_required ?? 0) > 0 && (
        <p
          role="alert"
          id="billing-attention"
          className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0" aria-hidden />
          {t('fee.billing.attention', { n: runs.data?.attention_required ?? 0 })}
        </p>
      )}
      <Card className="gap-3 py-4">
        <CardContent className="flex flex-col gap-3 px-4">
          <Field id="billing-period" label="fee.billing.period">
            <Input
              id="billing-period"
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </Field>
          <Checkbox
            id="billing-prorata"
            checked={proRata}
            onChange={(e) => setProRata(e.target.checked)}
            label={t('fee.billing.proRata')}
          />
          <div className="flex flex-wrap gap-2">
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
            <p className="text-xs text-muted-foreground" id="billing-preview-first">
              {t('fee.billing.previewFirst')}
            </p>
          )}
          {gen.isPending && (
            <p role="status" className="text-sm">
              {mode === 'preview'
                ? t('fee.billing.previewing')
                : t('fee.billing.generating', { n: s?.byGroup.size ?? 0 })}
            </p>
          )}
          <ErrorNote error={gen.error} />
          {s && !gen.isPending && (
            <p role="status" id="billing-result" className="text-sm font-medium">
              {mode === 'preview'
                ? t('fee.billing.previewDone', s.totals)
                : s.totals.fees + s.totals.concessions + s.totals.sponsored === 0
                  ? t('fee.billing.nothingNew')
                  : t('fee.billing.done', s.totals)}
            </p>
          )}
          {s && s.byGroup.size > 0 && (
            <Table id="billing-groups">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('fee.col.group')}</TableHead>
                  <TableHead className="text-end">{t('fee.col.head')}</TableHead>
                  <TableHead className="text-end">{t('fee.col.concession')}</TableHead>
                  <TableHead className="text-end">{t('fee.col.sponsor')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...s.byGroup.entries()].map(([g, c]) => (
                  <TableRow key={g}>
                    <TableCell>
                      <bdi>{name(g)}</bdi>
                    </TableCell>
                    <TableCell className="text-end">
                      <Num>{c.fees}</Num>
                    </TableCell>
                    <TableCell className="text-end">
                      <Num>{c.concessions}</Num>
                    </TableCell>
                    <TableCell className="text-end">
                      <Num>{c.sponsored}</Num>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {s && s.failed.length > 0 && (
            <div
              role="alert"
              id="billing-failed"
              className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
            >
              <ul>
                {s.failed.map((f) => (
                  <li key={f.grp_id}>
                    {t('fee.billing.failed')}: <bdi>{name(f.grp_id)}</bdi> ·{' '}
                    {t(billingCodeKey(f.code))}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs">{t('fee.billing.failedNote')}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('fee.billing.fines')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-4">
          <div className="flex flex-wrap gap-2">
            <Button
              id="fines-preview"
              variant="outline"
              disabled={fines.isPending}
              onClick={() => fines.mutate(true)}
            >
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
                    : t('fee.billing.finesPlanned', { n: fines.data.planned.length })
                  : t('fee.billing.finesApplied', { n: fines.data.applied })}
            </p>
          )}
          {fines.data?.dry_run && fines.data.planned.length > 0 && (
            <ul className="flex flex-col divide-y text-sm" id="fines-planned">
              {fines.data.planned.map((f) => (
                <li key={f.id} className="flex flex-wrap gap-x-2 py-1" data-fine={f.student_id}>
                  <bdi>{f.student_name ?? ''}</bdi>
                  {f.admission_no && <Num>{f.admission_no}</Num>}
                  <Num>{f.period_key}</Num>
                  <span className="ms-auto">
                    <Money paisa={f.amount} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="gap-3 py-4" id="billing-unbilled">
        <CardHeader className="px-4">
          <CardTitle>{t('fee.billing.unbilled')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-4">
          <ErrorNote error={unbilled.error ?? billNow.error} />
          {unbilled.data && unbilled.data.items.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('fee.billing.unbilledNone')}</p>
          )}
          <ul className="flex flex-col divide-y">
            {unbilled.data?.items.map((u) => (
              <li
                key={u.enrolment_id}
                className="flex flex-wrap items-center gap-x-2 py-1 text-sm"
                data-unbilled={u.student_id}
              >
                <bdi className="font-medium">{u.student_name}</bdi>
                <Num>{u.admission_no}</Num>
                <bdi className="text-muted-foreground">{u.group_name}</bdi>
                <Button
                  size="sm"
                  variant="outline"
                  className="ms-auto"
                  id={`bill-now-${u.student_id}`}
                  disabled={billNow.isPending}
                  onClick={() => billNow.mutate(u.student_id)}
                >
                  {t('fee.billing.billNow')}
                </Button>
              </li>
            ))}
          </ul>
          {unbilled.data?.more && (
            <p className="text-xs text-muted-foreground">{t('fee.billing.unbilledMore')}</p>
          )}
        </CardContent>
      </Card>

      <Card className="gap-3 py-4">
        <CardHeader className="px-4">
          <CardTitle>{t('fee.billing.runs')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-4">
          {runs.data && (
            <p className="text-sm">
              {runs.data.complete ? t('fee.billing.complete') : t('fee.billing.incomplete')}
            </p>
          )}
          {failing.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm text-destructive" id="billing-failing">
              {failing.map((f) => (
                <li key={f.grp_id} className="flex flex-wrap gap-2">
                  <bdi>{name(f.grp_id)}</bdi>
                  <span>{t(billingCodeKey(f.error_code))}</span>
                  <span>
                    {t('fee.billing.streak')} <Num>{f.fail_streak}</Num>
                  </span>
                  {f.retry_after && (
                    <span>
                      {t('fee.billing.retryAfter')} <Num>{karachiTime(f.retry_after)}</Num>
                    </span>
                  )}
                  {f.attention_required && <AlertTriangle className="size-4" aria-hidden />}
                </li>
              ))}
            </ul>
          )}
          {runs.data && runs.data.chunks.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('fee.billing.noRuns')}</p>
          )}
          {runs.data && runs.data.chunks.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('fee.col.date')}</TableHead>
                  <TableHead>{t('fee.billing.chunk')}</TableHead>
                  <TableHead>{t('fee.col.status')}</TableHead>
                  <TableHead className="text-end">{t('fee.col.head')}</TableHead>
                  <TableHead className="text-end">{t('fee.col.fine')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.chunks.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Num>{karachiTime(c.created_at)}</Num>
                    </TableCell>
                    <TableCell>
                      <bdi>{c.grp_id ? name(c.grp_id) : '—'}</bdi>
                    </TableCell>
                    <TableCell className="whitespace-normal break-words">
                      <span title={c.error_code ?? undefined}>
                        {c.status === 'ok' || c.status === 'failed'
                          ? t(`fee.billing.statuses.${c.status}`)
                          : c.status}
                      </span>
                      {c.status === 'failed' && (
                        <span className="block text-xs text-muted-foreground">
                          {t(billingCodeKey(c.error_code))}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <Num>{c.fees}</Num>
                    </TableCell>
                    <TableCell className="text-end">
                      <Num>{c.fines}</Num>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmGen} onOpenChange={setConfirmGen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('fee.billing.confirmTitle')}</DialogTitle>
            <DialogDescription id="billing-confirm-body">
              {previewed &&
                t('fee.billing.confirmBody', {
                  period: `\u2068${period}\u2069`,
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
    </section>
  );
}

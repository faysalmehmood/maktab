import type { ReceiptDetailDto, ReceiptPrintDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, Send, Share2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { AmountInput, MethodChips, ReasonDialog } from '@/components/fees/common';
import { type ReceiptFormat, type ReceiptLang, ReceiptPrint } from '@/components/fees/ReceiptPrint';
import { ErrorNote, Field } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson } from '@/lib/api';
import { canCollect, canReverse, money, type PaymentMethod, rupeesToPaisa } from '@/lib/fees';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

export const receiptPrintKey = (id: string | undefined) => ['receipt-print', id] as const;

/** Wait for fonts (Nastaliq) before the print dialog, or the first page prints in a fallback font. */
export async function printWhenReady(): Promise<void> {
  if (typeof document !== 'undefined' && document.fonts?.ready) await document.fonts.ready;
  window.print();
}

type ShareMode = 'files' | 'text' | 'copy';

/** What "Share" can do here: a file (if the browser can share files), text + link, or copy. */
export function shareMode(nav: Navigator = navigator, file?: File): ShareMode {
  if (typeof nav.share !== 'function') return 'copy';
  if (file && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) return 'files';
  return 'text';
}

function receiptFile(p: ReceiptPrintDto): File | undefined {
  if (typeof File === 'undefined') return undefined;
  const paper = document.getElementById('receipt-paper');
  const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  const html = `<!doctype html><html lang="${paper?.getAttribute('lang') ?? 'en'}"><head><meta charset="utf-8"><title>${p.receipt.receipt_no}</title><style>${css}</style></head><body>${paper?.outerHTML ?? ''}</body></html>`;
  return new File([html], `receipt-${p.receipt.receipt_no}.html`, { type: 'text/html' });
}

function ReverseDialog({
  receipt,
  open,
  onOpenChange,
}: {
  receipt: ReceiptPrintDto['receipt'];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [reenter, setReenter] = useState(false);
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<PaymentMethod>(receipt.method);
  const [err, setErr] = useState<string | undefined>();
  const reverse = useMutation({
    mutationFn: (reason: string) =>
      sendJson<{ reversal: ReceiptDetailDto; reentry: ReceiptDetailDto | null }>(
        'POST',
        `/api/receipts/${receipt.id}/reverse`,
        {
          reason,
          ...(reenter ? { reenter: { amount: rupeesToPaisa(amountText) ?? 0, method } } : {}),
        },
      ),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['receipt-print'] });
      await qc.invalidateQueries({ queryKey: ['fee-family'] });
      toast.success(t('fee.receipt.doneReverse'));
      onOpenChange(false);
      navigate(`/receipts/${r.reentry?.id ?? r.reversal.id}`);
    },
  });
  return (
    <ReasonDialog
      id="reverse"
      open={open}
      onOpenChange={onOpenChange}
      title={t('fee.receipt.reverseTitle')}
      body={t('fee.receipt.reverseBody')}
      confirmLabel={t('fee.receipt.reverse')}
      pending={reverse.isPending}
      error={reverse.error}
      onConfirm={(reason) => {
        if (reenter && !rupeesToPaisa(amountText)) return setErr('amount_invalid');
        setErr(undefined);
        reverse.mutate(reason);
      }}
    >
      <Checkbox
        id="reverse-reenter"
        checked={reenter}
        onChange={(e) => setReenter(e.target.checked)}
        label={t('fee.receipt.reenter')}
      />
      {reenter && (
        <>
          <Field id="reverse-amount" label="fee.receipt.reenterAmount" required error={err}>
            <AmountInput id="reverse-amount" value={amountText} onChange={setAmountText} />
          </Field>
          <MethodChips name="reenter-method" value={method} onChange={setMethod} />
        </>
      )}
    </ReasonDialog>
  );
}

/** PLAN §14.4 step 4: print (A5 / 58 mm, ur / en), share, send, reverse. */
export function ReceiptPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const roles = useRoles();
  const [params, setParams] = useSearchParams();
  const [reversing, setReversing] = useState(false);
  const q = useQuery({
    queryKey: receiptPrintKey(id),
    queryFn: () => getJson<ReceiptPrintDto>(`/api/receipts/${id}?format=print`),
    enabled: !!id,
  });
  const notify = useMutation({
    mutationFn: () =>
      sendJson<{ message_id: string; queued: boolean }>('POST', `/api/receipts/${id}/notify`),
    onSuccess: (r) =>
      toast.success(t(r.queued ? 'fee.receipt.queued' : 'fee.receipt.alreadyQueued')),
  });
  const data = q.data;
  const fmt: ReceiptFormat = params.get('fmt') === 'thermal' ? 'thermal' : 'a5';
  const lang: ReceiptLang =
    params.get('lang') === 'ur' || params.get('lang') === 'en'
      ? (params.get('lang') as ReceiptLang)
      : (data?.lang ?? 'ur');
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    n.set(k, v);
    setParams(n, { replace: true });
  };

  if (q.isLoading) return <p className="text-muted-foreground">{t('common.loading')}</p>;
  if (!data) return <ErrorNote error={q.error} />;
  const r = data.receipt;
  const share = async () => {
    const url = `${location.origin}/receipts/${r.id}`;
    const text = t('fee.receipt.shareText', {
      no: `⁨${r.receipt_no}⁩`,
      amount: `⁨${money(r.amount)}⁩`,
      school: data.school.name,
    });
    const file = receiptFile(data);
    const mode = shareMode(navigator, file);
    try {
      if (mode === 'files' && file) await navigator.share({ text, url, files: [file] });
      else if (mode === 'text') await navigator.share({ text, url });
      else {
        await navigator.clipboard?.writeText(`${text}\n${url}`);
        toast.success(t('fee.receipt.copied'));
      }
    } catch {
      // The user closed the share sheet: nothing to do.
    }
  };
  const chip = (active: boolean) =>
    cn(
      'min-h-11 min-w-11 rounded-md border px-3 text-sm',
      active && 'border-primary bg-primary/10 font-medium',
    );
  const canShowShare = typeof navigator !== 'undefined';
  const familyPayment = r.payer_type === 'family' && r.kind === 'payment';

  return (
    <section className="flex flex-col gap-4">
      <div className="no-print flex flex-col gap-3 print:hidden">
        {data.reversed && (
          <p
            role="status"
            id="receipt-reversed"
            className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive"
          >
            {t('fee.receipt.reversed')}
            {r.reversed_by && (
              <>
                {' · '}
                <Link className="underline" to={`/receipts/${r.reversed_by}`}>
                  {t('fee.receipt.reversedBy')}
                </Link>
              </>
            )}
          </p>
        )}
        {r.reverses_id && (
          <Link className="text-sm underline" to={`/receipts/${r.reverses_id}`}>
            {t('fee.receipt.original')}
          </Link>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('fee.receipt.format')}</span>
          <button
            type="button"
            id="receipt-fmt-a5"
            className={chip(fmt === 'a5')}
            aria-pressed={fmt === 'a5'}
            onClick={() => set('fmt', 'a5')}
          >
            {t('fee.receipt.a5')}
          </button>
          <button
            type="button"
            id="receipt-fmt-thermal"
            className={chip(fmt === 'thermal')}
            aria-pressed={fmt === 'thermal'}
            onClick={() => set('fmt', 'thermal')}
          >
            {t('fee.receipt.thermal')}
          </button>
          <span className="ms-2 text-sm text-muted-foreground">{t('fee.receipt.language')}</span>
          <button
            type="button"
            id="receipt-lang-ur"
            lang="ur"
            className={cn(chip(lang === 'ur'), 'font-system')}
            aria-pressed={lang === 'ur'}
            onClick={() => set('lang', 'ur')}
          >
            اردو
          </button>
          <button
            type="button"
            id="receipt-lang-en"
            lang="en"
            className={chip(lang === 'en')}
            aria-pressed={lang === 'en'}
            onClick={() => set('lang', 'en')}
          >
            English
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button id="receipt-print" onClick={() => void printWhenReady()}>
            <Printer aria-hidden />
            {t('fee.receipt.print')}
          </Button>
          {canShowShare && (
            <Button
              id="receipt-share"
              variant="outline"
              data-mode={shareMode()}
              onClick={() => void share()}
            >
              <Share2 aria-hidden />
              {t('fee.receipt.share')}
            </Button>
          )}
          {familyPayment && canCollect(roles) && !data.reversed && (
            <Button
              id="receipt-notify"
              variant="outline"
              disabled={notify.isPending}
              onClick={() => notify.mutate()}
            >
              <Send aria-hidden />
              {t('fee.receipt.notify')}
            </Button>
          )}
          {r.kind === 'payment' && !data.reversed && canReverse(roles) && (
            <Button id="receipt-reverse" variant="destructive" onClick={() => setReversing(true)}>
              <Undo2 aria-hidden />
              {t('fee.receipt.reverse')}
            </Button>
          )}
        </div>
        <ErrorNote error={notify.error} />
        <div className="flex flex-wrap gap-2 text-sm">
          {canCollect(roles) && (
            <Button asChild variant="link" size="sm">
              <Link
                to={
                  r.payer_type === 'family'
                    ? `/fees/counter?family=${r.payer_id}`
                    : `/fees/counter?sponsor=${r.payer_id}`
                }
              >
                {t('fee.receipt.newPayment')}
              </Link>
            </Button>
          )}
          {r.payer_type === 'family' && (
            <Button asChild variant="link" size="sm">
              <Link to={`/fees/family/${r.payer_id}`}>{t('fee.receipt.family')}</Link>
            </Button>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <ReceiptPrint data={data} fmt={fmt} lang={lang} />
      </div>
      {reversing && <ReverseDialog receipt={r} open={reversing} onOpenChange={setReversing} />}
    </section>
  );
}

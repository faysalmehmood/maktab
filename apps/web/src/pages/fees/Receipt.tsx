import type { ReceiptDetailDto, ReceiptPrintDto } from '@maktab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Printer, Send, Share2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { PrintBadge } from '@/components/brand/SchoolBadge';
import { AmountInput, MethodChips, ReasonDialog } from '@/components/fees/common';
import { type ReceiptFormat, type ReceiptLang, ReceiptPrint } from '@/components/fees/ReceiptPrint';
import { ErrorNote, Field } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui/sonner';
import { getJson, sendJson } from '@/lib/api';
import { canCollect, canReverse, money, type PaymentMethod, rupeesToPaisa } from '@/lib/fees';
import { printWhenReady } from '@/lib/print';
import { useSchool } from '@/lib/queries';
import { useRoles } from '@/lib/roles';
import { cn } from '@/lib/utils';

export const receiptPrintKey = (id: string | undefined) => ['receipt-print', id] as const;

/** Wait for fonts (Nastaliq) before the print dialog (lib/print.ts; re-exported for tests). */
export { printWhenReady };

type ShareMode = 'text' | 'copy';

/** What "Share" can do here: the share sheet with text, or copy the text. Never a file or URL. */
export function shareMode(nav: Navigator = navigator): ShareMode {
  return typeof nav.share === 'function' ? 'text' : 'copy';
}

/**
 * The link a guardian may open for this receipt: the family's parent page (PLAN §14.10), never a
 * staff URL. The API returns the guardian's current link, or makes one when the school's default
 * gate allows (M7); null for a non-family receipt, a PIN-only school without a link, or offline.
 */
export async function parentReceiptLink(r: ReceiptPrintDto['receipt']): Promise<string | null> {
  if (r.payer_type !== 'family' || r.kind !== 'payment') return null;
  try {
    const { url } = await sendJson<{ url: string | null }>(
      'POST',
      `/api/receipts/${r.id}/parent-link`,
    );
    return url;
  } catch {
    return null;
  }
}

/** The text "Share" sends: school, receipt no., amount and date, then the parent link alone. */
export function shareText(
  data: ReceiptPrintDto,
  t: (
    k: 'fee.receipt.shareText',
    o: { school: string; no: string; amount: string; date: string },
  ) => string,
  link: string | null = null,
): string {
  const r = data.receipt;
  const text = t('fee.receipt.shareText', {
    school: data.school.name,
    no: `\u2068${r.receipt_no}\u2069`,
    amount: `\u2068${money(r.amount)}\u2069`,
    date: `\u2068${r.business_date}\u2069`,
  });
  return link ? `${text}\n${link}` : text;
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
  const school = useSchool().data?.school;
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
    const text = shareText(data, (k, o) => t(k, o), await parentReceiptLink(r));
    try {
      if (shareMode(navigator) === 'text') await navigator.share({ text });
      else {
        await navigator.clipboard?.writeText(text);
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
                <Link
                  className="inline-flex min-h-11 items-center underline"
                  to={`/receipts/${r.reversed_by}`}
                >
                  {t('fee.receipt.reversedBy')}
                </Link>
              </>
            )}
          </p>
        )}
        {r.reverses_id && (
          <Link
            className="inline-flex min-h-11 items-center self-start text-sm underline"
            to={`/receipts/${r.reverses_id}`}
          >
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
            <bdi className="num">{t('fee.receipt.a5')}</bdi>
          </button>
          <button
            type="button"
            id="receipt-fmt-thermal"
            className={chip(fmt === 'thermal')}
            aria-pressed={fmt === 'thermal'}
            onClick={() => set('fmt', 'thermal')}
          >
            <bdi className="num">{t('fee.receipt.thermal')}</bdi>
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
        <ReceiptPrint data={data} fmt={fmt} lang={lang} badge={<PrintBadge school={school} />} />
      </div>
      {reversing && <ReverseDialog receipt={r} open={reversing} onOpenChange={setReversing} />}
    </section>
  );
}

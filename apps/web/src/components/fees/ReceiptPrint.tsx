import type { ReceiptPrintDto } from '@maktab/shared';
import { useLayoutEffect, useRef } from 'react';
import { money } from '@/lib/fees';
import { cn } from '@/lib/utils';

export type ReceiptFormat = 'a5' | 'thermal';
export type ReceiptLang = 'en' | 'ur';

/** Every number/date/amount on paper: isolated LTR, system font (exp3 rule 1). */
const N = ({ children, className }: { children: string; className?: string }) => (
  <bdi className={cn('num', className)}>{children}</bdi>
);

/**
 * The paper receipt (PLAN §14.4 step 4, exp3 receipt.html): A5 portrait or 58 mm thermal. Text is
 * in the receipt's own language (independent of the app's), labels come from the API's
 * RECEIPT_LABELS; Urdu uses Nastaliq at line-height 2 and every number stays a Latin `.num` run.
 * The thermal page height is measured after layout and injected as `@page receipt-thermal`
 * (`size: 58mm auto` is invalid in Chrome — exp3 rule 3).
 */
export function ReceiptPrint({
  data,
  fmt,
  lang,
  publicCopy = false,
  logoSrc = '/api/school/logo',
}: {
  data: ReceiptPrintDto;
  fmt: ReceiptFormat;
  lang: ReceiptLang;
  /** The parent page's copy: no admission numbers, no collector (the API does not send them). */
  publicCopy?: boolean;
  /** Staff: the session-gated logo route; the parent page passes a blob URL of /api/p/logo. */
  logoSrc?: string;
}) {
  const L = data.labels[lang];
  const r = data.receipt;
  const ref = useRef<HTMLElement>(null);
  const schoolName = lang === 'ur' && data.school.name_ur ? data.school.name_ur : data.school.name;
  const title =
    r.kind === 'reversal'
      ? L.reversal
      : r.kind === 'refund'
        ? L.refund
        : r.kind === 'opening'
          ? L.opening
          : L.title;

  // The 58 mm page is as tall as the receipt: measured now, and again once the fonts are in
  // (Nastaliq at line-height 2 is much taller than the fallback), and whenever paper or language
  // changes (Urdu and English lay out to different heights).
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const style = document.createElement('style');
    style.dataset.receiptPage = fmt;
    style.dataset.lang = lang;
    // The whole document prints on the receipt's named page while it is shown: anything outside the
    // receipt left on the default page (the app shell, the toaster's empty <section> after #root)
    // forced a page-type switch and so a blank Letter/A4 second page — on thermal (M4 fix pass, C2)
    // and on A5 alike (M7; checked with scripts/print-pages.mjs --expect 1).
    if (fmt === 'a5') {
      style.textContent = '@media print { html, body { page: receipt-a5; } }';
      document.head.appendChild(style);
      return () => style.remove();
    }
    const measure = () => {
      const mm = Math.ceil((el.offsetHeight * 25.4) / 96) + 6;
      style.textContent = `@page receipt-thermal { size: 58mm ${Math.max(mm, 60)}mm; margin: 2mm; }
@media print { html, body { page: receipt-thermal; } }`;
    };
    measure();
    document.head.appendChild(style);
    let live = true;
    document.fonts?.ready.then(() => live && measure()).catch(() => undefined);
    return () => {
      live = false;
      style.remove();
    };
  }, [fmt, lang]);

  return (
    <article
      ref={ref}
      lang={lang}
      dir={lang === 'ur' ? 'rtl' : 'ltr'}
      className={cn('receipt', `receipt-${fmt}`, data.reversed && 'receipt-reversed')}
      data-fmt={fmt}
      data-lang={lang}
      id="receipt-paper"
    >
      {data.reversed && (
        <div className="receipt-watermark" aria-hidden>
          {L.reversed_note}
        </div>
      )}
      <header className="receipt-head">
        {data.school.has_logo && fmt === 'a5' && (
          <img src={logoSrc} alt="" className="receipt-logo" />
        )}
        <h1>{schoolName}</h1>
        {data.school.address && <div className="receipt-sub">{data.school.address}</div>}
        {data.school.phone && (
          <div className="receipt-sub">
            <N>{data.school.phone}</N>
          </div>
        )}
        <div className="receipt-title">{title}</div>
      </header>
      {data.reversed && <p className="receipt-banner">{L.reversed_note}</p>}
      <dl className="receipt-meta">
        <dt>{L.receipt_no}</dt>
        <dd>
          <N>{r.receipt_no}</N>
        </dd>
        <dt>{L.date}</dt>
        <dd>
          <N>{r.business_date}</N>
        </dd>
        <dt>{L.received_from}</dt>
        <dd>
          <bdi>{r.payer_name ?? ''}</bdi>
        </dd>
      </dl>
      {data.students.map((s) => (
        <table key={s.student_id} className="receipt-lines">
          <thead>
            {/* The child header is a td row, so it survives the thermal print (only the column
                labels below are hidden there). */}
            <tr className="receipt-child">
              <td colSpan={3}>
                <bdi>{s.student_name}</bdi>
                {!publicCopy && (
                  <>
                    {' '}
                    · {L.admission_no} <N>{s.admission_no}</N>
                  </>
                )}
              </td>
            </tr>
            <tr className="receipt-cols">
              <th>{L.month}</th>
              <th>{L.head}</th>
              <th className="end">{L.amount}</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.charge_id}>
                <td>
                  <N>{l.period_key}</N>
                </td>
                <td>
                  <bdi>{lang === 'ur' && l.head_name_ur ? l.head_name_ur : l.head_name}</bdi>
                </td>
                <td className="end">
                  <N>{money(l.amount)}</N>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      <table className="receipt-lines receipt-totals">
        <tbody>
          <tr className="total">
            <td>{L.total}</td>
            <td className="end">
              <N>{money(data.totals.amount)}</N>
            </td>
          </tr>
          <tr>
            <td>{L.allocated}</td>
            <td className="end">
              <N>{money(data.totals.allocated)}</N>
            </td>
          </tr>
          {data.totals.credit_added > 0 && (
            <tr>
              <td>{L.credit_added}</td>
              <td className="end">
                <N>{money(data.totals.credit_added)}</N>
              </td>
            </tr>
          )}
          <tr>
            <td>{L.balance_due}</td>
            <td className="end">
              <N>{money(data.totals.payer_due)}</N>
            </td>
          </tr>
          {data.totals.payer_credit > 0 && (
            <tr>
              <td>{L.advance}</td>
              <td className="end">
                <N>{money(data.totals.payer_credit)}</N>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <dl className="receipt-meta">
        <dt>{L.method}</dt>
        <dd>{L.methods[r.method]}</dd>
        {r.reference && (
          <>
            <dt>{L.reference}</dt>
            <dd>
              <N>{r.reference}</N>
            </dd>
          </>
        )}
        {!publicCopy && (
          <>
            <dt>{L.collector}</dt>
            <dd>
              <bdi>{r.collector_name ?? ''}</bdi>
            </dd>
          </>
        )}
      </dl>
      <footer className="receipt-foot">{L.signature}: ____________</footer>
    </article>
  );
}

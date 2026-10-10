import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { printWhenReady, ReceiptPage, shareMode, shareText } from '@/pages/fees/Receipt';
import { mockApi, renderAt } from './api-mock';
import { receiptId, receiptPrint } from './fee-fixtures';

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await act(() => setLanguage('en'));
});

function open(
  query: string,
  data = receiptPrint(),
  roles: Parameters<typeof renderAt>[3] = ['owner'],
) {
  const api = mockApi({
    [`GET /api/receipts/${receiptId}`]: data,
    [`POST /api/receipts/${receiptId}/notify`]: { message_id: 'M1', queued: true },
  });
  renderAt(`/receipts/${receiptId}${query}`, '/receipts/:id', <ReceiptPage />, roles);
  return api;
}

const paper = () =>
  waitFor(() => {
    const el = document.getElementById('receipt-paper');
    if (!el) throw new Error('no receipt yet');
    return el;
  });

describe('receipt view', () => {
  it('A5 in Urdu: rtl, Urdu labels, every number a Latin .num run', async () => {
    open('?fmt=a5&lang=ur');
    const p = await paper();
    expect(p.getAttribute('lang')).toBe('ur');
    expect(p.getAttribute('dir')).toBe('rtl');
    expect(p.dataset.fmt).toBe('a5');
    expect(p.classList.contains('receipt-a5')).toBe(true);
    expect(p.textContent).toContain('رسید نمبر');
    expect(p.textContent).toContain('کل وصولی');
    expect(p.textContent).toContain('جاز کیش');
    expect(p.textContent).toContain('ٹیوشن فیس');
    const nums = [...p.querySelectorAll('bdi.num')].map((n) => n.textContent);
    expect(nums).toContain('AN-2026-00001');
    expect(nums).toContain('PKR 7,000');
    expect(nums).toContain('2026-10-10');
    for (const n of p.querySelectorAll('bdi.num')) expect(n.textContent).not.toMatch(/[٠-٩۰-۹]/);
    expect(p.querySelector('.receipt-watermark')).toBeNull();
  });

  it('58 mm thermal in English: thermal class and a measured @page injected', async () => {
    open('?fmt=thermal&lang=en');
    const p = await paper();
    expect(p.dataset.fmt).toBe('thermal');
    expect(p.getAttribute('dir')).toBe('ltr');
    expect(p.textContent).toContain('Receipt no.');
    expect(p.textContent).toContain('Kept as advance');
    const style = document.querySelector('style[data-receipt-page="thermal"]');
    expect(style?.textContent).toMatch(
      /@page receipt-thermal \{ size: 58mm \d+mm; margin: 2mm; \}/,
    );
    // C2 (M4 fix pass): the whole document prints on the thermal page; anything left on the
    // default page (shell, toaster) forced a blank Letter/A4 second page in Chrome
    // (scripts/print-pages.mjs: 2 pages before, 1 after).
    expect(style?.textContent).toContain('@media print { html, body { page: receipt-thermal; } }');
  });

  it('58 mm: the child name / admission no. row is a td row that print does not hide', async () => {
    open('?fmt=thermal&lang=en');
    const p = await paper();
    const child = p.querySelector('tr.receipt-child');
    expect(child?.textContent).toContain('Ali');
    expect(child?.textContent).toContain('A-1');
    expect(child?.querySelector('th')).toBeNull();
    expect(child?.querySelector('td')?.getAttribute('colspan')).toBe('3');
    expect(child?.classList.contains('receipt-cols')).toBe(false);
    // Print CSS hides exactly the column-label row.
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
    const hidden = /\.receipt-thermal\s+([^{]+)\{\s*display:\s*none/.exec(css)?.[1]?.trim();
    expect(hidden).toBe('.receipt-cols');
    expect(p.querySelector(hidden as string)?.textContent).toContain('Amount');
    // The signature line is part of the thermal receipt (and not print-hidden).
    expect(p.querySelector('.receipt-foot')?.textContent).toContain('Signature');
    expect(css).not.toMatch(/\.receipt-foot[^{]*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.receipt \.num,[^{]*\{[^}]*white-space:\s*nowrap/);
  });

  it('58 mm: the page height is measured again when the language changes and after fonts load', async () => {
    let release: () => void = () => undefined;
    const ready = new Promise<void>((r) => {
      release = r;
    });
    Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true });
    const h = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400);
    open('?fmt=thermal&lang=en');
    await paper();
    const css = () => document.querySelector('style[data-receipt-page="thermal"]')?.textContent;
    expect(css()).toContain('size: 58mm 112mm');
    h.mockReturnValue(800);
    release();
    await waitFor(() => expect(css()).toContain('size: 58mm 218mm'));
    h.mockReturnValue(600);
    fireEvent.click(document.getElementById('receipt-lang-ur') as HTMLElement);
    await waitFor(() => expect(css()).toContain('size: 58mm 165mm'));
    expect(document.querySelectorAll('style[data-receipt-page="thermal"]')).toHaveLength(1);
  });

  it('defaults to the school language, and the paper toggles change only the receipt', async () => {
    open('');
    const p = await paper();
    expect(p.getAttribute('lang')).toBe('ur');
    expect(document.documentElement.dir).toBe('ltr');
    fireEvent.click(document.getElementById('receipt-lang-en') as HTMLElement);
    await waitFor(() =>
      expect(document.getElementById('receipt-paper')?.getAttribute('lang')).toBe('en'),
    );
    fireEvent.click(document.getElementById('receipt-fmt-thermal') as HTMLElement);
    await waitFor(() =>
      expect(document.getElementById('receipt-paper')?.dataset.fmt).toBe('thermal'),
    );
  });

  it('a reversed receipt shows a banner and a watermark, and no Reverse / Send', async () => {
    open(
      '?lang=ur',
      receiptPrint({ reversed: true, receipt: { ...receiptPrint().receipt, reversed_by: 'R2' } }),
    );
    const p = await paper();
    expect(p.querySelector('.receipt-watermark')?.textContent).toBe('یہ رسید منسوخ ہو چکی ہے');
    expect(p.querySelector('.receipt-banner')).toBeTruthy();
    expect(document.getElementById('receipt-reversed')?.textContent).toContain(
      'This receipt has been reversed',
    );
    expect(document.getElementById('receipt-reverse')).toBeNull();
    expect(document.getElementById('receipt-notify')).toBeNull();
  });

  it('Reverse is for owner/admin only; an accountant can print and send', async () => {
    open('?lang=en', receiptPrint(), ['accountant']);
    await paper();
    expect(document.getElementById('receipt-reverse')).toBeNull();
    expect(document.getElementById('receipt-print')).toBeTruthy();
    expect(document.getElementById('receipt-notify')).toBeTruthy();
  });

  it('Send payment-received → POST /notify → toast "queued"', async () => {
    const api = open('?lang=en');
    await paper();
    fireEvent.click(document.getElementById('receipt-notify') as HTMLElement);
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/notify'))).toBe(true),
    );
  });

  it('Print waits for fonts, then opens the print dialog', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    let release: () => void = () => undefined;
    const ready = new Promise<void>((r) => {
      release = r;
    });
    Object.defineProperty(document, 'fonts', { value: { ready }, configurable: true });
    const done = printWhenReady();
    await Promise.resolve();
    expect(print).not.toHaveBeenCalled();
    release();
    await done;
    expect(print).toHaveBeenCalledOnce();
  });
});

describe('share: text only (no file, no staff URL)', () => {
  it('no Web Share → copy the text; Web Share → the share sheet with text', () => {
    expect(shareMode({} as Navigator)).toBe('copy');
    expect(shareMode({ share: () => Promise.resolve() } as unknown as Navigator)).toBe('text');
  });
  it('the text has the school, receipt no., amount and date, and no link', () => {
    const text = shareText(receiptPrint(), (k, o) => `${k}|${JSON.stringify(o)}`);
    expect(text).toContain('Al-Noor');
    expect(text).toContain('AN-2026-00001');
    expect(text).toContain('PKR 7,000');
    expect(text).toContain('2026-10-10');
    expect(text).not.toMatch(/https?:|\/receipts\//);
  });
  it('the Share button calls navigator.share with text only', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share, onLine: true, language: 'en' });
    open('?lang=en');
    await paper();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(share).toHaveBeenCalledOnce());
    const arg = share.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(arg)).toEqual(['text']);
    expect(arg.text).toBe(
      'Al-Noor: receipt \u2068AN-2026-00001\u2069, \u2068PKR 7,000\u2069 received on \u20682026-10-10\u2069.',
    );
  });
});

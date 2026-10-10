import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n, setLanguage } from '@/i18n';
import { printWhenReady, ReceiptPage, shareMode } from '@/pages/fees/Receipt';
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

describe('share gating', () => {
  const file = new File(['x'], 'r.html', { type: 'text/html' });
  it('no Web Share → copy the text and link', () => {
    expect(shareMode({} as Navigator, file)).toBe('copy');
  });
  it('Web Share without file support → text + link', () => {
    expect(shareMode({ share: () => Promise.resolve() } as unknown as Navigator, file)).toBe(
      'text',
    );
    expect(
      shareMode(
        { share: () => Promise.resolve(), canShare: () => false } as unknown as Navigator,
        file,
      ),
    ).toBe('text');
  });
  it('canShare({files}) → the receipt file is attached', () => {
    expect(
      shareMode(
        { share: () => Promise.resolve(), canShare: () => true } as unknown as Navigator,
        file,
      ),
    ).toBe('files');
  });
  it('the Share button calls navigator.share with the receipt text and link', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share, onLine: true, language: 'en' });
    open('?lang=en');
    await paper();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(share).toHaveBeenCalledOnce());
    const arg = share.mock.calls[0]?.[0] as { text: string; url: string };
    expect(arg.url).toContain(`/receipts/${receiptId}`);
    expect(arg.text).toContain('AN-2026-00001');
  });
});

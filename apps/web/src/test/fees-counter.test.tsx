import { en, ur } from '@maktab/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrorNote } from '@/components/form';
import { initI18n, setLanguage } from '@/i18n';
import { ApiError } from '@/lib/api';
import {
  AttemptKey,
  FEE_ERROR_CODES,
  formatRupeeInput,
  openDuesInOrder,
  previewDirected,
  previewOldestFirst,
  rupeesToPaisa,
} from '@/lib/fees';
import { CounterPage } from '@/pages/fees/Counter';
import { type Call, mockApi, renderAt } from './api-mock';
import { accounts, bankAcc, fam, familyLines, familyStatement, receiptId } from './fee-fixtures';

const RS = (n: number) => n * 100;

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

describe('amounts: Rs ↔ paisa', () => {
  it('parses rupees with separators, paisa, and Urdu digits into integer paisa', () => {
    expect(rupeesToPaisa('5,700')).toBe(570000);
    expect(rupeesToPaisa('5700')).toBe(570000);
    expect(rupeesToPaisa('5700.5')).toBe(570050);
    expect(rupeesToPaisa('5700.05')).toBe(570005);
    expect(rupeesToPaisa('۵٬۷۰۰')).toBe(570000);
    expect(rupeesToPaisa('٥٧٠٠')).toBe(570000);
    expect(rupeesToPaisa('')).toBeNull();
    expect(rupeesToPaisa('abc')).toBeNull();
    expect(rupeesToPaisa('5.123')).toBeNull();
    expect(rupeesToPaisa('-5')).toBeNull();
  });

  it('shows typed amounts grouped by thousands in Latin digits, whatever the keyboard', () => {
    expect(formatRupeeInput('12500')).toBe('12,500');
    expect(formatRupeeInput('۱۲۵۰۰')).toBe('12,500');
    expect(formatRupeeInput('1250000.756')).toBe('1,250,000.75');
    expect(formatRupeeInput('007')).toBe('7');
    expect(formatRupeeInput('12a3')).toBe('123');
  });
});

describe('allocation preview matches the server (oldest first; due date, period, child, head, id)', () => {
  it('orders open roots like ledger openDues and splits like oldestFirst', () => {
    expect(openDuesInOrder(familyLines).map((l) => l.id)).toEqual([
      'C-ALI-09',
      'C-SARA-09',
      'C-ALI-10-ADM',
      'C-ALI-10-TUI',
      'C-SARA-10',
    ]);
    const p = previewOldestFirst(familyLines, RS(7000));
    expect(p.rows.map((r) => [r.line.id, r.amount])).toEqual([
      ['C-ALI-09', RS(2200)],
      ['C-SARA-09', RS(3150)],
      ['C-ALI-10-ADM', RS(1650)],
    ]);
    expect(p.credit).toBe(0);
    const total = openDuesInOrder(familyLines).reduce((a, l) => a + l.due, 0);
    expect(p.after).toBe(total - RS(7000));
    // More than everything owed: the rest is credit.
    const over = previewOldestFirst(familyLines, total + RS(100));
    expect(over.credit).toBe(RS(100));
    expect(over.after).toBe(0);
  });

  it('directed: only the chosen lines, capped at their due, the rest credit', () => {
    const p = previewDirected(familyLines, new Set(['C-SARA-10', 'C-ALI-09']), RS(4000));
    expect(p.rows.map((r) => [r.line.id, r.amount])).toEqual([
      ['C-ALI-09', RS(2200)],
      ['C-SARA-10', RS(1800)],
    ]);
    expect(previewDirected(familyLines, new Set(['C-ALI-09']), RS(4000)).credit).toBe(RS(1800));
  });

  it('one idempotency key per attempt; a changed attempt gets a new key', () => {
    const k = new AttemptKey();
    const a = k.for('sig-1');
    expect(k.for('sig-1')).toBe(a);
    const b = k.for('sig-2');
    expect(b).not.toBe(a);
    k.reset();
    expect(k.for('sig-2')).not.toBe(b);
  });
});

describe('every error code the fee screens can get has a sentence', () => {
  it.each(FEE_ERROR_CODES)('%s: en + ur, and ErrorNote shows it', async (code) => {
    const enText = (en.errors as Record<string, string>)[code];
    const urText = (ur.errors as Record<string, string>)[code];
    expect(enText?.length).toBeGreaterThan(3);
    expect(urText?.length).toBeGreaterThan(3);
    expect(urText).not.toMatch(/[A-Za-z]{4,}/);
    render(<ErrorNote error={new ApiError(409, code, 'server text')} />);
    expect(screen.getByRole('alert').textContent).toBe(enText);
  });

  it('includes every code PLAN "M3b must remember" lists', () => {
    for (const c of [
      'bad_business_date',
      'stale_dues',
      'idempotency_conflict',
      'account_required',
      'sponsorship_overlap',
      'already_void',
      'not_voidable',
      'session_closed',
      'reason_repeated',
    ])
      expect(FEE_ERROR_CODES).toContain(c);
  });
});

type Routes = Parameters<typeof mockApi>[0];

function setupCounter(extra: Routes = {}, roles: Parameters<typeof renderAt>[3] = ['owner']) {
  const api = mockApi({
    [`GET /api/fees/family/${fam}`]: familyStatement(),
    'GET /api/accounts': accounts,
    ...extra,
  });
  renderAt(`/fees/counter?family=${fam}`, '/fees/counter', <CounterPage />, roles);
  return api;
}

const posts = (calls: Call[]) =>
  calls
    .filter((c) => c.method === 'POST' && c.path === '/api/receipts')
    .map((c) => c.body as Record<string, unknown>);

const ok = () =>
  new Response(JSON.stringify({ receipt: { id: receiptId }, replayed: false }), { status: 201 });
const conflict = (code: string) =>
  new Response(JSON.stringify({ error: { code, message: code } }), { status: 409 });

/** The confirm dialog's "issue" button, once the dialog is open. */
const issueButton = () =>
  waitFor(() => {
    const el = document.getElementById('counter-issue');
    if (!el) throw new Error('confirm dialog not open');
    return el;
  });

async function typeAmount(text: string) {
  const input = await waitFor(() => {
    const el = document.getElementById('counter-amount');
    if (!el) throw new Error('no amount box yet');
    return el;
  });
  fireEvent.change(input, { target: { value: text } });
}

describe('fee counter', () => {
  it('shows the family: children, open lines, totals, and sponsor shares apart', async () => {
    setupCounter();
    const card = await screen.findByText('Raza family');
    expect(card).toBeTruthy();
    const totals = document.getElementById('payer-totals');
    expect(totals?.textContent).toContain('PKR 5');
    expect(document.getElementById('payer-net-due')?.textContent).toBe('PKR 16,000');
    const sponsor = document.getElementById('sponsor-shares');
    expect(sponsor?.textContent).toContain('does not owe');
    // The paid August line is not listed as a due.
    expect(document.querySelector('[data-line="C-ALI-08"]')).toBeNull();
  });

  it('previews the allocation and collects cash today with the dues hash; success opens the receipt', async () => {
    const api = setupCounter({ 'POST /api/receipts': () => ok() });
    await typeAmount('7000');
    const rows = await screen.findAllByText('PKR 1,650');
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Enter for yesterday')).toBeNull();
    expect(screen.getByText('Cash always goes into today’s drawer.')).toBeTruthy();
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    fireEvent.click(await issueButton());
    await waitFor(() => expect(posts(api.calls)).toHaveLength(1));
    const body = posts(api.calls)[0] ?? {};
    expect(body).toMatchObject({
      payer_type: 'family',
      payer_id: fam,
      amount: RS(7000),
      method: 'cash',
      expected_due_hash: 'hash-1',
    });
    expect(body.business_date).toBeUndefined();
    expect(body.account_id).toBeUndefined();
    expect(String(body.idempotency_key).length).toBeGreaterThanOrEqual(8);
  });

  it('non-cash needs an account before anything is sent', async () => {
    const api = setupCounter({ 'POST /api/receipts': () => ok() });
    await typeAmount('1000');
    fireEvent.click(document.getElementById('method-bank') as HTMLElement);
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    expect(await screen.findByText(en.errors.account_required)).toBeTruthy();
    expect(posts(api.calls)).toHaveLength(0);
    fireEvent.change(document.getElementById('counter-account') as HTMLElement, {
      target: { value: bankAcc },
    });
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    fireEvent.click(await issueButton());
    await waitFor(() => expect(posts(api.calls)).toHaveLength(1));
    expect(posts(api.calls)[0]).toMatchObject({ method: 'bank', account_id: bankAcc });
  });

  it('cash cannot be backdated; yesterday is offered to owner/admin for non-cash only, with a reason', async () => {
    const api = setupCounter({ 'POST /api/receipts': () => ok() });
    await typeAmount('1000');
    expect(document.getElementById('counter-yesterday')).toBeNull();
    fireEvent.click(document.getElementById('method-jazzcash') as HTMLElement);
    const box = document.getElementById('counter-yesterday') as HTMLInputElement;
    expect(box).toBeTruthy();
    fireEvent.click(box);
    fireEvent.change(document.getElementById('counter-account') as HTMLElement, {
      target: { value: '01JAAAAAAAAAAAAAAAAAAAAAK2' },
    });
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    expect(await screen.findByText(en.errors.backdate_reason_required)).toBeTruthy();
    fireEvent.change(document.getElementById('counter-backdate-reason') as HTMLElement, {
      target: { value: 'bank statement came late' },
    });
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    fireEvent.click(await issueButton());
    await waitFor(() => expect(posts(api.calls)).toHaveLength(1));
    const body = posts(api.calls)[0] ?? {};
    expect(body.backdate_reason).toBe('bank statement came late');
    expect(String(body.business_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('switching back to cash drops the yesterday option', async () => {
    setupCounter();
    await typeAmount('1000');
    fireEvent.click(document.getElementById('method-bank') as HTMLElement);
    fireEvent.click(document.getElementById('counter-yesterday') as HTMLElement);
    fireEvent.click(document.getElementById('method-cash') as HTMLElement);
    expect(document.getElementById('counter-yesterday')).toBeNull();
    expect(document.getElementById('counter-backdate-reason')).toBeNull();
  });

  it('an accountant never gets the yesterday option', async () => {
    setupCounter({}, ['accountant']);
    await typeAmount('1000');
    fireEvent.click(document.getElementById('method-bank') as HTMLElement);
    expect(document.getElementById('counter-yesterday')).toBeNull();
  });

  it('a retry after a network failure reuses the same idempotency key', async () => {
    let n = 0;
    const api = setupCounter({
      'POST /api/receipts': () => {
        n++;
        if (n === 1) throw new TypeError('Failed to fetch');
        return ok();
      },
    });
    await typeAmount('2,000');
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.network)).toBeTruthy();
    fireEvent.click(document.getElementById('counter-issue') as HTMLElement);
    await waitFor(() => expect(posts(api.calls)).toHaveLength(2));
    const [a, b] = posts(api.calls);
    expect(a?.idempotency_key).toBe(b?.idempotency_key);
  });

  it('409 stale_dues reloads the family, tells the collector, and the next attempt uses the new hash and a new key', async () => {
    let fetches = 0;
    let n = 0;
    const api = setupCounter({
      [`GET /api/fees/family/${fam}`]: () => {
        fetches++;
        return familyStatement({ dues_hash: fetches === 1 ? 'hash-1' : 'hash-2' });
      },
      'POST /api/receipts': () => {
        n++;
        return n === 1 ? conflict('stale_dues') : ok();
      },
    });
    await typeAmount('3000');
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.stale_dues)).toBeTruthy();
    await waitFor(() => expect(fetches).toBeGreaterThanOrEqual(2));
    // The amount the collector typed is kept.
    expect((document.getElementById('counter-amount') as HTMLInputElement).value).toBe('3,000');
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    fireEvent.click(await issueButton());
    await waitFor(() => expect(posts(api.calls)).toHaveLength(2));
    const [a, b] = posts(api.calls);
    expect(a?.expected_due_hash).toBe('hash-1');
    expect(b?.expected_due_hash).toBe('hash-2');
    expect(a?.idempotency_key).not.toBe(b?.idempotency_key);
  });

  it('idempotency_conflict: a fresh key on the next attempt', async () => {
    let n = 0;
    const api = setupCounter({
      'POST /api/receipts': () => {
        n++;
        return n === 1 ? conflict('idempotency_conflict') : ok();
      },
    });
    await typeAmount('500');
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.idempotency_conflict)).toBeTruthy();
    fireEvent.click(document.getElementById('counter-issue') as HTMLElement);
    await waitFor(() => expect(posts(api.calls)).toHaveLength(2));
    const [a, b] = posts(api.calls);
    expect(a?.idempotency_key).not.toBe(b?.idempotency_key);
  });

  it('directed: ticked lines are sent as `directed`, without the hash', async () => {
    const api = setupCounter({ 'POST /api/receipts': () => ok() });
    await typeAmount('2,200');
    fireEvent.click(document.getElementById('alloc-direct') as HTMLElement);
    fireEvent.click(document.getElementById('direct-C-SARA-10') as HTMLElement);
    const preview = document.getElementById('allocation-rows') as HTMLElement;
    expect(within(preview).getByText('PKR 2,200')).toBeTruthy();
    fireEvent.click(document.getElementById('counter-confirm') as HTMLElement);
    fireEvent.click(await issueButton());
    await waitFor(() => expect(posts(api.calls)).toHaveLength(1));
    const body = posts(api.calls)[0] ?? {};
    expect(body.directed).toEqual([{ charge_id: 'C-SARA-10', amount: RS(2200) }]);
    expect(body.expected_due_hash).toBeUndefined();
  });

  it('Urdu: dir=rtl, amounts stay Latin inside isolated runs', async () => {
    await act(() => setLanguage('ur'));
    setupCounter();
    await screen.findByText('Raza family');
    expect(document.documentElement.dir).toBe('rtl');
    const net = document.getElementById('payer-net-due');
    expect(net?.textContent).toBe('PKR 16,000');
    expect(net?.querySelector('bdi.num')).toBeTruthy();
    await typeAmount('۵۰۰۰');
    expect((document.getElementById('counter-amount') as HTMLInputElement).value).toBe('5,000');
  });
});

import { en, ur } from '@maktab/shared';
import { focusManager } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrorNote } from '@/components/form';
import { toast } from '@/components/ui/sonner';
import { initI18n, setLanguage } from '@/i18n';
import { ApiError } from '@/lib/api';
import {
  balanceAfter,
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
  vi.restoreAllMocks();
  sessionStorage.clear();
  focusManager.setFocused(undefined);
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

  it('decimal marks: "٫" and a single "," are decimals; bad grouping, >2 decimals, >9 digits fail', () => {
    expect(rupeesToPaisa('12٫50')).toBe(1250);
    expect(rupeesToPaisa('۱۲٫۵')).toBe(1250);
    expect(rupeesToPaisa('12,50')).toBe(1250);
    expect(rupeesToPaisa('12,5')).toBe(1250);
    expect(rupeesToPaisa('1,250')).toBe(125000);
    expect(rupeesToPaisa('1,250,000.75')).toBe(125000075);
    expect(rupeesToPaisa('1,2,3')).toBeNull();
    expect(rupeesToPaisa('12,5000')).toBeNull();
    expect(rupeesToPaisa('12,505')).toBe(1250500);
    expect(rupeesToPaisa('12٫505')).toBeNull();
    expect(rupeesToPaisa('12,50.5')).toBeNull();
    expect(rupeesToPaisa('999999999')).toBe(99999999900);
    expect(rupeesToPaisa('1000000000')).toBeNull();
    expect(rupeesToPaisa('1,000,000,000')).toBeNull();
  });

  it('the amount box keeps a typed "٫" or trailing "," as the decimal point', () => {
    expect(formatRupeeInput('12٫5')).toBe('12.5');
    expect(formatRupeeInput('1250,')).toBe('1,250.');
    expect(formatRupeeInput('1,250.')).toBe('1,250.');
    expect(formatRupeeInput('1,2500')).toBe('12,500');
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

  it('balance after is credit-aware: max(0, after − (existing credit + new credit))', () => {
    const total = openDuesInOrder(familyLines).reduce((a, l) => a + l.due, 0);
    const p = previewOldestFirst(familyLines, RS(7000));
    expect(balanceAfter(p, RS(500))).toBe(total - RS(7000) - RS(500));
    // Directed: the ticked line is paid, the rest becomes credit that also offsets what is left.
    const d = previewDirected(familyLines, new Set(['C-ALI-09']), RS(4000));
    expect(d.credit).toBe(RS(1800));
    expect(balanceAfter(d, RS(500))).toBe(total - RS(2200) - RS(500) - RS(1800));
    expect(balanceAfter(previewOldestFirst(familyLines, total), RS(500))).toBe(0);
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

const click = (id: string) => fireEvent.click(document.getElementById(id) as HTMLElement);
const familyGets = (calls: Call[]) =>
  calls.filter((c) => c.method === 'GET' && c.path === `/api/fees/family/${fam}`).length;
/** react-query's window-focus refetch: the family view reloads (as after switching apps). */
const refocus = () =>
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
const replayed = () =>
  new Response(JSON.stringify({ receipt: { id: receiptId }, replayed: true }), { status: 200 });

describe('counter idempotency: one key per attempt, independent of the dues hash', () => {
  it('network error → family refetch (new hash) → retry sends the same key and body; the replay returns the original receipt', async () => {
    const info = vi.spyOn(toast, 'info');
    let fetches = 0;
    let n = 0;
    const keys = new Set<unknown>();
    const api = setupCounter({
      [`GET /api/fees/family/${fam}`]: () => {
        fetches++;
        // The first POST did commit: the dues (and the hash) changed under the collector.
        return familyStatement({ dues_hash: fetches === 1 ? 'hash-1' : 'hash-2' });
      },
      'POST /api/receipts': (_u: URL, init: RequestInit) => {
        n++;
        const body = JSON.parse(String(init.body)) as { idempotency_key: string };
        if (n === 1) {
          keys.add(body.idempotency_key);
          throw new TypeError('Failed to fetch');
        }
        return keys.has(body.idempotency_key) ? replayed() : ok();
      },
    });
    await typeAmount('7,000');
    click('counter-confirm');
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.network)).toBeTruthy();
    // The attempt is pending: banner shown, inputs locked.
    expect(document.getElementById('counter-pending')).toBeTruthy();
    expect(document.getElementById('counter-amount')?.matches(':disabled')).toBe(true);
    await refocus();
    await waitFor(() => expect(fetches).toBeGreaterThanOrEqual(2));
    click('counter-retry');
    await waitFor(() => expect(posts(api.calls)).toHaveLength(2));
    const [a, b] = posts(api.calls);
    expect(b?.idempotency_key).toBe(a?.idempotency_key);
    expect(b).toEqual(a);
    expect(b?.expected_due_hash).toBe('hash-1');
    await waitFor(() => expect(info).toHaveBeenCalledWith(en.fee.counter.replayed));
    await waitFor(() => expect(sessionStorage.length).toBe(0));
  });

  it('back online: the pending attempt is replayed (same key) before the family reloads', async () => {
    let n = 0;
    const api = setupCounter({
      'POST /api/receipts': () => {
        n++;
        if (n === 1) throw new TypeError('Failed to fetch');
        return replayed();
      },
    });
    await typeAmount('2,000');
    click('counter-confirm');
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.network)).toBeTruthy();
    const getsBefore = familyGets(api.calls);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(posts(api.calls)).toHaveLength(2));
    const [a, b] = posts(api.calls);
    expect(b?.idempotency_key).toBe(a?.idempotency_key);
    const order = api.calls.slice(
      api.calls.indexOf(api.calls.filter((c) => c.method === 'POST')[0] as Call) + 1,
    );
    const firstPost = order.findIndex((c) => c.method === 'POST');
    const firstFamily = order.findIndex(
      (c) => c.method === 'GET' && c.path === `/api/fees/family/${fam}`,
    );
    expect(firstPost).toBeGreaterThanOrEqual(0);
    if (firstFamily >= 0) expect(firstPost).toBeLessThan(firstFamily);
    expect(familyGets(api.calls)).toBeGreaterThanOrEqual(getsBefore);
  });

  it('the pending attempt survives a reload of the page (same key from session storage)', async () => {
    let n = 0;
    const api = setupCounter({
      'POST /api/receipts': () => {
        n++;
        if (n === 1) throw new TypeError('Failed to fetch');
        return replayed();
      },
    });
    await typeAmount('1,500');
    click('counter-confirm');
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.network)).toBeTruthy();
    const first = posts(api.calls)[0];
    // A fresh mount (page reload) restores the locked attempt.
    cleanup();
    const again = setupCounter({ 'POST /api/receipts': () => replayed() });
    await waitFor(() => expect(document.getElementById('counter-pending')).toBeTruthy());
    expect((document.getElementById('counter-amount') as HTMLInputElement).value).toBe('1,500');
    click('counter-retry');
    await waitFor(() => expect(posts(again.calls)).toHaveLength(1));
    expect(posts(again.calls)[0]?.idempotency_key).toBe(first?.idempotency_key);
  });

  it('stale_dues: the attempt ends; no new key is sent until the collector confirms again', async () => {
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
    click('counter-confirm');
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.stale_dues)).toBeTruthy();
    await waitFor(() => expect(fetches).toBeGreaterThanOrEqual(2));
    // Nothing is retried on its own, and nothing is locked.
    expect(posts(api.calls)).toHaveLength(1);
    expect(document.getElementById('counter-pending')).toBeNull();
    expect(document.getElementById('counter-retry')).toBeNull();
    expect(sessionStorage.length).toBe(0);
    click('counter-confirm');
    fireEvent.click(await issueButton());
    await waitFor(() => expect(posts(api.calls)).toHaveLength(2));
    const [a, b] = posts(api.calls);
    expect(b?.idempotency_key).not.toBe(a?.idempotency_key);
    expect(b?.expected_due_hash).toBe('hash-2');
  });

  it('Start over unlocks the form and the next attempt gets a new key', async () => {
    let n = 0;
    const api = setupCounter({
      'POST /api/receipts': () => {
        n++;
        if (n === 1) throw new TypeError('Failed to fetch');
        return ok();
      },
    });
    await typeAmount('1000');
    click('counter-confirm');
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.network)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    click('counter-start-over');
    expect(document.getElementById('counter-pending')).toBeNull();
    expect(document.getElementById('counter-amount')?.matches(':disabled')).toBe(false);
    await typeAmount('1200');
    click('counter-confirm');
    fireEvent.click(await issueButton());
    await waitFor(() => expect(posts(api.calls)).toHaveLength(2));
    const [a, b] = posts(api.calls);
    expect(b?.idempotency_key).not.toBe(a?.idempotency_key);
    expect(b?.amount).toBe(RS(1200));
  });

  it('a definite refusal (400) ends the attempt: nothing stays locked', async () => {
    setupCounter({
      'POST /api/receipts': () =>
        new Response(JSON.stringify({ error: { code: 'bad_business_date', message: 'x' } }), {
          status: 400,
        }),
    });
    await typeAmount('1000');
    click('counter-confirm');
    fireEvent.click(await issueButton());
    expect(await screen.findByText(en.errors.bad_business_date)).toBeTruthy();
    expect(document.getElementById('counter-pending')).toBeNull();
  });
});

describe('counter: choose lines, confirm details, warnings, fines', () => {
  it('"Choose lines" with nothing ticked: Confirm disabled with a hint; a tick enables it', async () => {
    setupCounter();
    await typeAmount('2,000');
    click('alloc-direct');
    const confirm = document.getElementById('counter-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(document.getElementById('alloc-direct-empty')?.textContent).toBe(
      en.fee.counter.directEmpty,
    );
    click('direct-C-ALI-09');
    expect(confirm.disabled).toBe(false);
    expect(document.getElementById('alloc-direct-empty')).toBeNull();
  });

  it('after a reload, ticks on lines no longer due are dropped; none left → oldest first', async () => {
    let fetches = 0;
    setupCounter({
      [`GET /api/fees/family/${fam}`]: () => {
        fetches++;
        return fetches === 1
          ? familyStatement()
          : familyStatement({
              charges: familyLines.map((l) =>
                l.id === 'C-SARA-10' ? { ...l, paid: l.net, due: 0, status: 'paid' as const } : l,
              ),
              dues_hash: 'hash-2',
            });
      },
    });
    await typeAmount('2,000');
    click('alloc-direct');
    click('direct-C-SARA-10');
    await refocus();
    await waitFor(() =>
      expect(document.getElementById('alloc-oldest')?.getAttribute('aria-pressed')).toBe('true'),
    );
    expect(document.getElementById('alloc-direct-empty')).toBeNull();
    expect((document.getElementById('counter-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('confirm lists child · period · head · amount, the account, the date and the credit remainder', async () => {
    setupCounter({ 'POST /api/receipts': () => ok() });
    await typeAmount('7,000');
    click('method-bank');
    fireEvent.change(document.getElementById('counter-account') as HTMLElement, {
      target: { value: bankAcc },
    });
    click('counter-confirm');
    await issueButton();
    const rows = [...document.querySelectorAll('[data-confirm-row]')].map((r) => r.textContent);
    expect(rows).toEqual([
      'Ali·2026-09·TuitionPKR 2,200',
      'Sara·2026-09·TuitionPKR 3,150',
      'Ali·2026-10·AdmissionPKR 1,650',
    ]);
    expect(document.getElementById('confirm-account')?.textContent).toBe('HBL current');
    expect(document.getElementById('confirm-date')?.textContent).toContain('(Today)');
    expect(document.getElementById('confirm-credit')?.textContent).toBe('PKR 0');
    // 16,500 open − 7,000 − 500 advance.
    expect(document.getElementById('confirm-after')?.textContent).toBe('PKR 9,000');
    expect(document.getElementById('confirm-yesterday')).toBeNull();
  });

  it('a yesterday receipt is flagged prominently in the confirm dialog', async () => {
    setupCounter();
    await typeAmount('1,000');
    click('method-bank');
    fireEvent.change(document.getElementById('counter-account') as HTMLElement, {
      target: { value: bankAcc },
    });
    click('counter-yesterday');
    fireEvent.change(document.getElementById('counter-backdate-reason') as HTMLElement, {
      target: { value: 'statement late' },
    });
    click('counter-confirm');
    await issueButton();
    const warn = document.getElementById('confirm-yesterday');
    expect(warn?.getAttribute('role')).toBe('alert');
    expect(warn?.textContent).toContain('YESTERDAY');
  });

  it('more than 3× the net due warns but does not block; the preview balance is credit-aware', async () => {
    const api = setupCounter({ 'POST /api/receipts': () => ok() });
    await typeAmount('7,000');
    expect(document.getElementById('counter-amount-high')).toBeNull();
    expect(document.getElementById('allocation-after')?.textContent).toContain('PKR 9,000');
    await typeAmount('48,001');
    expect(document.getElementById('counter-amount-high')?.textContent).toContain('PKR 16,000');
    click('counter-confirm');
    fireEvent.click(await issueButton());
    await waitFor(() => expect(posts(api.calls)).toHaveLength(1));
  });

  it('a fined line offers "Waive fine" to owner/admin → reason → POST /fines/:id/waive', async () => {
    const api = setupCounter({ 'POST /api/fees/fines/F-ALI-09/waive': { waiver_id: 'W1' } });
    await screen.findByText('Raza family');
    click('waive-F-ALI-09');
    fireEvent.change(document.getElementById('waive-reason') as HTMLElement, {
      target: { value: 'first time' },
    });
    click('waive-confirm');
    await waitFor(() =>
      expect(
        api.calls.find((c) => c.method === 'POST' && c.path === '/api/fees/fines/F-ALI-09/waive')
          ?.body,
      ).toEqual({ reason: 'first time' }),
    );
  });

  it('an accountant sees no Waive; a waived fine shows its waived state', async () => {
    setupCounter(
      {
        [`GET /api/fees/family/${fam}`]: familyStatement({
          fines: [
            {
              id: 'F-ALI-09',
              root_id: 'C-ALI-09',
              student_id: 'x',
              period_key: '2026-09',
              amount: RS(200),
              waived: RS(200),
              left: 0,
            },
          ],
        }),
      },
      ['accountant'],
    );
    await screen.findByText('Raza family');
    expect(document.getElementById('waive-F-ALI-09')).toBeNull();
    expect(document.querySelector('[data-waived="F-ALI-09"]')?.textContent).toBe('Fine waived');
  });
});

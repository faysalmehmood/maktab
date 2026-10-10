import type { GenerateResultDto } from '@maktab/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BillingAlertBanner, FeeTiles } from '@/components/fees/DashboardTiles';
import { FeeSetup, rateHistory, validateFineRule } from '@/components/fees/setup';
import { initI18n, setLanguage } from '@/i18n';
import { BillingPage, runGenerate } from '@/pages/fees/Billing';
import { DefaultersPage } from '@/pages/fees/Defaulters';
import { group, mockApi, renderAt } from './api-mock';
import { fam, feeSettings } from './fee-fixtures';

const RS = (n: number) => n * 100;

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

const G1 = '01JAAAAAAAAAAAAAAAAAAAAAG1';
const G2 = '01JAAAAAAAAAAAAAAAAAAAAAG2';
const G3 = '01JAAAAAAAAAAAAAAAAAAAAAG3';
const counts = (fees: number) => ({ fees, concessions: 0, sponsored: 0, allocations: 0 });
function chunk(p: Partial<GenerateResultDto>): GenerateResultDto {
  return {
    period: '2026-10',
    grp_id: G1,
    dry_run: false,
    planned: [],
    counts: counts(0),
    group_done: true,
    next: null,
    done: true,
    failed: null,
    ...p,
  };
}

/** G1 in two chunks, G2 fails (server already points at G3), G3 last. */
const script: GenerateResultDto[] = [
  chunk({
    grp_id: G1,
    counts: counts(200),
    group_done: false,
    next: { grp_id: G1, after_student_id: 'S200' },
    done: false,
  }),
  chunk({
    grp_id: G1,
    counts: counts(20),
    next: { grp_id: G2, after_student_id: null },
    done: false,
  }),
  chunk({
    grp_id: G2,
    group_done: false,
    failed: { grp_id: G2, code: 'db_error', message: 'boom' },
    next: { grp_id: G3, after_student_id: null },
    done: false,
  }),
  chunk({ grp_id: G3, counts: counts(30) }),
];

describe('billing', () => {
  it('runGenerate follows `next` until null, sums counts per group, and surfaces `failed`', async () => {
    const bodies: Record<string, unknown>[] = [];
    let i = 0;
    const s = await runGenerate(
      async (b) => {
        bodies.push(b);
        return script[i++] as GenerateResultDto;
      },
      { period: '2026-10', dryRun: false },
    );
    expect(s.requests).toBe(4);
    expect(bodies.map((b) => [b.grp_id ?? null, b.after_student_id ?? null])).toEqual([
      [null, null],
      [G1, 'S200'],
      [G2, null],
      [G3, null],
    ]);
    expect(s.byGroup.get(G1)?.fees).toBe(220);
    expect(s.totals.fees).toBe(250);
    expect(s.failed).toEqual([{ grp_id: G2, code: 'db_error', message: 'boom' }]);
  });

  it('the Generate button loops, shows the failed group, and the runs show attention', async () => {
    let i = 0;
    mockApi({
      'GET /api/groups': { items: [{ ...group, id: G2, name: 'B' }] },
      'GET /api/fees/runs': {
        period: '2026-10',
        complete: false,
        cursor: null,
        failing: [
          {
            grp_id: G2,
            fail_streak: 3,
            error_code: 'db_error',
            retry_after: null,
            attention_required: true,
          },
        ],
        attention_required: 1,
        chunks: [],
      },
      'POST /api/fees/generate': () => script[i++],
    });
    renderAt('/fees/billing', '/fees/billing', <BillingPage />);
    expect(await screen.findByText(/1 groups have failed three times/)).toBeTruthy();
    fireEvent.click(document.getElementById('billing-generate') as HTMLElement);
    const failed = await waitFor(() => {
      const el = document.getElementById('billing-failed');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(failed.textContent).toContain('Class 5 B');
    expect(failed.textContent).toContain('db_error');
    expect(i).toBe(4);
    expect(document.getElementById('billing-result')?.textContent).toContain('250 fees');
  });

  it('dashboard: the billing banner appears only with alerts and links to billing', async () => {
    mockApi({
      'GET /api/dashboard/fees': {
        date: '2026-10-10',
        collected: [{ method: 'cash', amount: RS(7000), count: 2 }],
        collected_total: RS(7000),
        dues_outstanding: RS(50000),
        defaulters: 4,
        billing_alerts: 2,
        queued_fee_messages: 3,
      },
    });
    renderAt('/', '/', <FeeTiles />);
    const banner = await waitFor(() => {
      const el = document.getElementById('billing-alert-banner');
      if (!el) throw new Error('no banner');
      return el;
    });
    expect(banner.querySelector('a')?.getAttribute('href')).toBe('/fees/billing');
    expect(document.getElementById('tile-collected')?.textContent).toContain('PKR 7,000');
    expect(document.getElementById('tile-defaulters')?.textContent).toContain('4');
  });

  it('no banner without alerts', () => {
    renderAt('/', '/', <BillingAlertBanner count={0} />);
    expect(document.getElementById('billing-alert-banner')).toBeNull();
  });
});

const fullRows = {
  summary_only: false,
  total_overdue: RS(5000),
  defaulters: [
    {
      student_id: 'S1',
      student_name: 'Ali',
      admission_no: 'A-1',
      family_id: fam,
      family_name: 'Raza',
      grp_id: G1,
      group: 'Class 5 A',
      months_overdue: 2,
      overdue: RS(5000),
      due: RS(8000),
      oldest_period: '2026-08',
      sponsored: false,
      guardian_name: 'Raza',
      guardian_phone: '923001234567',
    },
  ],
};

describe('defaulters', () => {
  it('office: net due and the guardian phone; Remind all shows the queued count and cooldown', async () => {
    const api = mockApi({
      'GET /api/groups': { items: [] },
      'GET /api/school/fees': feeSettings,
      'GET /api/fees/defaulters': fullRows,
      'POST /api/fees/defaulters/remind': { queued: 1, more: false },
    });
    renderAt('/fees/defaulters', '/fees/defaulters', <DefaultersPage />);
    expect(await screen.findByText('0300 1234567')).toBeTruthy();
    expect(screen.getByText('PKR 8,000')).toBeTruthy();
    expect(document.getElementById('remind-cooldown')?.textContent).toContain('7 days');
    fireEvent.click(document.getElementById('remind-all') as HTMLElement);
    expect(await screen.findByText('1 families queued in the send queue')).toBeTruthy();
    const remind = api.calls.find((c) => c.path === '/api/fees/defaulters/remind');
    expect(remind?.body).toMatchObject({ template: 'fee_overdue' });
  });

  it('teacher: summary only — no phones, no due column, no amount filter', async () => {
    mockApi({
      'GET /api/groups': { items: [] },
      'GET /api/school/fees': feeSettings,
      'GET /api/fees/defaulters': {
        summary_only: true,
        defaulters: [
          {
            student_id: 'S1',
            student_name: 'Ali',
            admission_no: 'A-1',
            grp_id: G1,
            group: 'Class 5 A',
            months_overdue: 2,
            overdue: RS(5000),
          },
        ],
      },
    });
    renderAt('/fees/defaulters', '/fees/defaulters', <DefaultersPage />, ['teacher']);
    expect(
      await screen.findByText('Your groups only. Payments and phone numbers are with the office.'),
    ).toBeTruthy();
    const table = document.getElementById('defaulters-table') as HTMLElement;
    expect(table.textContent).not.toContain('Phone');
    expect(table.textContent).not.toMatch(/\bDue\b/);
    expect(table.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.getElementById('def-amount')).toBeNull();
  });
});

const rates = [
  {
    id: 'R1',
    fee_head_id: 'H1',
    programme_id: 'P1',
    grp_id: null,
    amount: RS(2500),
    effective_from: '2025-04-01',
    created_at: '2025-03-01',
  },
  {
    id: 'R2',
    fee_head_id: 'H1',
    programme_id: 'P1',
    grp_id: null,
    amount: RS(3000),
    effective_from: '2026-04-01',
    created_at: '2026-03-01',
  },
  {
    id: 'R3',
    fee_head_id: 'H1',
    programme_id: 'P1',
    grp_id: null,
    amount: RS(3500),
    effective_from: '2027-04-01',
    created_at: '2026-09-01',
  },
];

describe('fee setup', () => {
  it('rate history: newest first, the current one marked, a future one not current', () => {
    const [g] = rateHistory(rates, '2026-10-10');
    expect(g?.rates.map((r) => r.id)).toEqual(['R3', 'R2', 'R1']);
    expect(g?.current?.id).toBe('R2');
  });

  it('rates are append-only on screen: history rows have no edit controls; adding posts a new row', async () => {
    const api = mockApi({
      'GET /api/fees/heads': {
        heads: [
          {
            id: 'H1',
            name: 'Tuition',
            name_ur: null,
            kind: 'tuition',
            cadence: 'monthly',
            archived: false,
          },
        ],
      },
      'GET /api/fees/rates': { rates },
      'GET /api/programmes': { items: [{ id: 'P1', name: 'Class 5' }] },
      'GET /api/groups': { items: [] },
      'GET /api/school/fees': feeSettings,
      'GET /api/accounts': { accounts: [] },
      'GET /api/staff': { items: [] },
      'POST /api/fees/rates': { rate: rates[1] },
    });
    renderAt('/settings', '/settings', <FeeSetup />);
    const table = await waitFor(() => {
      const el = document.getElementById('rate-history');
      if (!el) throw new Error('no history');
      return el;
    });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(table.querySelectorAll('input, button, select, textarea')).toHaveLength(0);
    expect(table.textContent).toContain('Current');
    expect(screen.getByText(/A rate is never edited/)).toBeTruthy();
    fireEvent.change(document.getElementById('rate-head') as HTMLElement, {
      target: { value: 'H1' },
    });
    fireEvent.change(document.getElementById('rate-target') as HTMLElement, {
      target: { value: 'P1' },
    });
    fireEvent.change(document.getElementById('rate-amount') as HTMLElement, {
      target: { value: '4,000' },
    });
    fireEvent.click(document.getElementById('rate-add') as HTMLElement);
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'POST' && c.path === '/api/fees/rates')).toBe(true),
    );
    const post = api.calls.find((c) => c.method === 'POST' && c.path === '/api/fees/rates');
    expect(post?.body).toMatchObject({ fee_head_id: 'H1', programme_id: 'P1', amount: RS(4000) });
    expect(
      api.calls.some((c) => ['PUT', 'PATCH'].includes(c.method) && c.path.includes('/rates')),
    ).toBe(false);
    // The receipt prefix is shown locked once receipts exist.
    expect(document.getElementById('receipt-prefix')?.textContent).toContain('Locked');
  });

  it('fine rule validation', () => {
    const base = { enabled: true, grace_day: '15', type: 'fixed' as const, value: '200', cap: '' };
    expect(validateFineRule(base)).toEqual({
      errors: {},
      rule: { enabled: true, grace_day: 15, type: 'fixed', value: RS(200), cap: null },
    });
    expect(validateFineRule({ ...base, value: '' }).errors.value).toBe('fine_value_required');
    expect(validateFineRule({ ...base, value: 'x' }).errors.value).toBe('amount_invalid');
    expect(validateFineRule({ ...base, type: 'pct', value: '150' }).errors.value).toBe(
      'fine_value_pct',
    );
    expect(validateFineRule({ ...base, type: 'pct', value: '5' }).rule).toMatchObject({
      type: 'pct',
      value: 5,
    });
    expect(validateFineRule({ ...base, grace_day: '31' }).errors.grace_day).toBe('invalid');
    expect(validateFineRule({ ...base, grace_day: '0' }).errors.grace_day).toBe('invalid');
    expect(validateFineRule({ ...base, cap: '1,000' }).rule?.cap).toBe(RS(1000));
    expect(validateFineRule({ ...base, cap: 'abc' }).errors.cap).toBe('amount_invalid');
    // Off: nothing to validate, no rule.
    expect(validateFineRule({ ...base, enabled: false, value: '' })).toEqual({
      errors: {},
      rule: null,
    });
  });
});

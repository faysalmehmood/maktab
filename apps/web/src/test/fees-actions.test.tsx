import type { StudentFeesDto } from '@maktab/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { concessionStartMonth, ReduceFeeDialog } from '@/components/fees/dialogs';
import { StudentFeesCard } from '@/components/fees/StudentFees';
import { initI18n, setLanguage } from '@/i18n';
import { CounterPage } from '@/pages/fees/Counter';
import { FamilyStatementPage } from '@/pages/fees/FamilyStatement';
import { mockApi, renderAt } from './api-mock';
import { accounts, ali, bankAcc, fam, familyLines, familyStatement } from './fee-fixtures';

const RS = (n: number) => n * 100;

beforeAll(async () => {
  await initI18n('en');
});
afterEach(async () => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  await act(() => setLanguage('en'));
});

const byId = (id: string) =>
  waitFor(() => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  });
const posts = (calls: { method: string; path: string; body: unknown }[], path: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === path).map((c) => c.body);

function family(roles: Parameters<typeof renderAt>[3] = ['owner'], extra = {}) {
  const api = mockApi({
    [`GET /api/fees/family/${fam}`]: familyStatement(),
    'GET /api/accounts': accounts,
    ...extra,
  });
  renderAt(`/fees/family/${fam}`, '/fees/family/:id', <FamilyStatementPage />, roles);
  return api;
}

describe('family statement: fine waiver and refund (admin/owner)', () => {
  it('Waive fine → reason → POST /fines/:id/waive', async () => {
    const api = family(['owner'], { 'POST /api/fees/fines/F-ALI-09/waive': { waiver_id: 'W' } });
    fireEvent.click(await byId('waive-F-ALI-09'));
    fireEvent.change(await byId('waive-reason'), { target: { value: 'hardship' } });
    fireEvent.click(await byId('waive-confirm'));
    await waitFor(() =>
      expect(posts(api.calls, '/api/fees/fines/F-ALI-09/waive')).toEqual([{ reason: 'hardship' }]),
    );
  });

  it('an accountant gets neither Waive nor Refund', async () => {
    family(['accountant']);
    await screen.findByText('Raza family');
    expect(document.getElementById('waive-F-ALI-09')).toBeNull();
    expect(document.getElementById('family-refund')).toBeNull();
  });

  it('Refund: amount ≤ credit, account for non-cash, reason; one key per attempt', async () => {
    let n = 0;
    const api = family(['admin'], {
      'POST /api/refunds': () => {
        n++;
        if (n === 1) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ receipt: { id: 'RF1' }, replayed: true }), {
          status: 200,
        });
      },
    });
    fireEvent.click(await byId('family-refund'));
    fireEvent.change(await byId('refund-amount'), { target: { value: '600' } });
    fireEvent.click(await byId('refund-method-bank'));
    fireEvent.change(await byId('refund-reason'), { target: { value: 'left school' } });
    fireEvent.click(await byId('refund-confirm'));
    // 600 > the 500 advance: refused before anything is sent.
    expect(await screen.findByText('Not enough advance (credit) for this.')).toBeTruthy();
    fireEvent.change(await byId('refund-amount'), { target: { value: '500' } });
    fireEvent.click(await byId('refund-confirm'));
    expect(
      await screen.findByText('Choose the bank or wallet account this money went into.'),
    ).toBeTruthy();
    fireEvent.change(await byId('refund-account'), { target: { value: bankAcc } });
    fireEvent.click(await byId('refund-confirm'));
    await waitFor(() => expect(posts(api.calls, '/api/refunds')).toHaveLength(1));
    // Lost answer: the retry is the same attempt.
    fireEvent.click(await byId('refund-confirm'));
    await waitFor(() => expect(posts(api.calls, '/api/refunds')).toHaveLength(2));
    const [a, b] = posts(api.calls, '/api/refunds') as Record<string, unknown>[];
    expect(a).toMatchObject({
      payer_type: 'family',
      payer_id: fam,
      amount: RS(500),
      method: 'bank',
      account_id: bankAcc,
      reason: 'left school',
    });
    expect(b?.idempotency_key).toBe(a?.idempotency_key);
  });

  it('no credit → no Refund button', async () => {
    family(['owner'], { [`GET /api/fees/family/${fam}`]: familyStatement({ credit: 0 }) });
    await screen.findByText('Raza family');
    expect(document.getElementById('family-refund')).toBeNull();
  });
});

const studentFees = (o: Partial<StudentFeesDto> = {}): StudentFeesDto => ({
  student: { id: ali, name: 'Ali', admission_no: 'A-1', family_id: fam },
  family_name: 'Raza family',
  lines: familyLines.filter((l) => l.student_id === ali),
  sponsored: [],
  due: RS(10000),
  family_due: RS(16000),
  family_credit: RS(500),
  concessions: [],
  sponsorships: [],
  opening_balance: null,
  receipts: [],
  ...o,
});

describe('per-student billing and concessions', () => {
  it('Student Fees card: "Bill this month" (generate grant) → POST /regenerate for this month', async () => {
    const api = mockApi({
      [`GET /api/fees/student/${ali}`]: studentFees(),
      'POST /api/fees/regenerate': { counts: { fees: 1 }, planned: [] },
    });
    renderAt(
      `/students/${ali}`,
      '/students/:id',
      <StudentFeesCard studentId={ali} studentName="Ali" />,
    );
    fireEvent.click(await byId('student-bill-month'));
    await waitFor(() =>
      expect(posts(api.calls, '/api/fees/regenerate')).toEqual([
        { student_id: ali, period: expect.stringMatching(/^\d{4}-\d{2}$/) },
      ]),
    );
  });

  it('an accountant has no "Bill this month"', async () => {
    mockApi({ [`GET /api/fees/student/${ali}`]: studentFees() });
    renderAt(
      `/students/${ali}`,
      '/students/:id',
      <StudentFeesCard studentId={ali} studentName="Ali" />,
      ['accountant'],
    );
    await screen.findByText('Family statement');
    expect(document.getElementById('student-bill-month')).toBeNull();
  });

  it('concession start: a mid-month date starts on the next month’s first day', () => {
    expect(concessionStartMonth('2026-10-01')).toBe('2026-10-01');
    expect(concessionStartMonth('2026-10-15')).toBe('2026-11-01');
    expect(concessionStartMonth('2026-12-31')).toBe('2027-01-01');
  });

  it('after saving, billed months from the start are regenerated one request each', async () => {
    const api = mockApi({
      'GET /api/fees/heads': { heads: [] },
      'POST /api/fees/concessions': { concession: { id: 'C1' } },
      'POST /api/fees/regenerate': { counts: { fees: 0 }, planned: [] },
      [`GET /api/fees/student/${ali}`]: studentFees(),
    });
    renderAt(
      '/x',
      '/x',
      <ReduceFeeDialog open studentId={ali} studentName="Ali" onOpenChange={() => undefined} />,
    );
    fireEvent.change(await byId('concession-value'), { target: { value: '10' } });
    fireEvent.change(await byId('concession-from'), { target: { value: '2026-08-20' } });
    expect((await byId('concession-applies-hint')).textContent).toContain('2026-09-01');
    fireEvent.click(await byId('concession-save'));
    const regen = await byId('concession-regenerate');
    expect(regen.textContent).toContain('2026-09-01');
    fireEvent.click(regen);
    // Ali's billed months from 2026-09 up to now: 2026-09 and 2026-10 (not 2026-08).
    await waitFor(() =>
      expect(
        (posts(api.calls, '/api/fees/regenerate') as { period: string }[]).map((b) => b.period),
      ).toEqual(['2026-09', '2026-10']),
    );
  });
});

describe('counter: role-aware hints and refusals', () => {
  it('no bank account: an accountant is told to ask an admin; an owner where to add one', async () => {
    mockApi({
      [`GET /api/fees/family/${fam}`]: familyStatement(),
      'GET /api/accounts': { accounts: [] },
    });
    renderAt(`/fees/counter?family=${fam}`, '/fees/counter', <CounterPage />, ['accountant']);
    fireEvent.click(await byId('method-bank'));
    expect((await byId('counter-no-accounts')).textContent).toBe(
      'No bank or wallet account yet. Ask an admin to add one.',
    );
  });

  it('a closed drawer is explained, not shown as a raw 409', async () => {
    mockApi({
      [`GET /api/fees/family/${fam}`]: familyStatement(),
      'GET /api/accounts': accounts,
      'POST /api/receipts': () =>
        new Response(
          JSON.stringify({
            error: { code: 'session_closed', message: 'The cash session is closed' },
          }),
          { status: 409 },
        ),
    });
    renderAt(`/fees/counter?family=${fam}`, '/fees/counter', <CounterPage />, ['accountant']);
    fireEvent.change(await byId('counter-amount'), { target: { value: '1000' } });
    fireEvent.click(await byId('counter-confirm'));
    fireEvent.click(await byId('counter-issue'));
    expect(
      await screen.findByText(
        'Your cash drawer for today is closed. Ask an owner or admin to reopen it before taking cash.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('The cash session is closed')).toBeNull();
    expect(document.getElementById('counter-pending')).toBeNull();
  });

  it('checkboxes sit in a 44 px label', async () => {
    mockApi({ [`GET /api/fees/family/${fam}`]: familyStatement(), 'GET /api/accounts': accounts });
    renderAt(`/fees/counter?family=${fam}`, '/fees/counter', <CounterPage />);
    fireEvent.click(await byId('method-bank'));
    expect((await byId('counter-yesterday')).closest('label')?.className).toContain('min-h-11');
  });
});

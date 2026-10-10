import {
  type FamilyStatementDto,
  type FeeHeadDto,
  type FeeLineDto,
  type FeeSettingsDto,
  feeErrorsEn,
  formatPKR,
  hasGrant,
  newId,
  type PAYMENT_METHODS,
  type StaffRole,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { getJson } from './api';

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type Account = {
  id: string;
  name: string;
  kind: 'cash' | 'bank' | 'wallet';
  holder_staff_id: string | null;
};

// ---- amounts ----------------------------------------------------------------------------------

/** Urdu (U+06F0–9) and Arabic-Indic (U+0660–9) digits typed on a phone keyboard → Latin. */
export function latinDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/**
 * The counter's amount box (rupees, optional paisa) → integer paisa, or null when empty/invalid.
 * Accepts "5,700", "5700", "5700.50", Urdu digits and the Urdu thousands separator (٬).
 */
export function rupeesToPaisa(input: string): number | null {
  const s = latinDigits(input)
    .replace(/[\s٬,]/g, '')
    .replace('٫', '.');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/** What the amount box shows while typing: Latin digits grouped by thousands ("12,500.5"). */
export function formatRupeeInput(input: string): string {
  const s = latinDigits(input).replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = s.split('.');
  const w = whole.replace(/^0+(?=\d)/, '').slice(0, 9);
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rest.length ? `${grouped}.${rest.join('').slice(0, 2)}` : grouped;
}

/** paisa → the plain rupee text an input box holds ("5700" / "5700.50"). */
export const paisaToRupeeText = (p: number): string =>
  p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2);

export const money = (paisa: number) => formatPKR(paisa);

// ---- allocation preview (mirrors packages/db ledger/alloc.ts openDues + oldestFirst) -----------

/** Open family roots in the order the server allocates: due date, period, child, head, id. */
export function openDuesInOrder(lines: readonly FeeLineDto[]): FeeLineDto[] {
  const key = (l: FeeLineDto) => [
    l.due_date,
    l.period_key,
    l.student_name,
    l.student_id,
    l.head_name,
    l.id,
  ];
  return lines
    .filter((l) => l.due > 0)
    .slice()
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        const x = ka[i] as string;
        const y = kb[i] as string;
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    });
}

export type AllocationRow = { line: FeeLineDto; amount: number };
export type AllocationPreview = { rows: AllocationRow[]; credit: number; after: number };

/** Oldest first across the family; the remainder is credit (PLAN §14.4 step 3). */
export function previewOldestFirst(
  lines: readonly FeeLineDto[],
  amount: number,
): AllocationPreview {
  const dues = openDuesInOrder(lines);
  const rows: AllocationRow[] = [];
  let left = amount;
  for (const d of dues) {
    if (left <= 0) break;
    const take = Math.min(left, d.due);
    if (take > 0) rows.push({ line: d, amount: take });
    left -= take;
  }
  const totalDue = dues.reduce((a, d) => a + d.due, 0);
  return { rows, credit: Math.max(0, left), after: totalDue - (amount - Math.max(0, left)) };
}

/**
 * "Only Ali's March": the chosen lines in server order, each paid up to its due from the amount;
 * what is left is credit. The `directed` body sent is exactly these rows.
 */
export function previewDirected(
  lines: readonly FeeLineDto[],
  chosen: ReadonlySet<string>,
  amount: number,
): AllocationPreview {
  const dues = openDuesInOrder(lines).filter((l) => chosen.has(l.id));
  const rows: AllocationRow[] = [];
  let left = amount;
  for (const d of dues) {
    if (left <= 0) break;
    const take = Math.min(left, d.due);
    rows.push({ line: d, amount: take });
    left -= take;
  }
  const totalDue = openDuesInOrder(lines).reduce((a, d) => a + d.due, 0);
  return {
    rows,
    credit: Math.max(0, left),
    after: totalDue - (amount - Math.max(0, left)),
  };
}

// ---- idempotency --------------------------------------------------------------------------------

/**
 * One key per collection attempt: minted when the collector starts an attempt, reused for every
 * retry of that same attempt (network error, double tap), and replaced only when the attempt
 * changes (new amount/method/lines) or the server says `idempotency_conflict`.
 */
export class AttemptKey {
  private key: string | null = null;
  private sig: string | null = null;
  /** The key for this attempt's signature; the same signature keeps its key. */
  for(signature: string): string {
    if (this.key === null || this.sig !== signature) {
      this.key = `ctr-${newId()}`;
      this.sig = signature;
    }
    return this.key;
  }
  reset(): void {
    this.key = null;
    this.sig = null;
  }
}

// ---- rules the counter enforces before the server does -----------------------------------------

export const needsAccount = (m: PaymentMethod) => m !== 'cash';

/** Accounts a method can land in (the server's defaultAccount mapping, plus any explicit pick). */
export function accountsFor(method: PaymentMethod, accounts: readonly Account[]): Account[] {
  if (method === 'cash') return [];
  const kinds =
    method === 'jazzcash' || method === 'easypaisa'
      ? ['wallet']
      : method === 'other'
        ? ['bank', 'wallet']
        : ['bank'];
  const preferred = accounts.filter((a) => kinds.includes(a.kind));
  return preferred.length ? preferred : accounts.filter((a) => a.kind !== 'cash');
}

/** Yesterday is offered only to an owner/admin, only for non-cash (PLAN M3b date rules). */
export const mayBackdate = (roles: readonly StaffRole[], method: PaymentMethod) =>
  method !== 'cash' && roles.some((r) => r === 'owner' || r === 'admin');

export const canCollect = (r: readonly StaffRole[]) => hasGrant(r, 'receipt', 'create');
export const canReverse = (r: readonly StaffRole[]) => hasGrant(r, 'receipt', 'reverse');
export const canReadMoney = (r: readonly StaffRole[]) => hasGrant(r, 'receipt', 'read');
export const canManageFees = (r: readonly StaffRole[]) => hasGrant(r, 'fee', 'manage');
export const canConcession = (r: readonly StaffRole[]) => hasGrant(r, 'fee', 'concession');
export const canGenerate = (r: readonly StaffRole[]) => hasGrant(r, 'fee', 'generate');
export const canReadFees = (r: readonly StaffRole[]) => hasGrant(r, 'fee', 'read');
export const canReopenCash = (r: readonly StaffRole[]) => hasGrant(r, 'cash_session', 'reopen_any');
export const canUseCash = (r: readonly StaffRole[]) => hasGrant(r, 'cash_session', 'read');

/** Every code the fee screens can receive; each has an en + ur sentence under errors.* */
export const FEE_ERROR_CODES = Object.keys(feeErrorsEn) as (keyof typeof feeErrorsEn)[];

// ---- dates ----------------------------------------------------------------------------------------

export function addDaysIso(d: string, n: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

// ---- queries ----------------------------------------------------------------------------------

export const familyKey = (id: string | undefined) => ['fee-family', id] as const;

export const useFamilyStatement = (id: string | undefined) =>
  useQuery({
    queryKey: familyKey(id),
    queryFn: () => getJson<FamilyStatementDto>(`/api/fees/family/${id}`),
    enabled: !!id,
    staleTime: 0,
  });

export const useFeeHeads = () =>
  useQuery({
    queryKey: ['fee-heads'],
    queryFn: () => getJson<{ heads: FeeHeadDto[] }>('/api/fees/heads'),
  });

export const useFeeSettings = () =>
  useQuery({
    queryKey: ['fee-settings'],
    queryFn: () => getJson<{ fees: FeeSettingsDto }>('/api/school/fees'),
  });

export const useAccounts = (enabled = true) =>
  useQuery({
    queryKey: ['accounts'],
    queryFn: () => getJson<{ accounts: Account[] }>('/api/accounts'),
    enabled,
  });

export const headLabel = (
  h: { head_name: string | null; head_name_ur: string | null } | undefined,
  lang: string,
) => (h ? (lang === 'ur' && h.head_name_ur ? h.head_name_ur : (h.head_name ?? '')) : '');

/** The school's calendar day (Asia/Karachi, UTC+5, no DST) — the server's business date. */
export const karachiToday = (now = Date.now()): string =>
  new Date(now + 5 * 3600_000).toISOString().slice(0, 10);

import {
  type FamilyStatementDto,
  type FeeHeadDto,
  type FeeRateDto,
  type FeeSettingsDto,
  type FineDto,
  feeErrorsEn,
  formatPKR,
  hasGrant,
  newId,
  type PAYMENT_METHODS,
  type StaffRole,
} from '@maktab/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, getJson } from './api';

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type Account = {
  id: string;
  name: string;
  kind: 'cash' | 'bank' | 'wallet';
  holder_staff_id: string | null;
  opening_balance?: number;
  opening_as_of?: string | null;
  has_movements?: boolean;
};

// ---- amounts ----------------------------------------------------------------------------------

/** Urdu (U+06F0–9) and Arabic-Indic (U+0660–9) digits typed on a phone keyboard → Latin. */
export function latinDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

const GROUPED = /^\d{1,3}(?:[,٬]\d{3})+(?:\.\d+)?$/;

/**
 * The counter's amount box (rupees, optional paisa) → integer paisa, or null when empty/invalid.
 * Accepts "5,700", "5700", "5700.50", Urdu/Arabic digits, the Urdu thousands separator (٬), and a
 * decimal written as "٫" or a single "," ("12,50" = 12.50). Rejects more than 2 decimals, more than
 * 9 rupee digits, and commas that are neither grouping nor one decimal mark ("1,2,3").
 */
export function rupeesToPaisa(input: string): number | null {
  let s = latinDigits(input).replace(/\s/g, '').replace(/٫/g, '.');
  if (GROUPED.test(s)) s = s.replace(/[,٬]/g, '');
  else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/** What the amount box shows while typing: Latin digits grouped by thousands ("12,500.5"). */
export function formatRupeeInput(input: string): string {
  // "٫" is the Urdu decimal mark; a comma typed at the very end (a decimal-comma keyboard) is too —
  // the box never ends in a grouping comma, so a trailing one was just typed.
  let s = latinDigits(input).replace(/٫/g, '.');
  if (!s.includes('.') && /\d,$/.test(s)) s = `${s.slice(0, -1)}.`;
  s = s.replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = s.split('.');
  const w = whole.replace(/^0+(?=\d)/, '').slice(0, 9);
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return rest.length ? `${grouped}.${rest.join('').slice(0, 2)}` : grouped;
}

/** paisa → the plain rupee text an input box holds ("5700" / "5700.50"). */
export const paisaToRupeeText = (p: number): string =>
  p % 100 === 0 ? String(p / 100) : (p / 100).toFixed(2);

export const money = (paisa: number) => formatPKR(paisa);

// ---- allocation preview: one implementation in @maktab/shared (alloc.ts), shared with the smoke
// and the API's drift test against the server planner.
export {
  type AllocationPreview,
  type AllocationRow,
  balanceAfter,
  openDuesInOrder,
  previewDirected,
  previewOldestFirst,
} from '@maktab/shared';

// ---- idempotency --------------------------------------------------------------------------------

/** A fresh idempotency key for one collection (or refund) attempt. */
export const mintAttemptKey = (prefix = 'ctr'): string => `${prefix}-${newId()}`;

/**
 * Was the outcome of a request unknown (no answer, or a server-side failure that may have
 * committed)? Then the attempt stays pending and is only ever replayed with the same key.
 */
export const outcomeUnknown = (err: unknown): boolean =>
  !(err instanceof ApiError) || err.status >= 500 || err.status === 408 || err.status === 429;

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

export const useFeeRates = (enabled = true) =>
  useQuery({
    queryKey: ['fee-rates'],
    queryFn: () => getJson<{ rates: FeeRateDto[] }>('/api/fees/rates'),
    enabled,
  });

export const useFeeSettings = () =>
  useQuery({
    queryKey: ['fee-settings'],
    queryFn: () => getJson<{ fees: FeeSettingsDto }>('/api/school/fees'),
  });

export const useAccounts = (enabled = true) =>
  useQuery({
    queryKey: ['accounts'],
    queryFn: () => getJson<{ accounts: Account[]; my_drawer?: string | null }>('/api/accounts'),
    enabled,
  });

export const headLabel = (
  h: { head_name: string | null; head_name_ur: string | null } | undefined,
  lang: string,
) => (h ? (lang === 'ur' && h.head_name_ur ? h.head_name_ur : (h.head_name ?? '')) : '');

/** The school's calendar day (Asia/Karachi, UTC+5, no DST) — the server's business date. */
export const karachiToday = (now = Date.now()): string =>
  new Date(now + 5 * 3600_000).toISOString().slice(0, 10);

/** The fine on a root: one still to waive first, else a fully waived one (shown as waived). */
export const fineOf = (fines: readonly FineDto[], rootId: string): FineDto | undefined =>
  fines.find((f) => f.root_id === rootId && f.left > 0) ?? fines.find((f) => f.root_id === rootId);

// ---- fee register: the class picked last time on this device -----------------------------------

/** localStorage `maktab.feeRegister.<school id>`: one group id per installation. Best effort. */
export const registerGroupKey = (schoolId: string) => `maktab.feeRegister.${schoolId}`;

export function rememberedRegisterGroup(schoolId: string): string | null {
  try {
    return localStorage.getItem(registerGroupKey(schoolId));
  } catch {
    return null;
  }
}

export function rememberRegisterGroup(schoolId: string, grpId: string): void {
  try {
    localStorage.setItem(registerGroupKey(schoolId), grpId);
  } catch {
    // Private mode / blocked storage: the page falls back to the default class next time.
  }
}

/**
 * The class the register opens on: the one remembered on this device if it still exists, else the
 * teacher's first own group, else the first group, both taken from the current session's groups
 * (all groups only when the current session has none); '' only when there are no groups.
 */
export function defaultRegisterGroup(
  groups: readonly { id: string; session_id: string | null }[],
  remembered: string | null,
  mine: readonly { id: string }[] = [],
  currentSessionId: string | null = null,
): string {
  if (remembered && groups.some((g) => g.id === remembered)) return remembered;
  const current = groups.filter((g) => currentSessionId && g.session_id === currentSessionId);
  const pool = current.length ? current : groups;
  const own = pool.find((g) => mine.some((m) => m.id === g.id));
  return own?.id ?? pool[0]?.id ?? '';
}

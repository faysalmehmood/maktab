import { z } from 'zod';
import { isoDateSchema } from './attendance';
import { periodSchema } from './fees';
import { paisaSchema } from './money';
import { idSchema } from './user';

/**
 * Milestone 4 contract (PLAN §14.8, §14.11): money out and the reports. Request schemas the API
 * validates and the web forms reuse, and the response shapes. Money is integer paisa; periods are
 * `YYYY-MM`; dates `YYYY-MM-DD` (Asia/Karachi school day).
 */

/** A reference to an existing row (seeded rows such as categories have readable ids, not ULIDs). */
const refSchema = z.string().trim().min(1).max(64);
const reqText = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();
const positivePaisa = paisaSchema.refine((n) => n > 0, 'must be > 0');
const bool = z
  .union([z.boolean(), z.enum(['1', '0', 'true', 'false'])])
  .transform((v) => v === true || v === '1' || v === 'true');

export const PAYSLIP_STATUSES = ['draft', 'approved', 'paid', 'void'] as const;
export type PayslipStatus = (typeof PAYSLIP_STATUSES)[number];
export const PAYSLIP_LINE_KINDS = ['basic', 'allowance', 'deduction', 'advance_recovery'] as const;
export type PayslipLineKind = (typeof PAYSLIP_LINE_KINDS)[number];

// ---- requests -------------------------------------------------------------------------------------

export const expenseInputSchema = z.object({
  /** Client-minted ULID: a retried save returns the same expense. */
  id: idSchema.optional(),
  category_id: refSchema,
  amount: positivePaisa,
  /** The drawer (a cash account) or the bank/wallet the money left. */
  account_id: refSchema,
  date: isoDateSchema.optional(),
  vendor: optText(120),
  note: optText(300),
});
export type ExpenseInput = z.input<typeof expenseInputSchema>;

export const voidReasonSchema = z.object({ reason: reqText(200) });

export const expenseQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  category_id: refSchema.optional(),
  account_id: refSchema.optional(),
  include_void: bool.optional(),
  q: z.string().trim().max(60).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

export const payslipLineSchema = z.object({
  kind: z.enum(PAYSLIP_LINE_KINDS),
  amount: positivePaisa,
  note: optText(80),
});
export type PayslipLineInput = z.input<typeof payslipLineSchema>;

export const payslipGenerateSchema = z.object({
  period: periodSchema,
  /** Cursor from the previous chunk (`next`); absent on the first call. */
  after: refSchema.nullable().optional(),
});
export const payslipCreateSchema = z.object({
  id: idSchema.optional(),
  staff_id: refSchema,
  period: periodSchema,
  lines: z.array(payslipLineSchema).max(30).optional(),
});
export const payslipLinesSchema = z.object({ lines: z.array(payslipLineSchema).max(30) });
export const payslipQuerySchema = z.object({
  period: periodSchema.optional(),
  from: periodSchema.optional(),
  to: periodSchema.optional(),
  staff_id: refSchema.optional(),
  status: z.enum(PAYSLIP_STATUSES).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

export const salaryPaymentSchema = z.object({
  id: idSchema.optional(),
  amount: positivePaisa,
  account_id: refSchema,
  date: isoDateSchema.optional(),
  note: optText(200),
});
export type SalaryPaymentInput = z.input<typeof salaryPaymentSchema>;

export const advanceInputSchema = z.object({
  id: idSchema.optional(),
  staff_id: refSchema,
  amount: positivePaisa,
  account_id: refSchema,
  date: isoDateSchema.optional(),
  note: optText(200),
});
export type AdvanceInput = z.input<typeof advanceInputSchema>;

export const staffPaySchema = z.object({
  base_salary: paisaSchema.min(0).nullable(),
  allowances: z
    .array(z.object({ label: reqText(40), amount: positivePaisa }))
    .max(10)
    .default([]),
  joined: isoDateSchema.nullable().optional(),
});
export type StaffPayInput = z.input<typeof staffPaySchema>;

export const monthRangeQuerySchema = z.object({
  from: periodSchema,
  to: periodSchema,
  format: z.enum(['json', 'csv']).optional(),
});
export const cashbookQuerySchema = z.object({
  account_id: refSchema,
  from: isoDateSchema,
  to: isoDateSchema,
  format: z.enum(['json', 'csv']).optional(),
});
export const balancesQuerySchema = z.object({
  as_of: isoDateSchema.optional(),
  format: z.enum(['json', 'csv']).optional(),
});
export const auditQuerySchema = z.object({
  entity: z.string().trim().max(40).optional(),
  entity_id: z.string().trim().max(80).optional(),
  user_id: refSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** Keyset cursor: the `id` of the last row of the previous page. */
  before: z.string().max(80).optional(),
});
export const dashboardMonthQuerySchema = z.object({ period: periodSchema.optional() });

// ---- responses ------------------------------------------------------------------------------------

export type ExpenseCategoryDto = {
  id: string;
  code: string | null;
  name: string;
  name_ur: string | null;
  /** Reserved for reports (salaries); never offered when recording an expense. */
  system: boolean;
};

export type ExpenseDto = {
  id: string;
  expense_no: string;
  date: string;
  category_id: string;
  category_code: string | null;
  category_name: string;
  category_name_ur: string | null;
  account_id: string;
  account_name: string;
  account_kind: string;
  amount: number;
  vendor: string | null;
  note: string | null;
  has_photo: boolean;
  voided: boolean;
  void_reason: string | null;
  created_by_name: string | null;
};

export type ExpenseListDto = { expenses: ExpenseDto[]; total: number; from: string; to: string };

export type PayslipDto = {
  id: string;
  staff_id: string;
  staff_name: string;
  staff_role: string | null;
  period_key: string;
  status: PayslipStatus;
  earnings: number;
  deductions: number;
  recovery: number;
  /** earnings − deductions: the salary expense of the month. */
  pay: number;
  /** pay − advance recovery: what is paid out. */
  net: number;
  paid: number;
  approved_by_name: string | null;
  approved_at: string | null;
  void_reason: string | null;
};

export type PayslipDetailDto = PayslipDto & {
  lines: { id: string; kind: PayslipLineKind; amount: number; note: string | null }[];
  payments: {
    id: string;
    amount: number;
    account_id: string;
    account_name: string;
    date: string;
    note: string | null;
  }[];
  advance: { advanced: number; recovered: number; outstanding: number };
  /** Can the caller approve this slip (role, and not their own)? */
  can_approve: boolean;
  school: { name: string; name_ur: string | null; address: string | null; phone: string | null };
};

export type PayslipListDto = {
  payslips: PayslipDto[];
  totals: { pay: number; net: number; paid: number };
};

export type GeneratePayslipsDto = { created: number; skipped: number; next: string | null };

export type AdvanceBalanceDto = {
  staff_id: string;
  staff_name: string;
  advanced: number;
  recovered: number;
  outstanding: number;
  last_advance: string | null;
};
export type AdvanceDto = {
  id: string;
  staff_id: string;
  staff_name: string;
  amount: number;
  account_id: string;
  account_name: string;
  date: string;
  note: string | null;
};
export type AdvanceListDto = { balances: AdvanceBalanceDto[]; advances: AdvanceDto[] };

export type PayrollStaffDto = {
  id: string;
  name: string;
  role: string | null;
  status: string;
  joined: string | null;
  base_salary: number | null;
  allowances: { label: string; amount: number }[];
  outstanding_advance: number;
};

export type IncomeExpenseDto = {
  from: string;
  to: string;
  income: {
    by_head: { fee_head_id: string; name: string; name_ur: string | null; amount: number }[];
    unallocated: number;
    total: number;
  };
  expenses: {
    by_category: {
      category_id: string;
      code: string | null;
      name: string;
      name_ur: string | null;
      amount: number;
    }[];
    total: number;
  };
  salaries: { pay: number; slips: number };
  net: number;
  months: { period: string; income: number; expenses: number; salaries: number; net: number }[];
  reconciliation: {
    income: number;
    expenses: number;
    salary_paid: number;
    advances_paid: number;
    expected_movement: number;
    movement: number;
    ties: boolean;
  };
};

export type CashbookRowDto = {
  date: string;
  kind: 'receipt' | 'expense' | 'salary' | 'advance' | 'transfer_in' | 'transfer_out';
  subkind: string | null;
  ref_id: string;
  ref_no: string | null;
  party: string | null;
  amount: number;
  balance: number;
};
export type CashbookDto = {
  account: { id: string; name: string; kind: string };
  from: string;
  to: string;
  opening: number;
  rows: CashbookRowDto[];
  in: number;
  out: number;
  closing: number;
};

export type AccountBalanceDto = {
  account_id: string | null;
  name: string;
  kind: 'cash' | 'bank' | 'wallet' | null;
  balance: number;
};

export type AuditRowDto = {
  id: string;
  at: string;
  user_id: string | null;
  user_name: string | null;
  entity: string;
  entity_id: string;
  action: string;
  diff: unknown;
};
export type AuditListDto = { rows: AuditRowDto[]; next: string | null };

export type MonthDashboardDto = {
  period: string;
  income: number;
  expenses: number;
  salaries: number;
  net: number;
  dues_outstanding: number;
  defaulters: number;
  admissions: number;
  left: number;
};

/** Row shown for a money-out error code (the web maps it to a sentence). */
export const MONEY_ERROR_CODES = [
  'account_required',
  'bad_business_date',
  'session_closed',
  'category_reserved',
  'already_void',
  'not_voidable',
  'already_exists',
  'not_draft',
  'own_payslip',
  'negative_net',
  'recovery_exceeds_advance',
  'not_approved',
  'not_payable',
  'already_paid',
  'exceeds_net',
  'idempotency_conflict',
] as const;

import { z } from 'zod';
import { isoDateSchema } from './attendance';
import { paisaSchema } from './money';
import { idSchema } from './user';

/**
 * Milestone 3 contract (PLAN §5.2, §14.4–14.7): request schemas the API validates and the web
 * forms reuse, and the response shapes. Money is integer paisa everywhere; periods are `YYYY-MM`.
 */

export const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM');
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

export const FEE_HEAD_KINDS = ['admission', 'tuition', 'exam', 'course', 'misc', 'fine'] as const;
export const FEE_CADENCES = ['monthly', 'once', 'per_term'] as const;
export const CONCESSION_REASONS = [
  'sibling',
  'orphan',
  'staff_child',
  'scholarship',
  'topper',
  'needy',
  'other',
] as const;
export const PAYMENT_METHODS = [
  'cash',
  'bank',
  'jazzcash',
  'easypaisa',
  'cheque',
  'other',
] as const;
export const ACCOUNT_KINDS = ['cash', 'bank', 'wallet'] as const;

export const feeHeadInputSchema = z.object({
  id: idSchema.optional(),
  name: reqText(60),
  name_ur: optText(60),
  kind: z.enum(FEE_HEAD_KINDS).refine((k) => k !== 'fine', 'fines come from the fine rule'),
  cadence: z.enum(FEE_CADENCES),
});
/** Kind and cadence are fixed once created (charges depend on them); archive instead. */
export const feeHeadPatchSchema = z.object({
  name: reqText(60).optional(),
  name_ur: optText(60),
  archived: z.boolean().optional(),
});

/** A new rate is a new row (never edited); exactly one of programme_id / grp_id. */
export const feeRateInputSchema = z
  .object({
    id: idSchema.optional(),
    fee_head_id: idSchema,
    programme_id: idSchema.optional(),
    grp_id: idSchema.optional(),
    amount: paisaSchema.refine((n) => n >= 0, 'must be ≥ 0'),
    effective_from: isoDateSchema,
  })
  .refine((r) => !!r.programme_id !== !!r.grp_id, {
    message: 'programme_or_group',
    path: ['programme_id'],
  });

export const fineRuleSchema = z.object({
  enabled: z.boolean(),
  grace_day: z.number().int().min(1).max(28),
  type: z.enum(['fixed', 'pct']),
  value: z.number().int().min(0),
  cap: paisaSchema.min(1).nullable().default(null),
});
export type FineRuleInput = z.input<typeof fineRuleSchema>;
export const siblingRuleSchema = z
  .array(z.object({ nth: z.number().int().min(2).max(10), pct: z.number().int().min(1).max(100) }))
  .max(9)
  .refine((a) => new Set(a.map((r) => r.nth)).size === a.length, 'duplicate nth');
export const feeSettingsSchema = z.object({
  fine_rule: fineRuleSchema.nullable(),
  sibling_rule: siblingRuleSchema,
  reminder_cooldown_days: z.number().int().min(1).max(90),
});
export type FeeSettingsInput = z.input<typeof feeSettingsSchema>;
export type FeeSettingsDto = z.output<typeof feeSettingsSchema> & {
  due_day: number;
  /** The receipt series prefix in use ('R' when the school set none). */
  receipt_prefix: string;
  /** Once true, the prefix is locked (PUT /api/school refuses a change: 409 prefix_locked). */
  receipts_issued: boolean;
};

export const concessionInputSchema = z
  .object({
    id: idSchema.optional(),
    student_id: idSchema,
    /** null = every tuition head (PLAN §14.7 default: monthly tuition). */
    fee_head_id: idSchema.nullable().default(null),
    type: z.enum(['pct', 'fixed']),
    /** percent 1–100, or paisa */
    value: z.number().int().min(1),
    reason: z.enum(CONCESSION_REASONS),
    note: optText(300),
    valid_from: isoDateSchema,
    valid_to: isoDateSchema.nullable().optional(),
  })
  .refine((c) => c.type !== 'pct' || c.value <= 100, { message: 'max_100', path: ['value'] })
  .refine((c) => !c.valid_to || c.valid_to >= c.valid_from, {
    message: 'end_before_start',
    path: ['valid_to'],
  });
export const concessionEndSchema = z.object({ ended_at: isoDateSchema, reason: reqText(200) });

export const sponsorInputSchema = z.object({
  id: idSchema.optional(),
  name: reqText(100),
  phone: optText(20),
  cnic: optText(15),
});
export const sponsorPatchSchema = sponsorInputSchema.omit({ id: true }).partial();
export const sponsorshipInputSchema = z.object({
  id: idSchema.optional(),
  sponsor_id: idSchema,
  student_id: idSchema,
  /** null = every head billed. */
  fee_head_id: idSchema.nullable().default(null),
  share_pct: z.number().int().min(1).max(100),
  valid_from: isoDateSchema,
  valid_to: isoDateSchema.nullable().optional(),
});
export const sponsorshipEndSchema = z.object({ valid_to: isoDateSchema });

export const generateInputSchema = z.object({
  period: periodSchema,
  /** Omitted = the first group still to do (resumable). */
  grp_id: idSchema.optional(),
  after_student_id: idSchema.nullable().optional(),
  dry_run: z.boolean().default(false),
  pro_rata: z.boolean().default(false),
});
export const finesApplyInputSchema = z.object({
  /** Omit for every overdue tuition root of any period up to as_of's month (what the cron does). */
  period: periodSchema.optional(),
  as_of: isoDateSchema.optional(),
  dry_run: z.boolean().default(false),
});
export const waiveInputSchema = z.object({
  reason: reqText(200),
  amount: positivePaisa.optional(),
});
export const regenerateInputSchema = z.object({
  student_id: idSchema,
  period: periodSchema,
  dry_run: z.boolean().default(false),
  pro_rata: z.boolean().default(false),
});
export const openingBalanceInputSchema = z.object({
  student_id: idSchema,
  /** paisa; positive = owed, negative = credit */
  amount: paisaSchema,
  as_of: isoDateSchema,
  note: optText(200),
});

export const collectInputSchema = z.object({
  /** Client-minted; a retry with the same key returns the same receipt. */
  idempotency_key: z.string().trim().min(8).max(80),
  payer_type: z.enum(['family', 'sponsor']).default('family'),
  payer_id: idSchema,
  amount: positivePaisa,
  method: z.enum(PAYMENT_METHODS),
  reference: optText(60),
  account_id: idSchema.nullable().optional(),
  note: optText(200),
  /**
   * Default today (Asia/Karachi). Only an owner/admin may enter yesterday, with `backdate_reason`
   * (audited); anything else is 400 bad_business_date. The drawer session is always today's.
   */
  business_date: isoDateSchema.optional(),
  backdate_reason: optText(200),
  /**
   * `dues_hash` of the family view the collector was looking at (duesHash). If the payer's open dues
   * changed since, the server answers 409 stale_dues instead of re-planning; ignored with `directed`.
   */
  expected_due_hash: z.string().trim().min(1).max(40).optional(),
  /** Pay exactly these open charges ("only Ali's March"); the rest is credit. */
  directed: z
    .array(z.object({ charge_id: idSchema, amount: positivePaisa }))
    .max(50)
    .optional(),
});
export type CollectInput = z.input<typeof collectInputSchema>;

export const reverseInputSchema = z.object({
  reason: reqText(200),
  /** "Re-enter correctly" in the same step (PLAN §14.4). */
  reenter: z
    .object({
      amount: positivePaisa,
      method: z.enum(PAYMENT_METHODS).optional(),
      reference: optText(60),
      directed: collectInputSchema.shape.directed,
    })
    .optional(),
});
/**
 * POST /api/charges/:id/void: a fee root voids its whole unit (student, head, period: family and
 * sponsor roots together), or a fine alone; each zeroed by a reversal line (PLAN §14.5).
 */
export const voidChargeSchema = z.object({ reason: reqText(200) });

export const refundInputSchema = z.object({
  idempotency_key: z.string().trim().min(8).max(80),
  payer_type: z.enum(['family', 'sponsor']).default('family'),
  payer_id: idSchema,
  amount: positivePaisa,
  method: z.enum(PAYMENT_METHODS),
  /** The bank/wallet account the money leaves from (non-cash); default: the method's account. */
  account_id: idSchema.nullable().optional(),
  reason: reqText(200),
  reference: optText(60),
});
export type RefundInput = z.input<typeof refundInputSchema>;

export const sessionOpenSchema = z.object({
  business_date: isoDateSchema.optional(),
  opening: paisaSchema.min(0).default(0),
});
export const sessionCloseSchema = z.object({ counted: paisaSchema.min(0) });
export const sessionReopenSchema = z.object({ reason: reqText(200) });
export const transferInputSchema = z.object({
  id: idSchema.optional(),
  from_account: idSchema,
  to_account: idSchema,
  amount: positivePaisa,
  date: isoDateSchema.optional(),
  note: optText(200),
});
export const accountInputSchema = z.object({
  id: idSchema.optional(),
  name: reqText(60),
  kind: z.enum(ACCOUNT_KINDS),
  holder_staff_id: idSchema.nullable().optional(),
});
/** Rename, or change the holder (409 account_has_movements once money moved through it). */
export const accountUpdateSchema = z.object({
  name: reqText(60).optional(),
  holder_staff_id: idSchema.nullable().optional(),
});
/** Pre-pilot opening balance (owner, once, before any movement). Paisa; negative = overdrawn bank. */
export const accountOpeningSchema = z.object({
  amount: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00),
  as_of: isoDateSchema,
});

export const defaultersQuerySchema = z.object({
  grp_id: idSchema.optional(),
  min_months: z.coerce.number().int().min(1).max(36).optional(),
  min_amount: z.coerce.number().int().min(1).optional(),
  exclude_sponsored: bool.optional(),
});
export const remindInputSchema = z.object({
  grp_id: idSchema.optional(),
  min_months: z.number().int().min(1).max(36).optional(),
  min_amount: z.number().int().min(1).optional(),
  exclude_sponsored: z.boolean().optional(),
  /** fee_overdue (default): past due date. fee_due: owing, not yet overdue. */
  template: z.enum(['fee_due', 'fee_overdue']).default('fee_overdue'),
});
export const registerQuerySchema = z.object({
  grp_id: idSchema,
  period: periodSchema,
  format: z.enum(['json', 'csv']).default('json'),
});
export const collectionQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema });
export const concessionRegisterQuerySchema = z.object({
  from: periodSchema.optional(),
  to: periodSchema.optional(),
  reason: z.enum(CONCESSION_REASONS).optional(),
  active_on: isoDateSchema.optional(),
});

/** Fees at admission (PLAN §14.2 step 5). Default: bill the first period now, sibling rule on. */
export const admissionFeesSchema = z.object({
  charge: z.boolean().default(true),
  pro_rata: z.boolean().default(false),
  sibling_concession: z.boolean().default(true),
});
export const previewFeesQuerySchema = z.object({
  grp_id: idSchema,
  family_id: idSchema.optional(),
  student_id: idSchema.optional(),
  start_date: isoDateSchema.optional(),
  pro_rata: bool.optional(),
  sibling_concession: bool.optional(),
});

// ---- responses ----

export type FeeHeadDto = {
  id: string;
  name: string;
  name_ur: string | null;
  kind: (typeof FEE_HEAD_KINDS)[number];
  cadence: (typeof FEE_CADENCES)[number];
  archived: boolean;
};
export type FeeRateDto = {
  id: string;
  fee_head_id: string;
  programme_id: string | null;
  grp_id: string | null;
  amount: number;
  effective_from: string;
  created_at: string;
};

/** A root charge with its tree folded in (PLAN §14.4 family view columns). */
export type FeeLineDto = {
  id: string;
  student_id: string;
  student_name: string;
  admission_no: string;
  fee_head_id: string;
  head_name: string;
  head_name_ur: string | null;
  head_kind: string;
  period_key: string;
  due_date: string;
  payer_type: 'family' | 'sponsor';
  payer_id: string;
  gross: number;
  concession: number;
  fine: number;
  adjustment: number;
  net: number;
  paid: number;
  due: number;
  status: 'paid' | 'partial' | 'overdue' | 'due';
};

export type PlannedChargeDto = {
  id: string;
  student_id: string;
  enrolment_id: string;
  fee_head_id: string;
  head_name: string;
  period_key: string;
  payer_type: 'family' | 'sponsor';
  payer_id: string;
  kind: 'fee' | 'concession';
  amount: number;
  due_date: string;
  parent_charge_id: string | null;
  reason: string | null;
};

export type GenerateResultDto = {
  period: string;
  grp_id: string | null;
  dry_run: boolean;
  planned: PlannedChargeDto[];
  counts: { fees: number; concessions: number; sponsored: number; allocations: number };
  group_done: boolean;
  /** Send these back to continue; both null = the period is done. */
  next: { grp_id: string; after_student_id: string | null } | null;
  done: boolean;
  /**
   * This group's chunk failed and was logged (billing_chunk status 'failed', see GET /api/fees/runs);
   * `next` already skips it, and the cron retries it on its next tick.
   */
  failed: { grp_id: string; code: string; message: string } | null;
};

export type ReceiptAllocationDto = {
  charge_id: string;
  student_id: string;
  student_name: string;
  admission_no: string;
  fee_head_id: string;
  head_name: string;
  head_name_ur: string | null;
  period_key: string;
  amount: number;
};

export type ReceiptDto = {
  id: string;
  receipt_no: string;
  kind: 'payment' | 'reversal' | 'refund' | 'opening';
  reverses_id: string | null;
  reversed_by: string | null;
  payer_type: 'family' | 'sponsor';
  payer_id: string;
  payer_name: string | null;
  amount: number;
  method: (typeof PAYMENT_METHODS)[number];
  account_id: string | null;
  collector_id: string;
  collector_name: string | null;
  cash_session_id: string | null;
  business_date: string;
  reference: string | null;
  note: string | null;
  created_at: string;
};
export type ReceiptDetailDto = ReceiptDto & {
  allocations: ReceiptAllocationDto[];
  allocated: number;
  unallocated: number;
  payer_credit: number;
  payer_due: number;
};
export type CollectResultDto = { receipt: ReceiptDetailDto; replayed: boolean };

export type FamilyStatementDto = {
  family: { id: string; name: string; area: string | null };
  students: {
    id: string;
    name: string;
    admission_no: string;
    status: string;
    group: string | null;
    sponsored: boolean;
  }[];
  charges: FeeLineDto[];
  sponsored: FeeLineDto[];
  receipts: ReceiptDto[];
  credit: number;
  /** Echo as `expected_due_hash` when collecting (duesHash of the open family roots). */
  dues_hash: string;
  totals: {
    gross: number;
    concession: number;
    fine: number;
    net: number;
    paid: number;
    /** Net of unallocated credit (due − credit, floor 0): what the family actually owes. */
    due: number;
    overdue: number;
    /** Σ root dues before credit. */
    due_before_credit: number;
  };
  /** Late fines on this family's roots (open or settled ones listed in `charges`), for "Waive". */
  fines: FineDto[];
};

/** A late fine (child of a root); `left` = amount − waived, what a waiver can still take off. */
export type FineDto = {
  id: string;
  root_id: string;
  student_id: string;
  period_key: string;
  amount: number;
  waived: number;
  left: number;
};

/** GET /api/fees/unbilled?period= — live enrolments with no monthly fee billed for the period. */
export type UnbilledDto = {
  period: string;
  items: {
    student_id: string;
    student_name: string;
    admission_no: string;
    enrolment_id: string;
    grp_id: string;
    group_name: string;
    start_date: string;
  }[];
  /** More rows exist than were returned (the list is capped). */
  more: boolean;
};

export type CashSessionDto = {
  id: string;
  collector_id: string;
  collector_name: string | null;
  business_date: string;
  opening: number;
  /** Stored at close; for an open session, the live figure. */
  expected: number;
  counted: number | null;
  variance: number | null;
  closed_at: string | null;
  closed_by: string | null;
  reopened_by: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  by_method: { method: string; amount: number; count: number }[];
  /** Money that left this drawer (M4): non-void expenses, salary paid, advances, handovers. */
  paid_out: { expenses: number; salaries: number; advances: number; transfers: number };
};

export type DefaulterDto = {
  student_id: string;
  student_name: string;
  admission_no: string;
  family_id: string;
  family_name: string;
  grp_id: string | null;
  group: string | null;
  months_overdue: number;
  overdue: number;
  due: number;
  oldest_period: string;
  sponsored: boolean;
  /** First guardian by priority (WhatsApp number if any, else phone); office view only. */
  guardian_name: string | null;
  guardian_phone: string | null;
};
/** The teacher's variant (fee.read own_groups): no family, phone or payment detail. */
export type DefaulterSummaryDto = Pick<
  DefaulterDto,
  'student_id' | 'student_name' | 'admission_no' | 'grp_id' | 'group' | 'months_overdue' | 'overdue'
>;
export type DefaultersResponse =
  | { summary_only: false; defaulters: DefaulterDto[]; total_overdue: number }
  | { summary_only: true; defaulters: DefaulterSummaryDto[] };

/** Receipt print bilingual labels (PLAN §14.4 "receipt prints in ur/en"); numbers stay Latin. */
export const RECEIPT_LABELS = {
  en: {
    title: 'Fee receipt',
    reversal: 'Reversal',
    refund: 'Refund',
    opening: 'Opening credit',
    receipt_no: 'Receipt no.',
    date: 'Date',
    received_from: 'Received from',
    student: 'Student',
    admission_no: 'Adm. no.',
    month: 'Month',
    head: 'Fee',
    amount: 'Amount',
    total: 'Total received',
    allocated: 'Applied to fees',
    credit_added: 'Kept as advance',
    balance_due: 'Balance due',
    advance: 'Advance (credit)',
    method: 'Paid by',
    reference: 'Reference',
    collector: 'Received by',
    signature: 'Signature',
    reversed_note: 'This receipt has been reversed',
    methods: {
      cash: 'Cash',
      bank: 'Bank',
      jazzcash: 'JazzCash',
      easypaisa: 'EasyPaisa',
      cheque: 'Cheque',
      other: 'Other',
    },
  },
  ur: {
    title: 'فیس رسید',
    reversal: 'منسوخی',
    refund: 'واپسی',
    opening: 'سابقہ پیشگی',
    receipt_no: 'رسید نمبر',
    date: 'تاریخ',
    received_from: 'وصول از',
    student: 'طالب علم',
    admission_no: 'داخلہ نمبر',
    month: 'مہینہ',
    head: 'فیس',
    amount: 'رقم',
    total: 'کل وصولی',
    allocated: 'فیس میں جمع',
    credit_added: 'پیشگی جمع',
    balance_due: 'بقایا',
    advance: 'پیشگی (کریڈٹ)',
    method: 'ادائیگی بذریعہ',
    reference: 'حوالہ',
    collector: 'وصول کنندہ',
    signature: 'دستخط',
    reversed_note: 'یہ رسید منسوخ ہو چکی ہے',
    methods: {
      cash: 'نقد',
      bank: 'بینک',
      jazzcash: 'جاز کیش',
      easypaisa: 'ایزی پیسہ',
      cheque: 'چیک',
      other: 'دیگر',
    },
  },
} as const;

export type ReceiptPrintDto = {
  school: {
    name: string;
    name_ur: string | null;
    address: string | null;
    phone: string | null;
    has_logo: boolean;
  };
  labels: typeof RECEIPT_LABELS;
  /** Default print language (school default); the page may toggle. */
  lang: 'en' | 'ur';
  receipt: ReceiptDto;
  /** One block per child, each with its lines (allocations net per charge). */
  students: {
    student_id: string;
    student_name: string;
    admission_no: string;
    lines: {
      charge_id: string;
      period_key: string;
      head_name: string;
      head_name_ur: string | null;
      amount: number;
    }[];
    subtotal: number;
  }[];
  totals: {
    amount: number;
    allocated: number;
    credit_added: number;
    /** After this receipt (live, so a reprint shows the current position). */
    payer_due: number;
    payer_credit: number;
  };
  reversed: boolean;
};

/**
 * A short fingerprint of a payer's open dues (root id + amount due), order-independent. The family view
 * returns it; the fee counter sends it back as `expected_due_hash`, so a collection made against a
 * view that has since changed (another receipt, a concession, a fine) is refused rather than silently
 * allocated differently from what the collector saw. FNV-1a over `id:due` lines, two 32-bit lanes.
 */
export function duesHash(rows: readonly { id: string; due: number }[]): string {
  const text = rows
    .filter((r) => r.due > 0)
    .map((r) => `${r.id}:${r.due}`)
    .sort()
    .join('|');
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** A concession row (never edited; "End" sets ended_at / valid_to). value: percent or paisa. */
export type ConcessionDto = {
  id: string;
  student_id: string;
  student_name: string;
  fee_head_id: string | null;
  head_name: string | null;
  type: 'pct' | 'fixed';
  value: number;
  reason: (typeof CONCESSION_REASONS)[number];
  note: string | null;
  valid_from: string;
  valid_to: string | null;
  ended_at: string | null;
  end_reason: string | null;
  created_at: string;
};

export type SponsorshipDto = {
  id: string;
  sponsor_id: string;
  sponsor_name: string;
  student_id: string;
  fee_head_id: string | null;
  head_name: string | null;
  share_pct: number;
  valid_from: string;
  valid_to: string | null;
};

/** GET /api/fees/student/:id — the student detail "Fees" tab (PLAN §14.7, M3b screen 10). */
export type StudentFeesDto = {
  student: { id: string; name: string; admission_no: string; family_id: string };
  family_name: string;
  /** The family's roots for this child (open + settled in the last 12 months). */
  lines: FeeLineDto[];
  /** What sponsors are billed for this child. */
  sponsored: FeeLineDto[];
  /** Σ open family dues of this child (before the family's credit). */
  due: number;
  family_due: number;
  family_credit: number;
  concessions: ConcessionDto[];
  sponsorships: SponsorshipDto[];
  opening_balance: { amount: number; as_of: string; note: string | null } | null;
  /** The family's receipts (one receipt may cover several children). */
  receipts: ReceiptDto[];
};

/** GET /api/dashboard/fees — the office fee tiles (PLAN §14.11). */
export type FeeDashboardDto = {
  date: string;
  /** Today's money in, by method (cash on its drawer's date, non-cash on its business date). */
  collected: { method: (typeof PAYMENT_METHODS)[number]; amount: number; count: number }[];
  collected_total: number;
  /** Σ family dues net of each family's unallocated credit. */
  dues_outstanding: number;
  /** Students with money past its due date. */
  defaulters: number;
  billing_alerts: number;
  /** fee_due / fee_overdue / payment_received rows waiting in the send queue. */
  queued_fee_messages: number;
};

/** GET /api/fees/sponsors/:id/statement */
export type SponsorStatementDto = {
  sponsor: { id: string; name: string; phone: string | null };
  sponsorships: {
    id: string;
    student_id: string;
    student_name: string;
    fee_head_id: string | null;
    share_pct: number;
    valid_from: string;
    valid_to: string | null;
  }[];
  charges: FeeLineDto[];
  receipts: ReceiptDto[];
  credit: number;
  dues_hash: string;
  totals: { net: number; paid: number; due: number };
};
export type SponsorListItemDto = {
  id: string;
  name: string;
  phone: string | null;
  active_students: number;
  due: number;
};
export type FamilyHitDto = {
  family_id: string;
  family_name: string;
  students: { id: string; name: string; admission_no: string; group: string | null }[];
  due: number;
  credit: number;
};

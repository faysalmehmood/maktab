import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';
import { enrolment, grp, programme, staff, student } from './academic';
import { user } from './auth';
import { id, oneOf, paisa, stamps } from './common';

// Append-only rules, allocation invariants and the charge views live in ../../sql (Drizzle cannot express them).

export const FEE_HEAD_KINDS = ['admission', 'tuition', 'exam', 'course', 'misc', 'fine'] as const;
export const FEE_CADENCES = ['monthly', 'once', 'per_term'] as const;

export const feeHead = sqliteTable(
  'fee_head',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind', { enum: FEE_HEAD_KINDS }).notNull(),
    cadence: text('cadence', { enum: FEE_CADENCES }).notNull(),
    ...stamps(),
  },
  () => [
    check('fee_head_kind', oneOf('kind', FEE_HEAD_KINDS)),
    check('fee_head_cadence', oneOf('cadence', FEE_CADENCES)),
  ],
);

/** Versioned by `effective_from`; a new rate is a new row. Exactly one of programme/grp is set. */
export const feeRate = sqliteTable(
  'fee_rate',
  {
    id: id(),
    feeHeadId: text('fee_head_id')
      .notNull()
      .references(() => feeHead.id),
    programmeId: text('programme_id').references(() => programme.id),
    grpId: text('grp_id').references(() => grp.id),
    amount: paisa('amount').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    ...stamps(),
  },
  () => [
    check('fee_rate_target', sql`("programme_id" IS NULL) <> ("grp_id" IS NULL)`),
    check('fee_rate_amount', sql`"amount" >= 0`),
  ],
);

export const CONCESSION_TYPES = ['pct', 'fixed'] as const;
export const CONCESSION_REASONS = [
  'sibling',
  'orphan',
  'staff_child',
  'scholarship',
  'topper',
  'needy',
  'other',
] as const;

/** Never edited: to change, end this row and add a new one. `value` is a percent (0–100) or paisa. */
export const concession = sqliteTable(
  'concession',
  {
    id: id(),
    studentId: text('student_id')
      .notNull()
      .references(() => student.id),
    feeHeadId: text('fee_head_id').references(() => feeHead.id),
    type: text('type', { enum: CONCESSION_TYPES }).notNull(),
    value: integer('value').notNull(),
    reason: text('reason', { enum: CONCESSION_REASONS }).notNull(),
    note: text('note'),
    approvedBy: text('approved_by')
      .notNull()
      .references(() => user.id),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
    endedAt: text('ended_at'),
    endedBy: text('ended_by').references(() => user.id),
    endReason: text('end_reason'),
    ...stamps(),
  },
  () => [
    check('concession_type', oneOf('type', CONCESSION_TYPES)),
    check('concession_reason', oneOf('reason', CONCESSION_REASONS)),
    check('concession_value', sql`"value" > 0 AND ("type" <> 'pct' OR "value" <= 100)`),
  ],
);

export const sponsor = sqliteTable('sponsor', {
  id: id(),
  name: text('name').notNull(),
  phone: text('phone'),
  cnic: text('cnic'),
  ...stamps(),
});

export const sponsorship = sqliteTable(
  'sponsorship',
  {
    id: id(),
    sponsorId: text('sponsor_id')
      .notNull()
      .references(() => sponsor.id),
    studentId: text('student_id')
      .notNull()
      .references(() => student.id),
    feeHeadId: text('fee_head_id').references(() => feeHead.id),
    sharePct: integer('share_pct').notNull(),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
    ...stamps(),
  },
  () => [check('sponsorship_share', sql`"share_pct" BETWEEN 1 AND 100`)],
);

export const billingRun = sqliteTable('billing_run', {
  id: id(),
  periodKey: text('period_key').notNull().unique(),
  runAt: text('run_at').notNull(),
  runBy: text('run_by').references(() => user.id),
  note: text('note'),
  ...stamps(),
});

export const PAYER_TYPES = ['family', 'sponsor'] as const;
export const CHARGE_KINDS = ['fee', 'concession', 'fine', 'fine_waiver', 'reversal'] as const;

/**
 * Signed amount. Root charges have `parent_charge_id` NULL; concession/fine/waiver/reversal lines
 * point at their root and are folded into its net (see charge_net view). `payer_id` is polymorphic.
 */
export const charge = sqliteTable(
  'charge',
  {
    id: id(),
    studentId: text('student_id')
      .notNull()
      .references(() => student.id),
    enrolmentId: text('enrolment_id').references(() => enrolment.id),
    feeHeadId: text('fee_head_id')
      .notNull()
      .references(() => feeHead.id),
    periodKey: text('period_key').notNull(),
    payerType: text('payer_type', { enum: PAYER_TYPES }).notNull(),
    payerId: text('payer_id').notNull(),
    amount: paisa('amount').notNull(),
    dueDate: text('due_date').notNull(),
    kind: text('kind', { enum: CHARGE_KINDS }).notNull(),
    parentChargeId: text('parent_charge_id').references((): AnySQLiteColumn => charge.id),
    reason: text('reason'),
    runId: text('run_id').references(() => billingRun.id),
    ...stamps(),
  },
  (t) => [
    check('charge_kind', oneOf('kind', CHARGE_KINDS)),
    check('charge_payer_type', oneOf('payer_type', PAYER_TYPES)),
    check('charge_root_kind', sql`"parent_charge_id" IS NOT NULL OR "kind" IN ('fee','fine')`),
    index('charge_payer').on(t.payerId),
    index('charge_parent').on(t.parentChargeId),
    index('charge_student').on(t.studentId),
  ],
);

export const openingBalance = sqliteTable('opening_balance', {
  studentId: text('student_id')
    .primaryKey()
    .references(() => student.id),
  amount: paisa('amount').notNull(),
  asOf: text('as_of').notNull(),
  note: text('note'),
  ...stamps(),
});

export const receiptSeries = sqliteTable(
  'receipt_series',
  {
    series: text('series').notNull(),
    year: integer('year').notNull(),
    nextNo: integer('next_no').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.series, t.year] })],
);

export const ACCOUNT_KINDS = ['cash', 'bank', 'wallet'] as const;

export const account = sqliteTable(
  'account',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ACCOUNT_KINDS }).notNull(),
    holderStaffId: text('holder_staff_id').references(() => staff.id),
    ...stamps(),
  },
  () => [check('account_kind', oneOf('kind', ACCOUNT_KINDS))],
);

/** Opening/expected/counted/variance are paisa. Closing fills the nullable columns once. */
export const cashSession = sqliteTable(
  'cash_session',
  {
    id: id(),
    collectorId: text('collector_id')
      .notNull()
      .references(() => user.id),
    businessDate: text('business_date').notNull(),
    opening: paisa('opening').notNull().default(0),
    expected: paisa('expected'),
    counted: paisa('counted'),
    variance: paisa('variance'),
    closedAt: text('closed_at'),
    closedBy: text('closed_by').references(() => user.id),
    ...stamps(),
  },
  (t) => [unique('cash_session_once').on(t.collectorId, t.businessDate)],
);

export const RECEIPT_KINDS = ['payment', 'reversal', 'refund'] as const;
export const PAYMENT_METHODS = ['cash', 'bank', 'jazzcash', 'easypaisa'] as const;

export const receipt = sqliteTable(
  'receipt',
  {
    id: id(),
    receiptNo: text('receipt_no').notNull().unique(),
    kind: text('kind', { enum: RECEIPT_KINDS }).notNull(),
    reversesId: text('reverses_id')
      .unique()
      .references((): AnySQLiteColumn => receipt.id),
    payerType: text('payer_type', { enum: PAYER_TYPES }).notNull(),
    payerId: text('payer_id').notNull(),
    amount: paisa('amount').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull(),
    accountId: text('account_id').references(() => account.id),
    collectorId: text('collector_id')
      .notNull()
      .references(() => user.id),
    cashSessionId: text('cash_session_id').references(() => cashSession.id),
    businessDate: text('business_date').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    reference: text('reference'),
    note: text('note'),
    ...stamps(),
  },
  (t) => [
    check('receipt_kind', oneOf('kind', RECEIPT_KINDS)),
    check('receipt_method', oneOf('method', PAYMENT_METHODS)),
    check('receipt_payer_type', oneOf('payer_type', PAYER_TYPES)),
    check(
      'receipt_reversal_shape',
      sql`("kind" = 'reversal') = ("reverses_id" IS NOT NULL AND "amount" < 0)`,
    ),
    check('receipt_positive', sql`"kind" = 'reversal' OR "amount" > 0`),
    index('receipt_payer').on(t.payerId),
  ],
);

export const receiptAllocation = sqliteTable(
  'receipt_allocation',
  {
    receiptId: text('receipt_id')
      .notNull()
      .references(() => receipt.id),
    chargeId: text('charge_id')
      .notNull()
      .references(() => charge.id),
    amount: paisa('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.receiptId, t.chargeId] }),
    index('receipt_allocation_charge').on(t.chargeId),
  ],
);

export const transfer = sqliteTable(
  'transfer',
  {
    id: id(),
    fromAccount: text('from_account')
      .notNull()
      .references(() => account.id),
    toAccount: text('to_account')
      .notNull()
      .references(() => account.id),
    amount: paisa('amount').notNull(),
    date: text('date').notNull(),
    note: text('note'),
    ...stamps(),
  },
  () => [
    check('transfer_amount', sql`"amount" > 0`),
    check('transfer_distinct', sql`"from_account" <> "to_account"`),
  ],
);

/** Not in PLAN §5.2, which references `category_id` without defining the table. */
export const expenseCategory = sqliteTable('expense_category', {
  id: id(),
  name: text('name').notNull().unique(),
  deletedAt: text('deleted_at'),
  ...stamps(),
});

export const expense = sqliteTable(
  'expense',
  {
    id: id(),
    expenseNo: text('expense_no').notNull().unique(),
    categoryId: text('category_id')
      .notNull()
      .references(() => expenseCategory.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    cashSessionId: text('cash_session_id').references(() => cashSession.id),
    amount: paisa('amount').notNull(),
    vendor: text('vendor'),
    date: text('date').notNull(),
    note: text('note'),
    voidedBy: text('voided_by').references(() => user.id),
    voidReason: text('void_reason'),
    ...stamps(),
  },
  () => [check('expense_amount', sql`"amount" > 0`)],
);

export const PAYSLIP_STATUSES = ['draft', 'approved', 'paid'] as const;

export const payslip = sqliteTable(
  'payslip',
  {
    id: id(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    periodKey: text('period_key').notNull(),
    status: text('status', { enum: PAYSLIP_STATUSES }).notNull().default('draft'),
    approvedBy: text('approved_by').references(() => user.id),
    ...stamps(),
  },
  (t) => [
    unique('payslip_once').on(t.staffId, t.periodKey),
    check('payslip_status', oneOf('status', PAYSLIP_STATUSES)),
  ],
);

export const PAYSLIP_LINE_KINDS = ['basic', 'allowance', 'deduction', 'advance_recovery'] as const;

export const payslipLine = sqliteTable(
  'payslip_line',
  {
    id: id(),
    payslipId: text('payslip_id')
      .notNull()
      .references(() => payslip.id),
    kind: text('kind', { enum: PAYSLIP_LINE_KINDS }).notNull(),
    amount: paisa('amount').notNull(),
    note: text('note'),
    ...stamps(),
  },
  () => [check('payslip_line_kind', oneOf('kind', PAYSLIP_LINE_KINDS))],
);

/** A receivable, not an expense: recovered through payslip lines. */
export const staffAdvance = sqliteTable(
  'staff_advance',
  {
    id: id(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id),
    amount: paisa('amount').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    date: text('date').notNull(),
    ...stamps(),
  },
  () => [check('staff_advance_amount', sql`"amount" > 0`)],
);

export const salaryPayment = sqliteTable(
  'salary_payment',
  {
    id: id(),
    payslipId: text('payslip_id')
      .notNull()
      .references(() => payslip.id),
    amount: paisa('amount').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    date: text('date').notNull(),
    ...stamps(),
  },
  () => [check('salary_payment_amount', sql`"amount" > 0`)],
);

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
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { enrolment, grp, programme, staff, student } from './academic';
import { user } from './auth';
import { bool, id, integerMoney, oneOf, paisa, stamps } from './common';

// Append-only rules, allocation invariants and the charge views live in ../../sql (Drizzle cannot express
// them). Row-local rules (kind signs, integer money, reversal shape) are CHECKs here. See ADR 0002.

export const FEE_HEAD_KINDS = ['admission', 'tuition', 'exam', 'course', 'misc', 'fine'] as const;
export const FEE_CADENCES = ['monthly', 'once', 'per_term'] as const;

export const feeHead = sqliteTable(
  'fee_head',
  {
    id: id(),
    name: text('name').notNull(),
    /** Printed on Urdu receipts and the parent page. */
    nameUr: text('name_ur'),
    kind: text('kind', { enum: FEE_HEAD_KINDS }).notNull(),
    cadence: text('cadence', { enum: FEE_CADENCES }).notNull(),
    /** Archived heads are never generated again; their old charges stay (FK). */
    archivedAt: text('archived_at'),
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
    integerMoney('fee_rate', 'amount'),
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
    integerMoney('concession', 'value'),
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

/** One row per billed period (the run header); per-chunk counts and the cron cursor live in billing_chunk. */
export const billingRun = sqliteTable('billing_run', {
  id: id(),
  periodKey: text('period_key').notNull().unique(),
  runAt: text('run_at').notNull(),
  runBy: text('run_by').references(() => user.id),
  note: text('note'),
  ...stamps(),
});

export const BILLING_CHUNK_KINDS = ['fees', 'fines'] as const;

/**
 * Append-only log of one generation or fine request (PLAN §5.2 "billing_run per (period, scope)"):
 * billing_run.period_key is UNIQUE and append-only, so the per-scope rows live here. `grp_id` +
 * `next_student_id` are the cursor of a chunked group (NULL next = the group is done); `student_id`
 * marks a single-student run (admission, regenerate). Counts are of rows actually inserted.
 */
export const billingChunk = sqliteTable(
  'billing_chunk',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => billingRun.id),
    kind: text('kind', { enum: BILLING_CHUNK_KINDS }).notNull(),
    grpId: text('grp_id').references(() => grp.id),
    studentId: text('student_id').references(() => student.id),
    nextStudentId: text('next_student_id'),
    done: integer('done').notNull().default(1),
    fees: integer('fees').notNull().default(0),
    concessions: integer('concessions').notNull().default(0),
    sponsored: integer('sponsored').notNull().default(0),
    fines: integer('fines').notNull().default(0),
    allocations: integer('allocations').notNull().default(0),
    /**
     * 'ok' or 'failed' (checked by a trigger in sql/50_fees.sql, not a CHECK, so the column could be
     * added without a rebuild). A failed chunk wrote nothing else; it is retried on the next tick.
     */
    status: text('status').notNull().default('ok'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /**
     * Cron backoff (M3a closing pass), on failed rows only: consecutive failures of this group for
     * the period, including this one, and the earliest instant (ISO, UTC) the cron retries it. Three
     * in a row = `attention_required` (GET /api/fees/runs, dashboard `billing_alerts`).
     */
    failStreak: integer('fail_streak').notNull().default(0),
    retryAfter: text('retry_after'),
    ...stamps(),
  },
  (t) => [
    check('billing_chunk_kind', oneOf('kind', BILLING_CHUNK_KINDS)),
    index('billing_chunk_run').on(t.runId, t.kind, t.grpId),
  ],
);

export const PAYER_TYPES = ['family', 'sponsor'] as const;
export const CHARGE_KINDS = ['fee', 'concession', 'fine', 'fine_waiver', 'reversal'] as const;

/**
 * Signed amount. Only `fee` rows are roots (`parent_charge_id` NULL). Concession, fine and reversal
 * lines hang off a fee; a fine_waiver (or a reversal of a fine) hangs off the fine. The whole tree
 * (depth <= 2) folds into the root's net (charge_net view). `payer_id` is polymorphic.
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
    // Only fees are roots; fines always hang off the fee they penalise.
    check('charge_root_kind', sql`("kind" = 'fee') = ("parent_charge_id" IS NULL)`),
    // A credit can never hide as a fee, and a concession can never raise a net.
    check(
      'charge_kind_sign',
      sql`("kind" IN ('fee','fine') AND "amount" > 0) OR ("kind" IN ('concession','fine_waiver','reversal') AND "amount" < 0)`,
    ),
    check(
      'charge_reason',
      sql`"kind" NOT IN ('reversal','fine_waiver') OR length(trim(coalesce("reason", ''))) > 0`,
    ),
    integerMoney('charge', 'amount'),
    index('charge_payer').on(t.payerType, t.payerId),
    index('charge_parent').on(t.parentChargeId),
    index('charge_student').on(t.studentId),
    index('charge_enrolment').on(t.enrolmentId),
    index('charge_due_date').on(t.dueDate),
    index('charge_period').on(t.periodKey, t.payerType, t.payerId),
  ],
);

export const openingBalance = sqliteTable(
  'opening_balance',
  {
    studentId: text('student_id')
      .primaryKey()
      .references(() => student.id),
    amount: paisa('amount').notNull(),
    asOf: text('as_of').notNull(),
    note: text('note'),
    ...stamps(),
  },
  () => [integerMoney('opening_balance', 'amount')],
);

export const receiptSeries = sqliteTable(
  'receipt_series',
  {
    series: text('series').notNull(),
    year: integer('year').notNull(),
    nextNo: integer('next_no').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.series, t.year] }),
    check('receipt_series_next_no', sql`typeof("next_no") = 'integer' AND "next_no" >= 1`),
  ],
);

export const ACCOUNT_KINDS = ['cash', 'bank', 'wallet'] as const;

export const account = sqliteTable(
  'account',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ACCOUNT_KINDS }).notNull(),
    holderStaffId: text('holder_staff_id').references(() => staff.id),
    /**
     * Pre-pilot carry-in (M4 fix pass): the money in the account at the start of `opening_as_of`.
     * Set once, by an owner, before the account has any movement (sql/60_money_out.sql freezes it);
     * balances and the cashbook start from it (a `money_movement` row of kind 'opening').
     */
    openingBalance: integer('opening_balance').notNull().default(0),
    openingAsOf: text('opening_as_of'),
    ...stamps(),
  },
  () => [check('account_kind', oneOf('kind', ACCOUNT_KINDS))],
);

/**
 * Opening/expected/counted are paisa; variance is derived. Once closed the row is frozen except for
 * an owner/admin reopen (closed_at back to NULL with reopened_by/at and a new reason); closing clears
 * reopened_by/at — sql/20_append_only.sql.
 */
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
    variance: paisa('variance').generatedAlwaysAs(sql`"counted" - "expected"`, { mode: 'virtual' }),
    closedAt: text('closed_at'),
    closedBy: text('closed_by').references(() => user.id),
    reopenedBy: text('reopened_by').references(() => user.id),
    reopenedAt: text('reopened_at'),
    reopenReason: text('reopen_reason'),
    ...stamps(),
  },
  (t) => [
    unique('cash_session_once').on(t.collectorId, t.businessDate),
    integerMoney('cash_session', 'opening'),
    integerMoney('cash_session', 'expected', true),
    integerMoney('cash_session', 'counted', true),
    check(
      'cash_session_closed_shape',
      sql`"closed_at" IS NULL OR ("closed_by" IS NOT NULL AND "counted" IS NOT NULL AND "expected" IS NOT NULL)`,
    ),
  ],
);

/**
 * Final before the pilot (PLAN §15 enum rule). `opening` = go-live carry-in credit (a negative
 * opening balance): payer credit like a payment, but no money moved — no series number, no cash
 * session, never income, never reversible.
 */
export const RECEIPT_KINDS = ['payment', 'reversal', 'refund', 'opening'] as const;
export const PAYMENT_METHODS = [
  'cash',
  'bank',
  'jazzcash',
  'easypaisa',
  'cheque',
  'other',
] as const;

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
    // payment: money in. reversal: exact negative mirror of one payment. refund: money out of credit.
    check(
      'receipt_kind_shape',
      sql`CASE "kind" WHEN 'payment' THEN "amount" > 0 AND "reverses_id" IS NULL WHEN 'opening' THEN "amount" > 0 AND "reverses_id" IS NULL AND "cash_session_id" IS NULL WHEN 'reversal' THEN "amount" < 0 AND "reverses_id" IS NOT NULL WHEN 'refund' THEN "amount" < 0 AND "reverses_id" IS NULL ELSE 0 END`,
    ),
    integerMoney('receipt', 'amount'),
    index('receipt_payer').on(t.payerType, t.payerId),
    index('receipt_day_collector').on(t.businessDate, t.collectorId),
  ],
);

/**
 * Append-only rows; several rows per (receipt, charge) pair are allowed so a later concession can
 * *release* part of an allocation (negative row on the same pair). The pair's running sum is what
 * counts: >= 0 for payments, within the original's pair sum for reversals (sql/30_ledger.sql).
 * `id` is minted by the caller (ULID) so a retried "apply credit" is a no-op (ledger/allocate).
 */
export const receiptAllocation = sqliteTable(
  'receipt_allocation',
  {
    id: id(),
    receiptId: text('receipt_id')
      .notNull()
      .references(() => receipt.id),
    chargeId: text('charge_id')
      .notNull()
      .references(() => charge.id),
    amount: paisa('amount').notNull(),
  },
  (t) => [
    index('receipt_allocation_pair').on(t.receiptId, t.chargeId),
    index('receipt_allocation_charge').on(t.chargeId),
    check('receipt_allocation_nonzero', sql`"amount" <> 0`),
    integerMoney('receipt_allocation', 'amount'),
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
    /** The drawer session a handover came out of; a closed session takes no new rows. */
    cashSessionId: text('cash_session_id').references(() => cashSession.id),
    amount: paisa('amount').notNull(),
    date: text('date').notNull(),
    note: text('note'),
    ...stamps(),
  },
  () => [
    check('transfer_amount', sql`"amount" > 0`),
    check('transfer_distinct', sql`"from_account" <> "to_account"`),
    integerMoney('transfer', 'amount'),
  ],
);

/**
 * Not in PLAN §5.2, which references `category_id` without defining the table. The M4 list is seeded
 * by migration 0014 with stable `code`s; `system` rows (salaries) are reserved for reports and never
 * offered when recording an expense (salaries are payslips, not expenses).
 */
export const expenseCategory = sqliteTable(
  'expense_category',
  {
    id: id(),
    name: text('name').notNull().unique(),
    nameUr: text('name_ur'),
    code: text('code'),
    system: bool('system').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    deletedAt: text('deleted_at'),
    ...stamps(),
  },
  (t) => [uniqueIndex('expense_category_code').on(t.code)],
);

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
    /** R2 key of the bill photo (optional; uploaded after the expense exists). */
    receiptKey: text('receipt_key'),
    ...stamps(),
  },
  (t) => [
    index('expense_date').on(t.date),
    index('expense_session').on(t.cashSessionId),
    check('expense_amount', sql`"amount" > 0`),
    integerMoney('expense', 'amount'),
    // A void always says why (PLAN §14.8); a reason without a voider is meaningless.
    check(
      'expense_void_reason',
      sql`("voided_by" IS NULL) = (length(trim(coalesce("void_reason", ''))) = 0)`,
    ),
  ],
);

/** 'void' (M3 fix pass, last enum pass before the pilot): a draft or approved slip that is never paid. */
export const PAYSLIP_STATUSES = ['draft', 'approved', 'paid', 'void'] as const;

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
    approvedAt: text('approved_at'),
    /** A void says who and why (sql/60_payroll.sql); only before any salary payment. */
    voidedBy: text('voided_by').references(() => user.id),
    voidReason: text('void_reason'),
    ...stamps(),
  },
  (t) => [
    unique('payslip_once').on(t.staffId, t.periodKey),
    check('payslip_status', oneOf('status', PAYSLIP_STATUSES)),
    check('payslip_approved_by', sql`"status" IN ('draft', 'void') OR "approved_by" IS NOT NULL`),
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
  () => [
    check('payslip_line_kind', oneOf('kind', PAYSLIP_LINE_KINDS)),
    // Positive; the kind gives the sign (deduction and advance_recovery subtract from the net).
    check('payslip_line_amount', sql`"amount" > 0`),
    integerMoney('payslip_line', 'amount'),
  ],
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
    /** Set when paid out of a drawer (a cash account): the payer's session that day. */
    cashSessionId: text('cash_session_id').references(() => cashSession.id),
    date: text('date').notNull(),
    note: text('note'),
    ...stamps(),
  },
  (t) => [
    check('staff_advance_amount', sql`"amount" > 0`),
    integerMoney('staff_advance', 'amount'),
    index('staff_advance_staff').on(t.staffId),
    index('staff_advance_session').on(t.cashSessionId),
  ],
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
    /** Set when paid out of a drawer (a cash account): the payer's session that day. */
    cashSessionId: text('cash_session_id').references(() => cashSession.id),
    date: text('date').notNull(),
    note: text('note'),
    ...stamps(),
  },
  (t) => [
    check('salary_payment_amount', sql`"amount" > 0`),
    integerMoney('salary_payment', 'amount'),
    index('salary_payment_slip').on(t.payslipId),
    index('salary_payment_session').on(t.cashSessionId),
  ],
);

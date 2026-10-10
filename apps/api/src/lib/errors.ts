import { FeeError, LedgerError } from '@maktab/db';
import type { ApiErrorBody } from '@maktab/shared';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errorBody = (code: string, message: string): ApiErrorBody => ({
  error: { code, message },
});

/**
 * Constraint violations the schema raises on purpose (partial unique indexes, RAISE(ABORT)
 * triggers), mapped to clean 409s. Matched on message text through the cause chain: D1 and
 * better-sqlite3 both carry SQLite's text, drizzle wraps it as `cause` (PLAN §12 exp1).
 */
const DB_CONFLICTS: [RegExp, string, string][] = [
  [/last_owner/, 'last_owner', 'At least one active owner must remain'],
  // Ledger triggers (sql/30_ledger.sql, 20_append_only.sql, 50_fees.sql): the batch rolled back.
  [/cash session is closed/, 'session_closed', 'The cash session is closed'],
  [
    /allocation exceeds charge net|net would fall below allocated/,
    'stale_dues',
    'Dues changed while saving; reload and try again',
  ],
  [
    /refund exceeds unallocated credit|allocation exceeds payer credit|reversal would leave negative payer credit/,
    'exceeds_credit',
    'Not enough unallocated credit',
  ],
  [
    /receipt has been reversed|UNIQUE constraint failed: receipt\.reverses_id/,
    'already_reversed',
    'This receipt has already been reversed',
  ],
  [
    /UNIQUE constraint failed: opening_balance/,
    'already_recorded',
    'Opening balance already recorded',
  ],
  [/line exceeds remaining net/, 'exceeds_net', 'More than what is left on this fee'],
  [/already ended/, 'already_ended', 'Already ended'],
  [
    /sponsorship overlaps another/,
    'sponsorship_overlap',
    'This sponsor already covers this student for these dates; end that sponsorship first',
  ],
  [/cash_session is closed; only a reopen/, 'session_closed', 'The cash session is closed'],
  // Money out (sql/60_money_out.sql, 20_append_only.sql payroll rules).
  [
    /cannot be approved by its own staff member/,
    'own_payslip',
    'Someone else must approve your own payslip',
  ],
  [/payslip net is negative/, 'negative_net', 'Deductions and recovery exceed the pay'],
  [
    /advance recovery exceeds outstanding advance/,
    'recovery_exceeds_advance',
    'Advance recovery is more than the advance still outstanding',
  ],
  [
    /salary payments exceed payslip net/,
    'exceeds_net',
    'More than what is left to pay on this payslip',
  ],
  [/payslip is not approved/, 'not_approved', 'Approve the payslip first'],
  [
    /a paid payslip cannot be voided/,
    'not_voidable',
    'A payslip with salary paid cannot be voided',
  ],
  [/lines are frozen/, 'not_draft', 'Only a draft payslip can be changed'],
  [
    /expense category is reserved/,
    'category_reserved',
    'Salaries are recorded as payslips, not expenses',
  ],
  [/expense already voided/, 'already_void', 'This expense is already void'],
  [
    /UNIQUE constraint failed: payslip\.staff_id/,
    'already_exists',
    'A payslip for this month already exists',
  ],
  [/reopen reason must differ/, 'reason_repeated', 'Give a new reason for this reopen'],
  [
    /UNIQUE constraint failed: enrolment\.student_id/,
    'already_enrolled',
    'The student already has an active class enrolment; end or transfer it first',
  ],
  [/UNIQUE constraint failed: enrolment\.grp_id/, 'roll_no_taken', 'Roll number already used'],
  [
    /UNIQUE constraint failed: student\.admission_no/,
    'admission_no_taken',
    'Admission number already used',
  ],
  [/UNIQUE constraint failed: user\.email/, 'email_taken', 'This email is already invited'],
  [/UNIQUE constraint failed: custom_field/, 'key_taken', 'A field with this key exists'],
  [/UNIQUE constraint failed: grp_subject/, 'duplicate_subject', 'Subject listed twice'],
  [/FOREIGN KEY constraint failed/, 'in_use', 'Referenced by other records'],
  [/UNIQUE constraint failed/, 'conflict', 'Already exists'],
];

export function dbConflict(err: unknown): ApiError | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const message = e instanceof Error ? e.message : String(e);
    for (const [re, code, text] of DB_CONFLICTS)
      if (re.test(message)) return new ApiError(409, code, text);
    e = e instanceof Error ? e.cause : undefined;
  }
  return null;
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
  // Domain refusals from the ledger helpers (@maktab/db): code + status chosen there.
  if (err instanceof FeeError) return c.json(errorBody(err.code, err.message), err.status);
  if (err instanceof LedgerError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'reason_required' ? 400 : 409;
    return c.json(errorBody(err.code, err.message), status);
  }
  const conflict = dbConflict(err);
  if (conflict) return c.json(errorBody(conflict.code, conflict.message), 409);
  if (err instanceof HTTPException) {
    return c.json(errorBody('http_error', err.message || 'Request rejected'), err.status);
  }
  // Details go to the Workers log only; clients never see internals.
  console.error(err);
  return c.json(errorBody('internal', 'Internal error'), 500);
}

export const notFound = (c: Context): Response =>
  c.json(errorBody('not_found', `No route for ${c.req.method} ${c.req.path}`), 404);

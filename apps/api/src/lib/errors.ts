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

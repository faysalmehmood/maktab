import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { auditStatement, FeeError, karachiToday, normaliseReason, runBatch } from './util';

/**
 * Cash sessions (PLAN §14.6): one per collector per business day, opened automatically by the first
 * receipt, closed with a count. Expected cash is derived at close time, inside the closing
 * statement:  opening + Σ cash receipts (payments, reversals, refunds, signed) − Σ non-void
 * expenses paid from the drawer (M4) − Σ handovers/deposits out of the session (transfers).
 * A closed session takes no rows (triggers); only an owner/admin reopen with a new reason.
 */

/** The session id for (collector, day), resolved inside a batch. */
export const sessionIdFor = (collectorId: string, date: string): SQL =>
  sql`(SELECT id FROM cash_session WHERE collector_id = ${collectorId} AND business_date = ${date})`;

/** Opens the session if there is none; a no-op otherwise (a closed one stays closed). */
export const ensureSessionStatement = (
  collectorId: string,
  date: string,
  id = newId(),
  opening = 0,
): SQL =>
  sql`INSERT INTO cash_session (id, collector_id, business_date, opening, created_by)
      SELECT ${id}, ${collectorId}, ${date}, ${opening}, ${collectorId}
      WHERE NOT EXISTS (SELECT 1 FROM cash_session WHERE collector_id = ${collectorId} AND business_date = ${date})`;

export type SessionRow = {
  id: string;
  collector_id: string;
  business_date: string;
  opening: number;
  expected: number | null;
  counted: number | null;
  variance: number | null;
  closed_at: string | null;
  closed_by: string | null;
  reopened_by: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
};

export async function sessionFor(
  db: AppDb,
  collectorId: string,
  date: string,
): Promise<SessionRow | null> {
  const [row] =
    await db.all<SessionRow>(sql`SELECT id, collector_id, business_date, opening, expected,
      counted, variance, closed_at, closed_by, reopened_by, reopened_at, reopen_reason
    FROM cash_session WHERE collector_id = ${collectorId} AND business_date = ${date}`);
  return row ?? null;
}

/** Refuses up front (409) when the collector's day is already closed (the trigger is the backstop). */
export async function assertSessionOpen(
  db: AppDb,
  collectorId: string,
  date: string,
): Promise<void> {
  const s = await sessionFor(db, collectorId, date);
  if (s?.closed_at)
    throw new FeeError(
      'session_closed',
      'Your cash session for this day is closed; ask an admin to reopen it',
    );
}

/** expected = opening + cash in − drawer expenses − handovers, all in this session. */
export const expectedSql = (sessionId: string): SQL => sql`(
  (SELECT opening FROM cash_session WHERE id = ${sessionId})
  + (SELECT coalesce(sum(amount), 0) FROM receipt WHERE cash_session_id = ${sessionId} AND method = 'cash')
  - (SELECT coalesce(sum(amount), 0) FROM expense WHERE cash_session_id = ${sessionId} AND voided_by IS NULL)
  - (SELECT coalesce(sum(amount), 0) FROM transfer WHERE cash_session_id = ${sessionId}))`;

export async function openSession(
  db: AppDb,
  input: { collectorId: string; businessDate: string; opening?: number; id?: string },
): Promise<SessionRow> {
  const opening = input.opening ?? 0;
  if (!Number.isInteger(opening) || opening < 0)
    throw new FeeError('invalid', 'opening: paisa ≥ 0', 400);
  await runBatch(db, [
    ensureSessionStatement(input.collectorId, input.businessDate, input.id ?? newId(), opening),
  ]);
  const s = await sessionFor(db, input.collectorId, input.businessDate);
  if (!s) throw new Error('session not created');
  return s;
}

export async function closeSession(
  db: AppDb,
  input: { sessionId: string; counted: number; by: string; now?: string },
): Promise<SessionRow> {
  if (!Number.isInteger(input.counted) || input.counted < 0)
    throw new FeeError('invalid', 'counted: paisa ≥ 0', 400);
  const [s] = await db.all<SessionRow>(
    sql`SELECT * FROM cash_session WHERE id = ${input.sessionId}`,
  );
  if (!s) throw new FeeError('not_found', 'Cash session not found', 404);
  if (s.closed_at) throw new FeeError('already_closed', 'This session is already closed');
  const now = input.now ?? new Date().toISOString();
  await runBatch(db, [
    sql`UPDATE cash_session SET expected = ${expectedSql(input.sessionId)}, counted = ${input.counted},
          closed_at = ${now}, closed_by = ${input.by}, reopened_by = NULL, reopened_at = NULL
        WHERE id = ${input.sessionId} AND closed_at IS NULL`,
    // Only if this batch did the closing (a concurrent close leaves another closed_at).
    sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
        SELECT ${newId()}, ${input.by}, 'cash_session', id, 'close',
               json_object('expected', expected, 'counted', counted, 'variance', variance)
        FROM cash_session WHERE id = ${input.sessionId} AND closed_at = ${now} AND closed_by = ${input.by}`,
  ]);
  const [after] = await db.all<SessionRow>(
    sql`SELECT * FROM cash_session WHERE id = ${input.sessionId}`,
  );
  if (!after?.closed_at) throw new FeeError('conflict', 'Session could not be closed');
  return after;
}

export async function reopenSession(
  db: AppDb,
  input: { sessionId: string; reason: string; by: string; now?: string },
): Promise<SessionRow> {
  const reason = input.reason.trim().replace(/\s+/g, ' ');
  if (!reason) throw new FeeError('invalid', 'reason: required', 400);
  const [s] = await db.all<SessionRow>(
    sql`SELECT * FROM cash_session WHERE id = ${input.sessionId}`,
  );
  if (!s) throw new FeeError('not_found', 'Cash session not found', 404);
  if (!s.closed_at) throw new FeeError('not_closed', 'This session is open');
  // "Recount" again as " recount  " is the same reason (the trigger compares lower(trim()) too).
  if (s.reopen_reason && normaliseReason(s.reopen_reason) === normaliseReason(reason))
    throw new FeeError('reason_repeated', 'Give a new reason for this reopen', 400);
  const now = input.now ?? new Date().toISOString();
  await runBatch(db, [
    sql`UPDATE cash_session SET closed_at = NULL, reopened_by = ${input.by}, reopened_at = ${now},
          reopen_reason = ${reason}
        WHERE id = ${input.sessionId} AND closed_at IS NOT NULL`,
    sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
        SELECT ${newId()}, ${input.by}, 'cash_session', id, 'reopen',
               json_object('reason', ${reason}, 'was_closed_at', ${s.closed_at},
                           'expected', expected, 'counted', counted)
        FROM cash_session WHERE id = ${input.sessionId} AND reopened_at = ${now} AND reopened_by = ${input.by}`,
  ]);
  const [after] = await db.all<SessionRow>(
    sql`SELECT * FROM cash_session WHERE id = ${input.sessionId}`,
  );
  if (!after) throw new FeeError('not_found', 'Cash session not found', 404);
  return after;
}

/**
 * A handover or bank deposit (never income or expense, PLAN §5.2). Out of a cash account it is
 * taken from the caller's drawer session for that day (opened if needed; refused if closed).
 */
export async function recordTransfer(
  db: AppDb,
  input: {
    id?: string;
    fromAccount: string;
    toAccount: string;
    amount: number;
    date: string;
    note?: string | null;
    by: string;
  },
): Promise<string> {
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new FeeError('invalid', 'amount: paisa > 0', 400);
  if (input.fromAccount === input.toAccount)
    throw new FeeError('invalid', 'to_account: same as from_account', 400);
  const accounts = await db.all<{ id: string; kind: string }>(
    sql`SELECT id, kind FROM account WHERE id IN (${input.fromAccount}, ${input.toAccount})`,
  );
  const from = accounts.find((a) => a.id === input.fromAccount);
  if (!from || !accounts.some((a) => a.id === input.toAccount))
    throw new FeeError('invalid', 'Unknown account', 400);
  const id = input.id ?? newId();
  const fromDrawer = from.kind === 'cash';
  if (fromDrawer) await assertSessionOpen(db, input.by, input.date);
  // Never open a drawer for a past day: a late handover goes into that day's session if it exists.
  if (fromDrawer && input.date < karachiToday() && !(await sessionFor(db, input.by, input.date)))
    throw new FeeError('bad_business_date', 'No cash session that day; record it for today', 400);
  await runBatch(db, [
    ...(fromDrawer ? [ensureSessionStatement(input.by, input.date)] : []),
    sql`INSERT INTO transfer (id, from_account, to_account, cash_session_id, amount, date, note, created_by)
        VALUES (${id}, ${input.fromAccount}, ${input.toAccount},
                ${fromDrawer ? sessionIdFor(input.by, input.date) : null}, ${input.amount}, ${input.date},
                ${input.note ?? null}, ${input.by})`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'transfer',
      entityId: id,
      action: 'create',
      diff: {
        from_account: input.fromAccount,
        to_account: input.toAccount,
        amount: input.amount,
        date: input.date,
        note: input.note ?? null,
      },
    }),
  ]);
  return id;
}

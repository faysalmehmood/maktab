import { newId } from '@maktab/shared';
import { isSQLWrapper, type SQL, sql } from 'drizzle-orm';
import { type AppDb, atomic, rawStatement } from '../client';
import type { PAYER_TYPES, PAYMENT_METHODS } from '../schema';

/**
 * The ledger's write paths (PLAN §5.2, ADR 0002). Each user action is ONE atomic unit (a D1 batch);
 * the triggers in sql/30_ledger.sql refuse anything inconsistent, and these helpers build the only
 * shapes the triggers are designed around — in particular, a reversal is always followed by its
 * unwind allocations in the same batch (the reversal trigger assumes so).
 */

export type PayerType = (typeof PAYER_TYPES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type SeriesKey = { series: string; year: number };

/** `id` is caller-minted (ULID): re-sending the same allocation is a no-op. */
export type AllocationInput = { id: string; chargeId: string; amount: number };

export type NewReceipt = {
  id: string;
  idempotencyKey: string;
  kind?: 'payment' | 'refund';
  payerType: PayerType;
  payerId: string;
  amount: number;
  method: PaymentMethod;
  collectorId: string;
  businessDate: string;
  series: SeriesKey;
  /** An id, or SQL resolving it inside the batch (a session opened by an earlier statement). */
  cashSessionId?: string | SQL | null;
  accountId?: string | null;
  reference?: string | null;
  note?: string | null;
  allocations?: AllocationInput[];
};

export class LedgerError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_a_payment' | 'reason_required' | 'already_reversed',
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const bumpSeries = (s: SeriesKey) =>
  sql`UPDATE receipt_series SET next_no = next_no + 1 WHERE series = ${s.series} AND year = ${s.year}`;

/** A series row for a new year (or prefix) is created on first use, inside the receipt batch. */
export const ensureSeries = (s: SeriesKey) =>
  sql`INSERT INTO receipt_series (series, year, next_no) VALUES (${s.series}, ${s.year}, 1)
      ON CONFLICT (series, year) DO NOTHING`;

const sessionValue = (v: string | SQL | null | undefined) =>
  v == null ? null : isSQLWrapper(v) ? v : sql`${v}`;

/** Numbered from the series row bumped just before, in the same batch. A missing series row makes
 *  receipt_no NULL, so the insert fails (NOT NULL) instead of silently inserting nothing. */
const insertReceipt = (r: {
  id: string;
  kind: 'payment' | 'reversal' | 'refund';
  reversesId: string | null;
  payerType: PayerType;
  payerId: string;
  amount: number;
  method: PaymentMethod;
  collectorId: string;
  businessDate: string;
  idempotencyKey: string;
  series: SeriesKey;
  cashSessionId?: string | SQL | null;
  accountId?: string | null;
  reference?: string | null;
  note?: string | null;
}) => sql`
  INSERT INTO receipt (id, receipt_no, kind, reverses_id, payer_type, payer_id, amount, method, account_id,
                       collector_id, cash_session_id, business_date, idempotency_key, reference, note, created_by)
  VALUES (${r.id},
          (SELECT series || '-' || year || '-' || printf('%05d', next_no - 1) FROM receipt_series
           WHERE series = ${r.series.series} AND year = ${r.series.year}),
          ${r.kind}, ${r.reversesId}, ${r.payerType}, ${r.payerId}, ${r.amount}, ${r.method},
          ${
            r.method === 'cash'
              ? // Cash lands in the drawer of the session's holder, stored now (M4 fix pass, F4).
                sql`(SELECT d.account_id FROM drawer_account d JOIN cash_session s ON s.collector_id = d.user_id
                     WHERE s.id = ${sessionValue(r.cashSessionId)})`
              : (r.accountId ?? null)
          }, ${r.collectorId}, ${sessionValue(r.cashSessionId)}, ${r.businessDate},
          ${r.idempotencyKey}, ${r.reference ?? null}, ${r.note ?? null}, ${r.collectorId})`;

/** Idempotent on `id`: a retried allocation inserts nothing (and so fires no trigger). */
export const allocationStatement = (receiptId: string, a: AllocationInput): SQL => sql`
  INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount)
  SELECT ${a.id}, ${receiptId}, ${a.chargeId}, ${a.amount}
  WHERE NOT EXISTS (SELECT 1 FROM receipt_allocation WHERE id = ${a.id})`;

export function receiptStatements(r: NewReceipt): SQL[] {
  return [
    bumpSeries(r.series),
    insertReceipt({ ...r, kind: r.kind ?? 'payment', reversesId: null }),
    ...(r.allocations ?? []).map((a) => allocationStatement(r.id, a)),
  ];
}

const run = (db: AppDb, stmts: SQL[]) =>
  atomic(db, () => stmts.map((q) => rawStatement(db, q)) as [ReturnType<typeof rawStatement>]);

/** Series bump + numbered receipt + its allocations, as one batch (PLAN §5.2). */
export function createReceipt(db: AppDb, r: NewReceipt): Promise<void> {
  return run(db, receiptStatements(r));
}

/**
 * Applies existing payer credit (or releases, with negative amounts) from one receipt, atomically.
 * Retrying with the same allocation ids is a no-op.
 */
export function allocate(
  db: AppDb,
  receiptId: string,
  allocations: AllocationInput[],
): Promise<void> {
  if (!allocations.length) return Promise.resolve();
  return run(
    db,
    allocations.map((a) => allocationStatement(receiptId, a)),
  );
}

export type ReverseReceiptInput = {
  receiptId: string;
  byUserId: string;
  reason: string;
  series: SeriesKey;
  /** Defaults: a new ULID; `reversal:<receiptId>`; today in Asia/Karachi. */
  reversalId?: string;
  idempotencyKey?: string;
  businessDate?: string;
  cashSessionId?: string | SQL | null;
  /** Statements run first in the same batch (e.g. ensure the series row, open the session). */
  prelude?: SQL[];
  /** The corrected payment, same payer; written in the same batch after the unwinds. */
  reenter?: {
    id?: string;
    idempotencyKey?: string;
    amount: number;
    method?: PaymentMethod;
    accountId?: string | null;
    reference?: string | null;
    allocations?: AllocationInput[];
  };
};

/** "Today" for the school (Asia/Karachi is UTC+5, no DST). */
const karachiToday = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);

/**
 * The single write path for a reversal (PLAN §14.5: reversal + re-entry). One batch:
 *   reversal receipt (−amount, same payer and method)
 *   → one unwind allocation per charge the payment still holds, computed INSIDE the batch from the
 *     payment's live pair sums (so a concurrent allocation can never be missed); unwind ids are
 *     derived as `<reversalId>:<chargeId>` because SQL cannot mint ULIDs
 *   → optional re-entry payment and its allocations
 *   → an audit row with the reason.
 */
export async function reverseReceipt(
  db: AppDb,
  input: ReverseReceiptInput,
): Promise<{ reversalId: string; reentryId: string | null }> {
  const reason = input.reason.trim();
  if (!reason) throw new LedgerError('reason_required', 'a reversal needs a reason');
  const [orig] = await db.all<{
    kind: string;
    payer_type: PayerType;
    payer_id: string;
    amount: number;
    method: PaymentMethod;
    account_id: string | null;
  }>(
    sql`SELECT kind, payer_type, payer_id, amount, method, account_id FROM receipt WHERE id = ${input.receiptId}`,
  );
  if (!orig) throw new LedgerError('not_found', `receipt ${input.receiptId} not found`);
  if (orig.kind !== 'payment')
    throw new LedgerError('not_a_payment', 'only a payment can be reversed');

  const reversalId = input.reversalId ?? newId();
  const businessDate = input.businessDate ?? karachiToday();
  const stmts: SQL[] = [
    ...(input.prelude ?? []),
    bumpSeries(input.series),
    insertReceipt({
      id: reversalId,
      kind: 'reversal',
      reversesId: input.receiptId,
      payerType: orig.payer_type,
      payerId: orig.payer_id,
      amount: -orig.amount,
      method: orig.method,
      collectorId: input.byUserId,
      businessDate,
      idempotencyKey: input.idempotencyKey ?? `reversal:${input.receiptId}`,
      series: input.series,
      // Only cash touches a drawer: a bank/wallet reversal takes no session (and keeps its account).
      cashSessionId: orig.method === 'cash' ? input.cashSessionId : null,
      accountId: orig.method === 'cash' ? null : orig.account_id,
      note: reason,
    }),
    sql`INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount)
        SELECT ${reversalId} || ':' || charge_id, ${reversalId}, charge_id, -sum(amount)
        FROM receipt_allocation WHERE receipt_id = ${input.receiptId}
        GROUP BY charge_id HAVING sum(amount) <> 0`,
  ];

  let reentryId: string | null = null;
  if (input.reenter) {
    const re = input.reenter;
    reentryId = re.id ?? newId();
    const method = re.method ?? orig.method;
    stmts.push(
      ...receiptStatements({
        id: reentryId,
        idempotencyKey: re.idempotencyKey ?? `reentry:${input.receiptId}`,
        payerType: orig.payer_type,
        payerId: orig.payer_id,
        amount: re.amount,
        method,
        accountId:
          method === 'cash'
            ? null
            : (re.accountId ?? (method === orig.method ? orig.account_id : null)),
        reference: re.reference,
        collectorId: input.byUserId,
        businessDate,
        series: input.series,
        cashSessionId: method === 'cash' ? input.cashSessionId : null,
        note: `re-entry for ${input.receiptId}`,
        allocations: re.allocations,
      }),
    );
  }

  const diff = JSON.stringify({ reason, reversal_id: reversalId, reentry_id: reentryId });
  stmts.push(
    sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
        VALUES (${newId()}, ${input.byUserId}, 'receipt', ${input.receiptId}, 'reverse', ${diff})`,
  );
  await run(db, stmts);
  return { reversalId, reentryId };
}

export * from './adjust';
export * from './alloc';
export * from './cash';
export * from './collect';
export * from './concessions';
export * from './cron';
export * from './finance';
export * from './fines';
export * from './generate';
export * from './moneyout';
export * from './opening';
export * from './reports';
export * from './util';

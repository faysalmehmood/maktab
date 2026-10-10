import { duesHash, newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { allocationsStatement, creditSources, oldestFirst, openDues, planCredit } from './alloc';
import { assertSessionOpen, ensureSessionStatement, sessionIdFor } from './cash';
import {
  bumpSeries,
  ensureSeries,
  type PayerType,
  type PaymentMethod,
  receiptStatements,
  type SeriesKey,
} from './index';
import {
  addDays,
  auditStatement,
  DATE_RE,
  errorText,
  FeeError,
  feeSettings,
  karachiToday,
  runBatch,
} from './util';

/**
 * The fee counter's write path (PLAN §14.4). One batch:
 *   series row (created on first use) → for cash, the collector's drawer session for TODAY (opened on
 *   first receipt) → series bump → numbered receipt → allocations (oldest due first across the payer's
 *   roots, or exactly the `directed` rows); the remainder is credit → audit row (receipt_no read back).
 * Non-cash money (bank, wallets, cheque) names its account and never touches a drawer.
 *
 * Business date (M3a closing pass): today. Owner/admin may enter a NON-CASH receipt (bank, wallet,
 * cheque, other) for yesterday, with a reason that is audited — the money landed in an account
 * yesterday. Cash is never backdated: it is counted into today's drawer, so its date is today.
 * Anything else is 400 `bad_business_date`. The series year is never earlier than today's, so
 * numbering never goes back into a closed year.
 *
 * Retries are safe: the idempotency key is unique, and a replay by the same user returns the receipt
 * it created (another user's replay is 409 `idempotency_conflict`). A plan made stale by a concurrent
 * receipt fails on the allocation triggers as a whole batch (nothing written, no number used): with
 * `expectedDueHash` that is 409 `stale_dues`; without it, it is re-planned, at most twice.
 */

export type CollectInput = {
  receiptId?: string;
  payerType: PayerType;
  payerId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string | null;
  accountId?: string | null;
  note?: string | null;
  /** Default `today`. */
  businessDate?: string;
  /** The school day (Asia/Karachi); injectable for tests. */
  today?: string;
  /** The caller is an owner/admin: yesterday is allowed with `backdateReason`. */
  allowYesterday?: boolean;
  backdateReason?: string | null;
  collectorId: string;
  idempotencyKey: string;
  directed?: { chargeId: string; amount: number }[];
  /** duesHash() of the dues the collector saw; a mismatch is 409 stale_dues. */
  expectedDueHash?: string | null;
};

export type CollectResult = { receipt_id: string; replayed: boolean };

/** The receipt series for a business date: its year, but never earlier than today's year. */
export const seriesFor = (prefix: string, businessDate: string, today?: string): SeriesKey => {
  const year = Number(businessDate.slice(0, 4));
  const floor = today ? Number(today.slice(0, 4)) : year;
  return { series: prefix, year: Math.max(year, floor) };
};

/**
 * Today, or (owner/admin, non-cash, with a reason) yesterday; never earlier, never later. Returns
 * whether the date is backdated. Without `allowYesterday` it is today only (refunds).
 */
export function checkBusinessDate(o: {
  businessDate: string;
  today: string;
  allowYesterday?: boolean;
  reason?: string | null;
  method?: PaymentMethod;
}): boolean {
  if (!DATE_RE.test(o.businessDate))
    throw new FeeError('bad_business_date', 'business_date: YYYY-MM-DD', 400);
  if (o.businessDate === o.today) return false;
  if (o.businessDate === addDays(o.today, -1)) {
    if (o.method === 'cash')
      throw new FeeError(
        'bad_business_date',
        'Cash cannot be backdated: it goes into today’s drawer',
        400,
      );
    if (!o.allowYesterday)
      throw new FeeError(
        'bad_business_date',
        'Only an owner or admin can enter a receipt for yesterday',
        400,
      );
    if (!o.reason?.trim())
      throw new FeeError(
        'bad_business_date',
        'A receipt for yesterday needs a reason (backdate_reason)',
        400,
      );
    return true;
  }
  throw new FeeError('bad_business_date', 'business_date must be today (or yesterday)', 400);
}

const STALE = /allocation exceeds charge net|net would fall below allocated/;

async function replay(
  db: AppDb,
  input: {
    idempotencyKey: string;
    payerType: string;
    payerId: string;
    amount: number;
    userId: string;
  },
  kind: 'payment' | 'refund',
): Promise<string | null> {
  const [r] = await db.all<{
    id: string;
    kind: string;
    payer_type: string;
    payer_id: string;
    amount: number;
    collector_id: string;
  }>(
    sql`SELECT id, kind, payer_type, payer_id, amount, collector_id FROM receipt WHERE idempotency_key = ${input.idempotencyKey}`,
  );
  if (!r) return null;
  const amount = kind === 'refund' ? -input.amount : input.amount;
  // Keys are scoped per user: a key is only ever replayed by the user who first sent it.
  if (
    r.collector_id !== input.userId ||
    r.kind !== kind ||
    r.payer_type !== input.payerType ||
    r.payer_id !== input.payerId ||
    r.amount !== amount
  )
    throw new FeeError(
      'idempotency_conflict',
      'This idempotency key was already used for a different receipt',
    );
  return r.id;
}

/** Audit row for a money-in/out receipt, written in its batch; receipt_no is read back from the row. */
const receiptAudit = (o: {
  receiptId: string;
  userId: string;
  action: string;
  extra?: Record<string, unknown>;
}): SQL => sql`INSERT INTO audit (id, user_id, entity, entity_id, action, diff)
  SELECT ${newId()}, ${o.userId}, 'receipt', id, ${o.action},
         json_patch(json_object('receipt_no', receipt_no, 'kind', kind, 'payer_type', payer_type,
                                'payer_id', payer_id, 'amount', amount, 'method', method,
                                'business_date', business_date, 'cash_session_id', cash_session_id),
                    ${JSON.stringify(o.extra ?? {})})
  FROM receipt WHERE id = ${o.receiptId}`;

export async function collect(db: AppDb, input: CollectInput): Promise<CollectResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new FeeError('invalid', 'amount: paisa > 0', 400);
  const today = input.today ?? karachiToday();
  const businessDate = input.businessDate ?? today;
  const prior = await replay(db, { ...input, userId: input.collectorId }, 'payment');
  if (prior) return { receipt_id: prior, replayed: true };
  const backdated = checkBusinessDate({
    businessDate,
    today,
    allowYesterday: input.allowYesterday,
    reason: input.backdateReason,
    method: input.method,
  });
  const cash = input.method === 'cash';
  if (!cash && !input.accountId)
    throw new FeeError(
      'account_required',
      'A non-cash payment needs the account it went into',
      400,
    );
  if (cash) await assertSessionOpen(db, input.collectorId, today);
  const settings = await feeSettings(db);
  const series = seriesFor(settings.receiptPrefix, businessDate, today);
  const receiptId = input.receiptId ?? newId();
  const checkHash = !!input.expectedDueHash && !input.directed?.length;

  for (let attempt = 0; ; attempt++) {
    const dues = await openDues(db, input.payerType, input.payerId);
    if (checkHash && duesHash(dues) !== input.expectedDueHash)
      throw new FeeError('stale_dues', 'Dues changed since you looked; review and try again');
    let rows: { chargeId: string; amount: number }[];
    if (input.directed?.length) {
      const due = new Map(dues.map((d) => [d.id, d.due]));
      const seen = new Set<string>();
      let total = 0;
      for (const d of input.directed) {
        if (!Number.isInteger(d.amount) || d.amount <= 0)
          throw new FeeError('invalid', 'directed.amount: paisa > 0', 400);
        if (seen.has(d.chargeId))
          throw new FeeError('invalid', 'directed: charge listed twice', 400);
        seen.add(d.chargeId);
        const left = due.get(d.chargeId);
        if (left === undefined)
          throw new FeeError('invalid', 'directed: not an open charge of this payer', 400);
        if (d.amount > left) throw new FeeError('exceeds_due', 'directed: more than is due');
        total += d.amount;
      }
      if (total > input.amount)
        throw new FeeError('invalid', 'directed: more than the amount received', 400);
      rows = input.directed;
    } else {
      rows = oldestFirst(dues, input.amount).rows;
    }
    const allocations = rows.map((r) => ({ id: newId(), chargeId: r.chargeId, amount: r.amount }));
    const [bump, insert] = receiptStatements({
      id: receiptId,
      idempotencyKey: input.idempotencyKey,
      payerType: input.payerType,
      payerId: input.payerId,
      amount: input.amount,
      method: input.method,
      collectorId: input.collectorId,
      businessDate,
      series,
      cashSessionId: cash ? sessionIdFor(input.collectorId, today) : null,
      accountId: cash ? null : (input.accountId ?? null),
      reference: input.reference ?? null,
      note: input.note ?? null,
    });
    const alloc = allocationsStatement(allocations.map((a) => ({ ...a, receiptId })));
    const stmts: SQL[] = [
      ensureSeries(series),
      ...(cash ? [ensureSessionStatement(input.collectorId, today)] : []),
      bump as SQL,
      insert as SQL,
      ...(alloc ? [alloc] : []),
      receiptAudit({ receiptId, userId: input.collectorId, action: 'collect' }),
      ...(backdated
        ? [
            receiptAudit({
              receiptId,
              userId: input.collectorId,
              action: 'backdate',
              extra: { reason: input.backdateReason?.trim(), entered_on: today },
            }),
          ]
        : []),
    ];
    try {
      await runBatch(db, stmts);
      return { receipt_id: receiptId, replayed: false };
    } catch (err) {
      const text = errorText(err);
      if (/UNIQUE constraint failed: receipt\.idempotency_key/.test(text)) {
        const again = await replay(db, { ...input, userId: input.collectorId }, 'payment');
        if (again) return { receipt_id: again, replayed: true };
      }
      if (STALE.test(text) && !checkHash && !input.directed?.length && attempt < 2) continue;
      if (STALE.test(text))
        throw new FeeError('stale_dues', 'Dues changed while saving; review and try again');
      throw err;
    }
  }
}

/**
 * Applies a payer's unallocated credit to their open dues, oldest first (PLAN §5.2). Generation
 * calls the same planner for the families it bills; this is the standalone form (e.g. after a
 * concession released money, or a payment made in advance). One batch; ids minted here.
 */
export async function applyCredit(
  db: AppDb,
  input: { payerType: PayerType; payerId: string; period?: string; maxRows?: number },
): Promise<{ allocated: number; rows: number }> {
  const { credit, sources } = await creditSources(db, input.payerType, input.payerId);
  if (credit <= 0) return { allocated: 0, rows: 0 };
  let dues = await openDues(db, input.payerType, input.payerId);
  if (input.period) dues = dues.filter((d) => d.period_key === input.period);
  const plan = planCredit(credit, sources, dues, input.maxRows ?? 200);
  const stmt = allocationsStatement(plan);
  if (!stmt) return { allocated: 0, rows: 0 };
  await runBatch(db, [stmt]);
  return { allocated: plan.reduce((a, p) => a + p.amount, 0), rows: plan.length };
}

/**
 * Credit for several payers after a write that may have released money (regenerate, waiver, void):
 * a second batch in the same request (PLAN §15: never more than two). Best effort per payer — the
 * money is already credit if this fails, and the next generation applies it.
 */
export async function applyCreditFor(
  db: AppDb,
  payers: readonly { payerType: PayerType; payerId: string }[],
): Promise<number> {
  let total = 0;
  const seen = new Set<string>();
  for (const p of payers) {
    const k = `${p.payerType}|${p.payerId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    total += (await applyCredit(db, p)).allocated;
  }
  return total;
}

/**
 * Money paid back out of a payer's credit (PLAN §5.2 "refund from credit only"): a negative
 * receipt with no allocations, numbered like any receipt, dated today only, in the refunder's drawer
 * session when paid in cash, naming its account otherwise. The credit trigger refuses more than the
 * credit; receipt_money_shape (sql/50_fees.sql) refuses a cash refund without a session.
 */
export async function refund(
  db: AppDb,
  input: {
    id?: string;
    payerType: PayerType;
    payerId: string;
    amount: number;
    method: PaymentMethod;
    reason: string;
    by: string;
    businessDate: string;
    idempotencyKey: string;
    reference?: string | null;
    accountId?: string | null;
    /** The school day (Asia/Karachi); injectable for tests. A refund is dated today only. */
    today?: string;
  },
): Promise<CollectResult> {
  const reason = input.reason.trim();
  if (!reason) throw new FeeError('invalid', 'reason: required', 400);
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new FeeError('invalid', 'amount: paisa > 0', 400);
  const prior = await replay(db, { ...input, userId: input.by }, 'refund');
  if (prior) return { receipt_id: prior, replayed: true };
  // Money out is entered the day it goes out: never a past drawer, never a past date.
  const today = input.today ?? karachiToday();
  checkBusinessDate({ businessDate: input.businessDate, today, allowYesterday: true, reason: '-' });
  if (input.businessDate !== today)
    throw new FeeError('bad_business_date', 'business_date must be today for a refund', 400);
  if (input.method !== 'cash' && !input.accountId)
    throw new FeeError(
      'account_required',
      'A non-cash refund needs the account it was paid from',
      400,
    );
  const [c] = await db.all<{ credit: number }>(
    sql`SELECT credit FROM payer_credit WHERE payer_type = ${input.payerType} AND payer_id = ${input.payerId}`,
  );
  if ((c?.credit ?? 0) < input.amount)
    throw new FeeError('exceeds_credit', `Only ${c?.credit ?? 0} paisa of credit is available`);
  const cash = input.method === 'cash';
  if (cash) await assertSessionOpen(db, input.by, input.businessDate);
  const settings = await feeSettings(db);
  const series = seriesFor(settings.receiptPrefix, input.businessDate);
  const id = input.id ?? newId();
  const [, insert] = receiptStatements({
    id,
    kind: 'refund',
    idempotencyKey: input.idempotencyKey,
    payerType: input.payerType,
    payerId: input.payerId,
    amount: -input.amount,
    method: input.method,
    collectorId: input.by,
    businessDate: input.businessDate,
    series,
    cashSessionId: cash ? sessionIdFor(input.by, input.businessDate) : null,
    accountId: cash ? null : (input.accountId ?? null),
    reference: input.reference ?? null,
    note: reason,
  });
  await runBatch(db, [
    ensureSeries(series),
    ...(cash ? [ensureSessionStatement(input.by, input.businessDate)] : []),
    bumpSeries(series),
    insert as SQL,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'receipt',
      entityId: id,
      action: 'refund',
      diff: { payer_type: input.payerType, payer_id: input.payerId, amount: input.amount, reason },
    }),
  ]);
  return { receipt_id: id, replayed: false };
}

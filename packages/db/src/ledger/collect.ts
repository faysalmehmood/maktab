import { newId } from '@maktab/shared';
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
import { auditStatement, DATE_RE, errorText, FeeError, feeSettings, runBatch } from './util';

/**
 * The fee counter's write path (PLAN §14.4). One batch:
 *   series row (created on first use) → collector's cash session for the day (opened on first
 *   receipt) → series bump → numbered receipt → allocations (oldest due first across the payer's
 *   roots, or exactly the `directed` rows); the remainder is credit.
 * Retries are safe: the idempotency key is unique, and a replay returns the receipt it created.
 * A plan made stale by a concurrent receipt fails on the allocation triggers as a whole batch
 * (nothing written, no number used) and is re-planned, at most twice.
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
  businessDate: string;
  collectorId: string;
  idempotencyKey: string;
  directed?: { chargeId: string; amount: number }[];
};

export type CollectResult = { receipt_id: string; replayed: boolean };

export const seriesFor = (prefix: string, businessDate: string): SeriesKey => ({
  series: prefix,
  year: Number(businessDate.slice(0, 4)),
});

const STALE = /allocation exceeds charge net|net would fall below allocated/;

async function replay(
  db: AppDb,
  input: { idempotencyKey: string; payerType: string; payerId: string; amount: number },
  kind: 'payment' | 'refund',
): Promise<string | null> {
  const [r] = await db.all<{
    id: string;
    kind: string;
    payer_type: string;
    payer_id: string;
    amount: number;
  }>(
    sql`SELECT id, kind, payer_type, payer_id, amount FROM receipt WHERE idempotency_key = ${input.idempotencyKey}`,
  );
  if (!r) return null;
  const amount = kind === 'refund' ? -input.amount : input.amount;
  if (
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

export async function collect(db: AppDb, input: CollectInput): Promise<CollectResult> {
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new FeeError('invalid', 'amount: paisa > 0', 400);
  if (!DATE_RE.test(input.businessDate)) throw new FeeError('invalid', 'business_date', 400);
  const prior = await replay(db, input, 'payment');
  if (prior) return { receipt_id: prior, replayed: true };
  await assertSessionOpen(db, input.collectorId, input.businessDate);
  const settings = await feeSettings(db);
  const series = seriesFor(settings.receiptPrefix, input.businessDate);
  const receiptId = input.receiptId ?? newId();

  for (let attempt = 0; ; attempt++) {
    const dues = await openDues(db, input.payerType, input.payerId);
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
      businessDate: input.businessDate,
      series,
      cashSessionId: sessionIdFor(input.collectorId, input.businessDate),
      accountId: input.accountId ?? null,
      reference: input.reference ?? null,
      note: input.note ?? null,
    });
    const alloc = allocationsStatement(allocations.map((a) => ({ ...a, receiptId })));
    const stmts: SQL[] = [
      ensureSeries(series),
      ensureSessionStatement(input.collectorId, input.businessDate),
      bump as SQL,
      insert as SQL,
      ...(alloc ? [alloc] : []),
    ];
    try {
      await runBatch(db, stmts);
      return { receipt_id: receiptId, replayed: false };
    } catch (err) {
      const text = errorText(err);
      if (/UNIQUE constraint failed: receipt\.idempotency_key/.test(text)) {
        const again = await replay(db, input, 'payment');
        if (again) return { receipt_id: again, replayed: true };
      }
      if (STALE.test(text) && !input.directed?.length && attempt < 2) continue;
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
 * Money paid back out of a payer's credit (PLAN §5.2 "refund from credit only"): a negative
 * receipt with no allocations, numbered like any receipt, in the refunder's drawer session when
 * paid in cash. The credit trigger refuses more than the credit.
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
  },
): Promise<CollectResult> {
  const reason = input.reason.trim();
  if (!reason) throw new FeeError('invalid', 'reason: required', 400);
  if (!Number.isInteger(input.amount) || input.amount <= 0)
    throw new FeeError('invalid', 'amount: paisa > 0', 400);
  const prior = await replay(db, input, 'refund');
  if (prior) return { receipt_id: prior, replayed: true };
  const [c] = await db.all<{ credit: number }>(
    sql`SELECT credit FROM payer_credit WHERE payer_type = ${input.payerType} AND payer_id = ${input.payerId}`,
  );
  if ((c?.credit ?? 0) < input.amount)
    throw new FeeError('exceeds_credit', `Only ${c?.credit ?? 0} paisa of credit is available`);
  await assertSessionOpen(db, input.by, input.businessDate);
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
    cashSessionId: sessionIdFor(input.by, input.businessDate),
    reference: input.reference ?? null,
    note: reason,
  });
  await runBatch(db, [
    ensureSeries(series),
    ensureSessionStatement(input.by, input.businessDate),
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

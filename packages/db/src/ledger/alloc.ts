import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import type { AllocationInput, PayerType } from './index';

/**
 * Allocation planning shared by collection, credit application, concessions and waivers. Plans are
 * computed from reads; the triggers in sql/30_ledger.sql re-check every row inside the batch, so a
 * plan made stale by a concurrent write fails as a whole and is re-planned, never half-applied.
 */

export type DueRoot = {
  id: string;
  student_id: string;
  fee_head_id: string;
  period_key: string;
  due_date: string;
  net: number;
  paid: number;
  due: number;
};

/** Oldest due first: due date, period, then student and head for a stable order (PLAN §14.4). */
export async function openDues(
  db: AppDb,
  payerType: PayerType,
  payerId: string,
): Promise<DueRoot[]> {
  return db.all<DueRoot>(sql`
    SELECT cs.id, cs.student_id, cs.fee_head_id, cs.period_key, cs.due_date, cs.net, cs.paid, cs.due
    FROM charge_status cs
    JOIN student st ON st.id = cs.student_id
    JOIN fee_head h ON h.id = cs.fee_head_id
    WHERE cs.payer_type = ${payerType} AND cs.payer_id = ${payerId} AND cs.due > 0
    ORDER BY cs.due_date, cs.period_key, st.name, st.id, h.name, cs.id`);
}

/** Splits `amount` over dues in order; returns the rows and what is left (credit). */
export function oldestFirst(
  dues: readonly { id: string; due: number }[],
  amount: number,
  limit = Number.POSITIVE_INFINITY,
): { rows: { chargeId: string; amount: number }[]; left: number } {
  const rows: { chargeId: string; amount: number }[] = [];
  let left = amount;
  for (const d of dues) {
    if (left <= 0 || rows.length >= limit) break;
    const take = Math.min(left, d.due);
    if (take <= 0) continue;
    rows.push({ chargeId: d.id, amount: take });
    left -= take;
  }
  return { rows, left };
}

export type CreditSource = { id: string; remaining: number };

/**
 * Receipts that still hold unallocated money (payments and opening credit, not reversed), oldest
 * first, and the payer's credit (which a refund may have lowered below their sum).
 */
export async function creditSources(
  db: AppDb,
  payerType: PayerType,
  payerId: string,
): Promise<{ credit: number; sources: CreditSource[] }> {
  const [c] = await db.all<{ credit: number }>(
    sql`SELECT credit FROM payer_credit WHERE payer_type = ${payerType} AND payer_id = ${payerId}`,
  );
  const credit = c?.credit ?? 0;
  if (credit <= 0) return { credit: 0, sources: [] };
  const sources = await db.all<CreditSource>(sql`
    SELECT r.id, r.amount - coalesce((SELECT sum(a.amount) FROM receipt_allocation a WHERE a.receipt_id = r.id), 0) AS remaining
    FROM receipt r
    WHERE r.payer_type = ${payerType} AND r.payer_id = ${payerId} AND r.kind IN ('payment', 'opening')
      AND NOT EXISTS (SELECT 1 FROM receipt v WHERE v.reverses_id = r.id)
      AND r.amount - coalesce((SELECT sum(a.amount) FROM receipt_allocation a WHERE a.receipt_id = r.id), 0) > 0
    ORDER BY r.business_date, r.created_at, r.id`);
  return { credit, sources };
}

/**
 * Spends credit on targets in order: each target is paid from the oldest receipt with money left.
 * Total never exceeds `credit`. Ids are minted here (a retried batch replays the same ids).
 */
export function planCredit(
  credit: number,
  sources: readonly CreditSource[],
  targets: readonly { id: string; due: number }[],
  maxRows: number,
): (AllocationInput & { receiptId: string })[] {
  const out: (AllocationInput & { receiptId: string })[] = [];
  let budget = credit;
  const left = sources.map((s) => ({ ...s }));
  let si = 0;
  for (const t of targets) {
    let need = t.due;
    while (need > 0 && budget > 0 && si < left.length && out.length < maxRows) {
      const s = left[si] as CreditSource;
      const take = Math.min(need, s.remaining, budget);
      if (take > 0) {
        out.push({ id: newId(), receiptId: s.id, chargeId: t.id, amount: take });
        need -= take;
        budget -= take;
        s.remaining -= take;
      }
      if (s.remaining <= 0) si++;
    }
    if (budget <= 0 || si >= left.length || out.length >= maxRows) break;
  }
  return out;
}

/**
 * Release rows that take `amount` back off a root (latest unreversed payment first), so a
 * concession or waiver can lower the root's net below what was paid (ADR 0002: release first, in
 * the same batch). The released money becomes payer credit.
 */
export async function planRelease(
  db: AppDb,
  rootId: string,
  amount: number,
): Promise<(AllocationInput & { receiptId: string })[]> {
  if (amount <= 0) return [];
  const pairs = await db.all<{ receipt_id: string; pair: number }>(sql`
    SELECT a.receipt_id, sum(a.amount) AS pair
    FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
    WHERE a.charge_id = ${rootId} AND r.kind IN ('payment', 'opening')
      AND NOT EXISTS (SELECT 1 FROM receipt v WHERE v.reverses_id = r.id)
    GROUP BY a.receipt_id HAVING sum(a.amount) > 0
    ORDER BY max(r.business_date) DESC, max(r.created_at) DESC, a.receipt_id DESC`);
  const out: (AllocationInput & { receiptId: string })[] = [];
  let need = amount;
  for (const p of pairs) {
    if (need <= 0) break;
    const take = Math.min(need, p.pair);
    out.push({ id: newId(), receiptId: p.receipt_id, chargeId: rootId, amount: -take });
    need -= take;
  }
  if (need > 0) throw new Error(`cannot release ${amount} from ${rootId}`);
  return out;
}

/**
 * Inserts allocation rows from one JSON parameter. Idempotent on the row id; with
 * `ifChargeExists`, rows whose charge was not inserted earlier in the batch are skipped (a root
 * that a concurrent run had already billed).
 */
export function allocationsStatement(
  rows: readonly (AllocationInput & { receiptId: string })[],
  ifChargeExists = false,
): SQL | null {
  if (!rows.length) return null;
  const json = JSON.stringify(
    rows.map((r) => ({ id: r.id, r: r.receiptId, c: r.chargeId, a: r.amount })),
  );
  return sql`INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount)
    SELECT j.id, j.r, j.c, j.a
    FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.r') AS r,
                 json_extract(value, '$.c') AS c, json_extract(value, '$.a') AS a
          FROM json_each(${json})) j
    WHERE NOT EXISTS (SELECT 1 FROM receipt_allocation x WHERE x.id = j.id)
      ${ifChargeExists ? sql`AND EXISTS (SELECT 1 FROM charge c WHERE c.id = j.c)` : sql``}`;
}

/**
 * Open dues as they will be once `receiptId` is reversed (its live pair sums put back), oldest
 * first — the plan for a "re-enter correctly" payment written in the same batch as the reversal.
 */
export async function duesAfterUnwind(
  db: AppDb,
  payerType: PayerType,
  payerId: string,
  receiptId: string,
): Promise<DueRoot[]> {
  return db.all<DueRoot>(sql`
    SELECT cs.id, cs.student_id, cs.fee_head_id, cs.period_key, cs.due_date, cs.net,
           cs.paid - coalesce(u.held, 0) AS paid, cs.due + coalesce(u.held, 0) AS due
    FROM charge_status cs
    JOIN student st ON st.id = cs.student_id
    JOIN fee_head h ON h.id = cs.fee_head_id
    LEFT JOIN (SELECT charge_id, sum(amount) AS held FROM receipt_allocation
               WHERE receipt_id = ${receiptId} GROUP BY charge_id) u ON u.charge_id = cs.id
    WHERE cs.payer_type = ${payerType} AND cs.payer_id = ${payerId} AND cs.due + coalesce(u.held, 0) > 0
    ORDER BY cs.due_date, cs.period_key, st.name, st.id, h.name, cs.id`);
}

import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { allocationsStatement, planRelease } from './alloc';
import { applyCredit } from './collect';
import type { PayerType } from './index';
import { auditStatement, FeeError, runBatch } from './util';

/**
 * Voiding a charge (PLAN §14.5; M3a closing pass): charges are never edited or deleted, so a charge
 * billed by mistake (wrong head, a student who never came) is zeroed by a `reversal` line under it,
 * with a reason.
 *
 * A fee is voided as its whole billing unit — (student, fee head, period): the family root AND every
 * sponsor root, each reversed whole (fines with it: net → 0), in ONE batch. Voiding one root of a
 * sponsored unit would leave the sponsor billed for a fee that no longer exists, so a partial void is
 * impossible by construction. If any root of the unit is already voided, the whole request is
 * `already_void`. A fine on its own is voided for what is left of it.
 *
 * Money already allocated to a voided root is released first in the same batch (it becomes that
 * payer's credit) and the credit is then applied to each payer's other dues in a follow-up batch.
 */
type VoidTarget = { id: string; payer_type: PayerType; payer_id: string; left: number };

export async function voidCharge(
  db: AppDb,
  input: { chargeId: string; reason: string; by: string; reversalId?: string },
): Promise<{
  reversal_id: string;
  charge_id: string;
  amount: number;
  released: number;
  credit_applied: number;
  voided: { charge_id: string; reversal_id: string; amount: number; released: number }[];
}> {
  const reason = input.reason.trim();
  if (!reason) throw new FeeError('invalid', 'reason: required', 400);
  const left = (alias: string) =>
    sql.raw(`(SELECT coalesce(sum(x.amount), 0) FROM charge x
       WHERE x.id = ${alias}.id OR x.parent_charge_id = ${alias}.id
          OR x.parent_charge_id IN (SELECT y.id FROM charge y WHERE y.parent_charge_id = ${alias}.id))`);
  const [c] = await db.all<{
    id: string;
    kind: string;
    parent_charge_id: string | null;
    student_id: string;
    fee_head_id: string;
    period_key: string;
    payer_type: PayerType;
    payer_id: string;
    /** what is left on this line's own subtree */
    left: number;
  }>(sql`SELECT c.id, c.kind, c.parent_charge_id, c.student_id, c.fee_head_id, c.period_key,
      c.payer_type, c.payer_id, ${left('c')} AS left
    FROM charge c WHERE c.id = ${input.chargeId}`);
  if (!c) throw new FeeError('not_found', 'Charge not found', 404);
  const isRoot = c.kind === 'fee' && c.parent_charge_id === null;
  if (!isRoot && c.kind !== 'fine')
    throw new FeeError('not_voidable', 'Only a fee or a fine can be voided');

  let targets: VoidTarget[];
  if (isRoot) {
    const roots = await db.all<VoidTarget & { voided: number }>(sql`
      SELECT r.id, r.payer_type, r.payer_id, ${left('r')} AS left,
        EXISTS (SELECT 1 FROM charge v WHERE v.parent_charge_id = r.id AND v.kind = 'reversal'
                  AND v.reason LIKE 'void:%') AS voided
      FROM charge r
      WHERE r.kind = 'fee' AND r.parent_charge_id IS NULL AND r.student_id = ${c.student_id}
        AND r.fee_head_id = ${c.fee_head_id} AND r.period_key = ${c.period_key}
      ORDER BY r.payer_type = 'sponsor', r.created_at, r.id`);
    if (roots.some((r) => r.voided) || !roots.some((r) => r.left > 0))
      throw new FeeError('already_void', 'This fee is already void');
    targets = roots.filter((r) => r.left > 0);
  } else {
    if (c.left <= 0) throw new FeeError('already_void', 'Nothing is left on this charge');
    targets = [c];
  }

  const stmts: SQL[] = [];
  const voided: { charge_id: string; reversal_id: string; amount: number; released: number }[] = [];
  for (const t of targets) {
    const rootId = isRoot ? t.id : (c.parent_charge_id as string);
    const [root] = await db.all<{ net: number; paid: number }>(
      sql`SELECT net, paid FROM charge_net WHERE id = ${rootId}`,
    );
    const release = Math.max(0, (root?.paid ?? 0) - ((root?.net ?? 0) - t.left));
    const rel = allocationsStatement(await planRelease(db, rootId, release));
    if (rel) stmts.push(rel);
    const reversalId = t.id === input.chargeId && input.reversalId ? input.reversalId : newId();
    stmts.push(
      sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id,
            amount, due_date, kind, parent_charge_id, reason, created_by)
          SELECT ${reversalId}, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id,
                 ${-t.left}, due_date, 'reversal', id, ${`void: ${reason}`}, ${input.by}
          FROM charge WHERE id = ${t.id}`,
    );
    voided.push({ charge_id: t.id, reversal_id: reversalId, amount: t.left, released: release });
  }
  stmts.push(
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'charge',
      entityId: c.id,
      action: 'void',
      diff: { reason, voided },
    }),
  );
  await runBatch(db, stmts);
  let applied = 0;
  const seen = new Set<string>();
  for (const t of targets) {
    const k = `${t.payer_type}|${t.payer_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    applied += (await applyCredit(db, { payerType: t.payer_type, payerId: t.payer_id })).allocated;
  }
  const mine = voided.find((v) => v.charge_id === c.id) ?? (voided[0] as (typeof voided)[number]);
  return {
    reversal_id: mine.reversal_id,
    charge_id: c.id,
    amount: voided.reduce((a, v) => a + v.amount, 0),
    released: voided.reduce((a, v) => a + v.released, 0),
    credit_applied: applied,
    voided,
  };
}

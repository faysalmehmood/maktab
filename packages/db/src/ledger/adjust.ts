import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { allocationsStatement, planRelease } from './alloc';
import { applyCredit } from './collect';
import type { PayerType } from './index';
import { auditStatement, FeeError, runBatch } from './util';

/**
 * Voiding a charge (PLAN §14.5, M3 fix pass): charges are never edited or deleted, so a charge billed
 * by mistake (wrong head, a student who never came) is zeroed by a `reversal` line under it, with a
 * reason. A fee root is reversed whole (its fines with it: net → 0); a fine is reversed for what is
 * left of it. If the root is paid beyond its new net, those allocations are released first in the
 * same batch — the money becomes the payer's credit — and the credit is then applied to the payer's
 * other dues in a second batch. Voiding twice is refused (`already_void`).
 */
export async function voidCharge(
  db: AppDb,
  input: { chargeId: string; reason: string; by: string; reversalId?: string },
): Promise<{
  reversal_id: string;
  charge_id: string;
  amount: number;
  released: number;
  credit_applied: number;
}> {
  const reason = input.reason.trim();
  if (!reason) throw new FeeError('invalid', 'reason: required', 400);
  const [c] = await db.all<{
    id: string;
    kind: string;
    parent_charge_id: string | null;
    payer_type: PayerType;
    payer_id: string;
    /** what is left on this line's own subtree */
    left: number;
  }>(sql`SELECT c.id, c.kind, c.parent_charge_id, c.payer_type, c.payer_id,
      (SELECT coalesce(sum(x.amount), 0) FROM charge x
       WHERE x.id = c.id OR x.parent_charge_id = c.id
          OR x.parent_charge_id IN (SELECT y.id FROM charge y WHERE y.parent_charge_id = c.id)) AS left
    FROM charge c WHERE c.id = ${input.chargeId}`);
  if (!c) throw new FeeError('not_found', 'Charge not found', 404);
  const isRoot = c.kind === 'fee' && c.parent_charge_id === null;
  if (!isRoot && c.kind !== 'fine')
    throw new FeeError('not_voidable', 'Only a fee or a fine can be voided');
  if (c.left <= 0) throw new FeeError('already_void', 'Nothing is left on this charge');
  const rootId = isRoot ? c.id : (c.parent_charge_id as string);
  const [root] = await db.all<{ net: number; paid: number }>(
    sql`SELECT net, paid FROM charge_net WHERE id = ${rootId}`,
  );
  const release = Math.max(0, (root?.paid ?? 0) - ((root?.net ?? 0) - c.left));
  const releases = await planRelease(db, rootId, release);
  const reversalId = input.reversalId ?? newId();
  const stmts: SQL[] = [];
  const rel = allocationsStatement(releases);
  if (rel) stmts.push(rel);
  stmts.push(
    sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id,
          amount, due_date, kind, parent_charge_id, reason, created_by)
        SELECT ${reversalId}, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id,
               ${-c.left}, due_date, 'reversal', id, ${`void: ${reason}`}, ${input.by}
        FROM charge WHERE id = ${c.id}`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'charge',
      entityId: c.id,
      action: 'void',
      diff: { reason, amount: c.left, reversal_id: reversalId, released: release },
    }),
  );
  await runBatch(db, stmts);
  const applied = await applyCredit(db, { payerType: c.payer_type, payerId: c.payer_id });
  return {
    reversal_id: reversalId,
    charge_id: c.id,
    amount: c.left,
    released: release,
    credit_applied: applied.allocated,
  };
}

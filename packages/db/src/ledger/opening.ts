import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { auditStatement, DATE_RE, FeeError, periodOf, runBatch } from './util';

/**
 * Go-live carry-in (PLAN §5.2 `opening_balance`, once per student; M1 note: imported enrolments are
 * never backfilled — this is how old dues come in). The `opening_balance` row is the record and the
 * once-guard (its primary key); the money side uses the ledger's own shapes so every report, the
 * counter and the credit rules see it without special cases:
 *   amount > 0 (owed)   → a root `fee` charge on the "Opening balance" head (kind misc, cadence
 *                         once, created on first use), period = as_of's month, due on as_of;
 *                         paid, fined-never (misc), concession-able like any fee.
 *   amount < 0 (credit) → a receipt of kind `opening` for the family: payer credit like an advance
 *                         payment, but no series number, no cash session, never income and never
 *                         reversible (trigger receipt_opening_shape ties it to the opening row).
 *   amount = 0          → the row only (records that the student was checked).
 */

export const OPENING_HEAD_NAME = 'Opening balance';

export async function recordOpeningBalance(
  db: AppDb,
  input: { studentId: string; amount: number; asOf: string; note?: string | null; by: string },
): Promise<{ charge_id: string | null; receipt_id: string | null }> {
  if (!Number.isInteger(input.amount)) throw new FeeError('invalid', 'amount: integer paisa', 400);
  if (!DATE_RE.test(input.asOf)) throw new FeeError('invalid', 'as_of: YYYY-MM-DD', 400);
  const [st] = await db.all<{ id: string; family_id: string; admission_no: string }>(
    sql`SELECT id, family_id, admission_no FROM student WHERE id = ${input.studentId}`,
  );
  if (!st) throw new FeeError('not_found', 'Student not found', 404);
  const [exists] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM opening_balance WHERE student_id = ${input.studentId}`,
  );
  if (exists?.n) throw new FeeError('already_recorded', 'Opening balance already recorded');
  const stmts: SQL[] = [
    sql`INSERT INTO opening_balance (student_id, amount, as_of, note, created_by)
        VALUES (${st.id}, ${input.amount}, ${input.asOf}, ${input.note ?? null}, ${input.by})`,
  ];
  let chargeId: string | null = null;
  let receiptId: string | null = null;
  if (input.amount > 0) {
    chargeId = newId();
    const headId = newId();
    const head = sql`(SELECT id FROM fee_head WHERE kind = 'misc' AND cadence = 'once'
                      AND name = ${OPENING_HEAD_NAME} ORDER BY created_at LIMIT 1)`;
    stmts.push(
      sql`INSERT INTO fee_head (id, name, name_ur, kind, cadence, created_by)
          SELECT ${headId}, ${OPENING_HEAD_NAME}, 'سابقہ بقایا', 'misc', 'once', ${input.by}
          WHERE NOT EXISTS (SELECT 1 FROM fee_head WHERE kind = 'misc' AND cadence = 'once'
                              AND name = ${OPENING_HEAD_NAME})`,
      sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id,
            amount, due_date, kind, reason, created_by)
          VALUES (${chargeId}, ${st.id},
            (SELECT id FROM enrolment WHERE student_id = ${st.id} AND status = 'active'
             ORDER BY is_primary DESC, start_date DESC LIMIT 1),
            ${head}, ${periodOf(input.asOf)}, 'family', ${st.family_id}, ${input.amount}, ${input.asOf},
            'fee', 'opening balance', ${input.by})`,
    );
  } else if (input.amount < 0) {
    receiptId = newId();
    stmts.push(sql`INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method,
          collector_id, business_date, idempotency_key, note, created_by)
        VALUES (${receiptId}, ${`OB-${st.admission_no}`}, 'opening', 'family', ${st.family_id},
          ${-input.amount}, 'cash', ${input.by}, ${input.asOf}, ${`opening:${st.id}`},
          ${input.note ?? 'opening balance'}, ${input.by})`);
  }
  stmts.push(
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'student',
      entityId: st.id,
      action: 'opening_balance',
      diff: {
        amount: input.amount,
        as_of: input.asOf,
        note: input.note ?? null,
        charge_id: chargeId,
        receipt_id: receiptId,
      },
    }),
  );
  await runBatch(db, stmts);
  return { charge_id: chargeId, receipt_id: receiptId };
}

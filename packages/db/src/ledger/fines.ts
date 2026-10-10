import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { allocationsStatement, planRelease } from './alloc';
import { applyCredit } from './collect';
import { chunkLogStatement } from './generate';
import {
  assertPeriod,
  auditStatement,
  FeeError,
  feeSettings,
  periodOf,
  roundRupee,
  runBatch,
} from './util';

/**
 * Late fines (PLAN §5.2, §14.5). After the grace (= due) day, each family tuition root of the period
 * that still has money due gets ONE `fine` child: fixed, or pct of what is still due, capped. The
 * partial unique index charge_fine_once (parent, period) is the backstop; the insert skips roots
 * that already have one, or that were paid off since the plan was read. Sponsor roots are never
 * fined (and the charge trigger refuses a fine on a sponsor root or on a root with nothing due).
 * No fine in the first period of a new enrolment that started after the period's first day (a
 * mid-month joiner is never fined for the month they joined; someone who starts on the 1st has a
 * normal month; a transfer continues its chain and is fined normally after its pushed due date).
 * Chunked: at most `limit` roots per request; `done` says whether any remain.
 *
 * Without `period` (the cron, and POST /api/fees/fines/apply with no period; M3a closing pass) every
 * overdue family tuition root of any period up to `asOf`'s month is considered, oldest due date first:
 * a month-old unpaid fee is fined even if the cron missed its month. Each fine carries its root's
 * period, so charge_fine_once (parent, period) keeps it to one fine per root, whichever path wrote it.
 */

export type PlannedFine = {
  id: string;
  /** The root's period (the fine is filed under it). */
  period_key: string;
  parent_charge_id: string;
  student_id: string;
  fee_head_id: string;
  payer_id: string;
  enrolment_id: string | null;
  due: number;
  amount: number;
};

export type FinesResult = {
  /** The period asked for, or (all periods) asOf's month, which the chunk is logged under. */
  period: string;
  all_periods: boolean;
  as_of: string;
  dry_run: boolean;
  enabled: boolean;
  planned: PlannedFine[];
  applied: number;
  done: boolean;
};

export async function applyLateFines(
  db: AppDb,
  input: {
    /** One period; omit for every overdue root up to asOf's month. */
    period?: string | null;
    asOf: string;
    by: string | null;
    dryRun?: boolean;
    limit?: number;
  },
): Promise<FinesResult> {
  if (input.period) assertPeriod(input.period);
  const logPeriod = input.period || periodOf(input.asOf);
  const limit = Math.min(input.limit ?? 200, 200);
  const settings = await feeSettings(db);
  const rule = settings.fineRule;
  const base = {
    period: logPeriod,
    all_periods: !input.period,
    as_of: input.asOf,
    dry_run: !!input.dryRun,
  };
  if (!rule?.enabled || rule.value <= 0)
    return { ...base, enabled: false, planned: [], applied: 0, done: true };
  const rows = await db.all<Omit<PlannedFine, 'id' | 'amount'>>(sql`
    SELECT cs.id AS parent_charge_id, cs.student_id, cs.fee_head_id, cs.payer_id, c.enrolment_id, cs.due,
           cs.period_key
    FROM charge_status cs JOIN charge c ON c.id = cs.id JOIN fee_head h ON h.id = cs.fee_head_id
    WHERE ${input.period ? sql`cs.period_key = ${input.period}` : sql`cs.period_key <= ${logPeriod}`}
      AND cs.payer_type = 'family' AND h.kind = 'tuition'
      AND cs.due > 0 AND cs.due_date < ${input.asOf}
      AND NOT EXISTS (SELECT 1 FROM enrolment e WHERE e.id = c.enrolment_id AND e.prev_enrolment_id IS NULL
                        AND substr(e.start_date, 1, 7) = cs.period_key AND e.start_date > cs.period_key || '-01')
      AND NOT EXISTS (SELECT 1 FROM charge f WHERE f.parent_charge_id = cs.id AND f.kind = 'fine'
                        AND f.period_key = cs.period_key)
    ORDER BY ${input.period ? sql`` : sql`cs.due_date, `}cs.id LIMIT ${limit + 1}`);
  const done = rows.length <= limit;
  const planned: PlannedFine[] = [];
  for (const r of rows.slice(0, limit)) {
    let amount = rule.type === 'fixed' ? rule.value : roundRupee(r.due * rule.value, 100);
    if (rule.cap != null) amount = Math.min(amount, rule.cap);
    if (amount > 0) planned.push({ ...r, id: newId(), amount });
  }
  if (input.dryRun || !planned.length) return { ...base, enabled: true, planned, applied: 0, done };

  const json = JSON.stringify(
    planned.map((f) => ({
      id: f.id,
      par: f.parent_charge_id,
      s: f.student_id,
      h: f.fee_head_id,
      pi: f.payer_id,
      e: f.enrolment_id,
      a: f.amount,
      pk: f.period_key,
    })),
  );
  // A run header per period touched (old periods may predate the generator) and the log's period.
  const periods = JSON.stringify([...new Set([logPeriod, ...planned.map((f) => f.period_key)])]);
  const stmts: SQL[] = [
    sql`INSERT INTO billing_run (id, period_key, run_at, run_by)
        SELECT ${newId()} || '-' || p.value, p.value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${input.by}
        FROM json_each(${periods}) p
        WHERE NOT EXISTS (SELECT 1 FROM billing_run WHERE period_key = p.value)`,
    sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id,
          amount, due_date, kind, parent_charge_id, reason, run_id, created_by)
        SELECT j.id, j.s, j.e, j.h, j.pk, 'family', j.pi, j.a, ${input.asOf}, 'fine', j.par,
               'late fine', (SELECT id FROM billing_run WHERE period_key = j.pk), ${input.by}
        FROM (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.par') AS par,
                     json_extract(value, '$.s') AS s, json_extract(value, '$.h') AS h,
                     json_extract(value, '$.pi') AS pi, json_extract(value, '$.e') AS e,
                     json_extract(value, '$.a') AS a, json_extract(value, '$.pk') AS pk
              FROM json_each(${json})) j
        WHERE NOT EXISTS (SELECT 1 FROM charge f WHERE f.parent_charge_id = j.par AND f.kind = 'fine'
                            AND f.period_key = j.pk)
          AND (SELECT net - paid FROM charge_net WHERE id = j.par) > 0`,
    chunkLogStatement({
      period: logPeriod,
      kind: 'fines',
      grpId: null,
      studentId: null,
      nextStudentId: null,
      done,
      plan: planned.map((f) => ({ id: f.id, kind: 'fine', payer_type: 'family' })),
      allocationIds: [],
      by: input.by,
    }),
  ];
  await runBatch(db, stmts);
  const [n] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM charge WHERE id IN (SELECT value FROM json_each(${JSON.stringify(planned.map((f) => f.id))}))`,
  );
  return { ...base, enabled: true, planned, applied: n?.n ?? 0, done };
}

/**
 * Waives a fine (all of what is left, or `amount`) with a reason: a `fine_waiver` child of the fine.
 * If the root is paid beyond its new net, the surplus is released first in the same batch, so the
 * money becomes the payer's credit (ADR 0002); that credit is then applied to the payer's other dues
 * in a second batch of the same call.
 */
export async function waiveFine(
  db: AppDb,
  input: { fineId: string; reason: string; by: string; amount?: number; waiverId?: string },
): Promise<{ waiver_id: string; amount: number; released: number; credit_applied: number }> {
  const reason = input.reason.trim();
  if (!reason) throw new FeeError('invalid', 'a waiver needs a reason', 400);
  const [fine] = await db.all<{
    id: string;
    kind: string;
    parent_charge_id: string;
    student_id: string;
    enrolment_id: string | null;
    fee_head_id: string;
    period_key: string;
    payer_type: string;
    payer_id: string;
    left: number;
  }>(sql`SELECT f.id, f.kind, f.parent_charge_id, f.student_id, f.enrolment_id, f.fee_head_id, f.period_key,
            f.payer_type, f.payer_id,
            f.amount + coalesce((SELECT sum(w.amount) FROM charge w WHERE w.parent_charge_id = f.id), 0) AS left
         FROM charge f WHERE f.id = ${input.fineId}`);
  if (fine?.kind !== 'fine') throw new FeeError('not_found', 'Fine not found', 404);
  if (fine.left <= 0) throw new FeeError('already_waived', 'This fine is already waived');
  const amount = input.amount ?? fine.left;
  if (!Number.isInteger(amount) || amount <= 0 || amount > fine.left)
    throw new FeeError('invalid', `amount must be 1..${fine.left}`, 400);
  const [root] = await db.all<{ net: number; paid: number }>(
    sql`SELECT net, paid FROM charge_net WHERE id = ${fine.parent_charge_id}`,
  );
  const release = Math.max(0, (root?.paid ?? 0) - ((root?.net ?? 0) - amount));
  const releases = await planRelease(db, fine.parent_charge_id, release);
  const waiverId = input.waiverId ?? newId();
  const stmts: SQL[] = [];
  const rel = allocationsStatement(releases);
  if (rel) stmts.push(rel);
  stmts.push(
    sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id,
          amount, due_date, kind, parent_charge_id, reason, created_by)
        SELECT ${waiverId}, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id,
               ${-amount}, due_date, 'fine_waiver', id, ${reason}, ${input.by}
        FROM charge WHERE id = ${fine.id}`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'charge',
      entityId: fine.id,
      action: 'waive_fine',
      diff: { reason, amount, waiver_id: waiverId, released: release },
    }),
  );
  await runBatch(db, stmts);
  const applied = await applyCredit(db, {
    payerType: fine.payer_type as 'family' | 'sponsor',
    payerId: fine.payer_id,
  });
  return { waiver_id: waiverId, amount, released: release, credit_applied: applied.allocated };
}

import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { allocationsStatement, planRelease } from './alloc';
import {
  chargeStatements,
  chunkLogStatement,
  type GenCounts,
  loadContext,
  type PlannedCharge,
  planCharges,
  planCreditForFamilies,
  studentEnrolments,
} from './generate';
import type { AllocationInput } from './index';
import {
  assertPeriod,
  auditStatement,
  DATE_RE,
  FeeError,
  feeSettings,
  periodEnd,
  periodStart,
  roundRupee,
  runBatch,
} from './util';

/**
 * Concessions (PLAN §14.7): a plain admin action, never edited — end it and add a new row. A
 * concession with no fee head reduces every tuition head. It takes effect from the next generation;
 * `regenerateForStudent` applies it to a period already billed.
 */

export type ConcessionInput = {
  id?: string;
  studentId: string;
  feeHeadId: string | null;
  type: 'pct' | 'fixed';
  value: number;
  reason: 'sibling' | 'orphan' | 'staff_child' | 'scholarship' | 'topper' | 'needy' | 'other';
  note?: string | null;
  approvedBy: string;
  validFrom: string;
  validTo?: string | null;
};

export function concessionStatement(c: ConcessionInput & { id: string }): SQL {
  return sql`INSERT INTO concession (id, student_id, fee_head_id, type, value, reason, note, approved_by,
      valid_from, valid_to, created_by)
    VALUES (${c.id}, ${c.studentId}, ${c.feeHeadId}, ${c.type}, ${c.value}, ${c.reason}, ${c.note ?? null},
      ${c.approvedBy}, ${c.validFrom}, ${c.validTo ?? null}, ${c.approvedBy})`;
}

function checkConcession(c: ConcessionInput): void {
  if (!Number.isInteger(c.value) || c.value <= 0 || (c.type === 'pct' && c.value > 100))
    throw new FeeError('invalid', 'value: 1–100 for pct, positive paisa for fixed', 400);
  if (!DATE_RE.test(c.validFrom) || (c.validTo && c.validTo < c.validFrom))
    throw new FeeError('invalid', 'valid_to: before valid_from', 400);
}

export async function addConcession(db: AppDb, input: ConcessionInput): Promise<string> {
  checkConcession(input);
  const id = input.id ?? newId();
  await runBatch(db, [
    concessionStatement({ ...input, id }),
    auditStatement({
      id: newId(),
      userId: input.approvedBy,
      entity: 'concession',
      entityId: id,
      action: 'create',
      diff: {
        student_id: input.studentId,
        fee_head_id: input.feeHeadId,
        type: input.type,
        value: input.value,
        reason: input.reason,
        valid_from: input.validFrom,
        valid_to: input.validTo ?? null,
      },
    }),
  ]);
  return id;
}

/** `endedAt` is the end date: periods starting on or after it are no longer reduced. */
export async function endConcession(
  db: AppDb,
  input: { id: string; endedAt: string; reason: string; by: string },
): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new FeeError('invalid', 'reason: required', 400);
  const [c] = await db.all<{ ended_at: string | null; valid_from: string }>(
    sql`SELECT ended_at, valid_from FROM concession WHERE id = ${input.id}`,
  );
  if (!c) throw new FeeError('not_found', 'Concession not found', 404);
  if (c.ended_at) throw new FeeError('already_ended', 'Concession already ended');
  await runBatch(db, [
    sql`UPDATE concession SET ended_at = ${input.endedAt}, ended_by = ${input.by}, end_reason = ${reason}
        WHERE id = ${input.id}`,
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'concession',
      entityId: input.id,
      action: 'end',
      diff: { ended_at: input.endedAt, reason },
    }),
  ]);
}

export type LateConcession = { id: string; root_id: string; concession_id: string; amount: number };

export type RegenerateResult = {
  period: string;
  student_id: string;
  dry_run: boolean;
  planned: PlannedCharge[];
  late_concessions: LateConcession[];
  counts: GenCounts & { late_concessions: number; released: number };
};

/**
 * Re-bills one student for one period (PLAN §14.7 "the current month can be re-generated"):
 * missing units are generated as usual, and every live concession not yet on an existing family
 * root is added to it — after releasing what was paid beyond the new net, so the money becomes
 * credit. Sponsor shares already billed are left as they are (the concession reduces the family's
 * line only, capped at the fee part of its net). One batch; re-running is a no-op.
 */
export async function regenerateForStudent(
  db: AppDb,
  input: { studentId: string; period: string; by: string; dryRun?: boolean; proRata?: boolean },
): Promise<RegenerateResult> {
  assertPeriod(input.period);
  const settings = await feeSettings(db);
  const enrolments = await studentEnrolments(db, input.period, input.studentId);
  const ctx = await loadContext(db, input.period, enrolments, settings);
  const plan = planCharges(ctx, enrolments, { proRata: input.proRata });

  // Existing family roots of this period, with what a late concession is measured against.
  const roots = await db.all<{
    id: string;
    fee_head_id: string;
    head_kind: string;
    amount: number;
    concessions: number;
    sponsored: number;
    net: number;
    paid: number;
    reasons: string | null;
  }>(sql`SELECT c.id, c.fee_head_id, h.kind AS head_kind, c.amount,
      coalesce((SELECT sum(x.amount) FROM charge x WHERE x.parent_charge_id = c.id AND x.kind = 'concession'), 0) AS concessions,
      coalesce((SELECT sum(s.amount) FROM charge s WHERE s.kind = 'fee' AND s.payer_type = 'sponsor'
                AND s.student_id = c.student_id AND s.fee_head_id = c.fee_head_id AND s.period_key = c.period_key), 0) AS sponsored,
      n.net, n.paid,
      (SELECT json_group_array(x.reason) FROM charge x WHERE x.parent_charge_id = c.id AND x.kind = 'concession') AS reasons
    FROM charge c JOIN fee_head h ON h.id = c.fee_head_id JOIN charge_net n ON n.id = c.id
    WHERE c.kind = 'fee' AND c.payer_type = 'family' AND c.student_id = ${input.studentId}
      AND c.period_key = ${input.period}
    ORDER BY c.id`);

  const late: LateConcession[] = [];
  for (const r of roots) {
    const have = new Set<string>(JSON.parse(r.reasons ?? '[]'));
    const gross = r.amount + r.sponsored;
    let feePart = r.amount + r.concessions; // what concessions may still take off this line
    let net = r.net;
    for (const c of ctx.concessions) {
      if (c.student_id !== input.studentId) continue;
      if (c.fee_head_id ? c.fee_head_id !== r.fee_head_id : r.head_kind !== 'tuition') continue;
      if (have.has(`concession:${c.id}`)) continue;
      const want = c.type === 'pct' ? roundRupee(gross * c.value, 100) : c.value;
      const amount = Math.min(want, feePart, net);
      if (amount <= 0) continue;
      late.push({ id: newId(), root_id: r.id, concession_id: c.id, amount });
      feePart -= amount;
      net -= amount;
    }
  }
  // Release, per root, what was paid beyond the new net (all late lines on it together).
  const surplus = new Map<string, number>();
  for (const r of roots) {
    const total = late.filter((l) => l.root_id === r.id).reduce((a, l) => a + l.amount, 0);
    if (total > 0) surplus.set(r.id, Math.max(0, r.paid - (r.net - total)));
  }
  const releases: (AllocationInput & { receiptId: string })[] = [];
  if (!input.dryRun)
    for (const [rootId, need] of surplus) releases.push(...(await planRelease(db, rootId, need)));
  const releasedTotal = [...surplus.values()].reduce((a, n) => a + n, 0);

  const families = [...new Set(enrolments.map((e) => e.family_id))];
  // Credit is applied only to fresh charges when nothing is being reduced: a late concession changes
  // dues the credit planner would read before this batch lowers them.
  const credit =
    input.dryRun || late.length ? [] : await planCreditForFamilies(db, families, plan, 200);
  const result = (counts: RegenerateResult['counts']): RegenerateResult => ({
    period: input.period,
    student_id: input.studentId,
    dry_run: !!input.dryRun,
    planned: plan,
    late_concessions: late,
    counts,
  });
  if (input.dryRun)
    return result({
      fees: plan.filter((c) => c.kind === 'fee' && c.payer_type === 'family').length,
      concessions: plan.filter((c) => c.kind === 'concession').length,
      sponsored: plan.filter((c) => c.kind === 'fee' && c.payer_type === 'sponsor').length,
      allocations: 0,
      late_concessions: late.length,
      released: releasedTotal,
    });

  const stmts: SQL[] = chargeStatements(input.period, plan, input.by);
  if (!stmts.length && late.length)
    stmts.push(sql`INSERT INTO billing_run (id, period_key, run_at, run_by)
      SELECT ${newId()}, ${input.period}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${input.by}
      WHERE NOT EXISTS (SELECT 1 FROM billing_run WHERE period_key = ${input.period})`);
  const rel = allocationsStatement(releases);
  if (rel) stmts.push(rel);
  for (const l of late)
    stmts.push(sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type,
        payer_id, amount, due_date, kind, parent_charge_id, reason, created_by)
      SELECT ${l.id}, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id, ${-l.amount},
             due_date, 'concession', id, ${`concession:${l.concession_id}`}, ${input.by}
      FROM charge WHERE id = ${l.root_id}
        AND NOT EXISTS (SELECT 1 FROM charge x WHERE x.parent_charge_id = ${l.root_id}
                          AND x.kind = 'concession' AND x.reason = ${`concession:${l.concession_id}`})`);
  const alloc = allocationsStatement(credit, true);
  if (alloc) stmts.push(alloc);
  if (!stmts.length) return result({ ...zero, late_concessions: 0, released: 0 });
  stmts.push(
    chunkLogStatement({
      period: input.period,
      kind: 'fees',
      grpId: null,
      studentId: input.studentId,
      nextStudentId: null,
      done: true,
      plan: [...plan, ...late.map((l) => ({ id: l.id, kind: 'concession', payer_type: 'family' }))],
      allocationIds: credit.map((a) => a.id),
      by: input.by,
    }),
    auditStatement({
      id: newId(),
      userId: input.by,
      entity: 'student',
      entityId: input.studentId,
      action: 'regenerate_fees',
      diff: {
        period: input.period,
        new_charges: plan.length,
        late_concessions: late.map((l) => ({
          root_id: l.root_id,
          concession_id: l.concession_id,
          amount: l.amount,
        })),
        released: releasedTotal,
      },
    }),
  );
  await runBatch(db, stmts);
  const [n] = await db.all<GenCounts>(sql`SELECT
      (SELECT count(*) FROM charge WHERE id IN (SELECT value FROM json_each(${JSON.stringify(plan.filter((c) => c.kind === 'fee' && c.payer_type === 'family').map((c) => c.id))}))) AS fees,
      (SELECT count(*) FROM charge WHERE id IN (SELECT value FROM json_each(${JSON.stringify(plan.filter((c) => c.kind === 'concession').map((c) => c.id))}))) AS concessions,
      (SELECT count(*) FROM charge WHERE id IN (SELECT value FROM json_each(${JSON.stringify(plan.filter((c) => c.payer_type === 'sponsor').map((c) => c.id))}))) AS sponsored,
      (SELECT count(*) FROM receipt_allocation WHERE id IN (SELECT value FROM json_each(${JSON.stringify(credit.map((c) => c.id))}))) AS allocations`);
  return result({
    ...(n ?? zero),
    late_concessions: late.length,
    released: releasedTotal,
  });
}

const zero: GenCounts = { fees: 0, concessions: 0, sponsored: 0, allocations: 0 };

/** Live concessions of a student for a period (for previews and the family view). */
export async function liveConcessions(db: AppDb, studentId: string, period: string) {
  return db.all<{
    id: string;
    fee_head_id: string | null;
    type: string;
    value: number;
    reason: string;
  }>(sql`SELECT id, fee_head_id, type, value, reason FROM concession
    WHERE student_id = ${studentId} AND valid_from <= ${periodEnd(period)}
      AND (valid_to IS NULL OR valid_to >= ${periodStart(period)})
      AND (ended_at IS NULL OR ended_at > ${periodStart(period)})
    ORDER BY created_at, id`);
}

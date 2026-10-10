import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { allocationsStatement, planRelease } from './alloc';
import { applyCreditFor } from './collect';
import {
  chargeStatements,
  chunkLogStatement,
  type GenCounts,
  type LiveConcession,
  liveOn,
  loadContext,
  type PlannedCharge,
  planCharges,
  planCreditForFamilies,
  referenceDay,
  sponsorShares,
  studentEnrolments,
} from './generate';
import type { AllocationInput } from './index';
import {
  assertPeriod,
  auditStatement,
  DATE_RE,
  FeeError,
  feeSettings,
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

/** A line a late concession adds: a concession on the family root, or a re-bill on a sponsor root. */
export type LateConcession = {
  id: string;
  root_id: string;
  concession_id: string;
  amount: number;
  /** 'family' = concession line; 'sponsor' = reversal line re-billing the sponsor's share. */
  payer_type: 'family' | 'sponsor';
};

export type RegenerateResult = {
  period: string;
  student_id: string;
  dry_run: boolean;
  planned: PlannedCharge[];
  late_concessions: LateConcession[];
  counts: GenCounts & { late_concessions: number; released: number; credit_applied: number };
};

type UnitRoot = {
  id: string;
  fee_head_id: string;
  head_kind: string;
  payer_type: 'family' | 'sponsor';
  payer_id: string;
  enrolment_id: string | null;
  amount: number;
  /** amount + concession and reversal lines: the fee part a reduction may still take. */
  fee_part: number;
  net: number;
  paid: number;
  reasons: string | null;
};

/**
 * Re-bills one student for one period (PLAN §14.7 "the current month can be re-generated"):
 * missing units are generated as usual, and every concession live on the period's reference day
 * (generate.ts liveOn/referenceDay — the same rule as generation) that is not yet on the unit is
 * added. The discount is split the way a fresh generation would have split it: sponsors are re-billed
 * on the new base N' (their share of N' − their share of N, as a `reversal` line under the sponsor
 * root, since concessions are family lines only) and the family line takes the rest as the
 * `concession` line. Whatever was paid beyond a root's new net is released first in the same batch
 * (the money becomes credit), and that credit is applied to the payers' dues in a second batch.
 * Re-running is a no-op.
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

  const roots = await db.all<UnitRoot>(sql`SELECT c.id, c.fee_head_id, h.kind AS head_kind,
      c.payer_type, c.payer_id, c.enrolment_id, c.amount,
      c.amount + coalesce((SELECT sum(x.amount) FROM charge x WHERE x.parent_charge_id = c.id
                             AND x.kind IN ('concession', 'reversal')), 0) AS fee_part,
      n.net, n.paid,
      (SELECT json_group_array(x.reason) FROM charge x WHERE x.parent_charge_id = c.id) AS reasons
    FROM charge c JOIN fee_head h ON h.id = c.fee_head_id JOIN charge_net n ON n.id = c.id
    WHERE c.kind = 'fee' AND c.parent_charge_id IS NULL AND c.student_id = ${input.studentId}
      AND c.period_key = ${input.period} AND c.enrolment_id IS NOT NULL
    ORDER BY c.payer_type, c.id`);
  const units = new Map<string, UnitRoot[]>();
  for (const r of roots) units.set(r.fee_head_id, [...(units.get(r.fee_head_id) ?? []), r]);

  const late: LateConcession[] = [];
  for (const unitRoots of units.values()) {
    const family = unitRoots.find((r) => r.payer_type === 'family');
    const sponsors = unitRoots.filter((r) => r.payer_type === 'sponsor');
    const first = unitRoots[0] as UnitRoot;
    const e = enrolments.find((x) => x.id === first.enrolment_id);
    const ref = e ? referenceDay(ctx, e) : periodStart(input.period);
    const have = new Set<string>(unitRoots.flatMap((r) => JSON.parse(r.reasons ?? '[]')));
    const gross = unitRoots.reduce((a, r) => a + r.amount, 0);
    let kTotal = family ? family.amount - family.fee_part : 0; // concessions already given
    const lines: { c: LiveConcession; amount: number }[] = [];
    for (const c of ctx.concessions) {
      if (c.student_id !== input.studentId || !liveOn(c, ref)) continue;
      if (c.fee_head_id ? c.fee_head_id !== first.fee_head_id : first.head_kind !== 'tuition')
        continue;
      if (have.has(`concession:${c.id}`)) continue;
      const want = c.type === 'pct' ? roundRupee(gross * c.value, 100) : c.value;
      const amount = Math.min(want, gross - kTotal);
      if (amount <= 0) continue;
      lines.push({ c, amount });
      kTotal += amount;
    }
    if (!lines.length) continue;
    // The sponsors' shares on the new base; each sponsor root only ever goes down.
    const owedNew = gross - kTotal;
    const live = ctx.sponsorships.filter(
      (s) =>
        s.student_id === input.studentId &&
        (!s.fee_head_id || s.fee_head_id === first.fee_head_id) &&
        liveOn(s, ref),
    );
    const targets = new Map(sponsorShares(live, owedNew).map((t) => [t.sponsor_id, t.amount]));
    const cut = new Map<string, number>();
    for (const sr of sponsors) {
      const target = targets.get(sr.payer_id);
      if (target === undefined) continue;
      cut.set(sr.id, Math.max(0, Math.min(sr.fee_part - target, sr.net - 0)));
    }
    const totalL = lines.reduce((a, l) => a + l.amount, 0);
    let familyLeft = family?.fee_part ?? 0;
    const cutLeft = new Map(cut);
    lines.forEach((l, i) => {
      const last = i === lines.length - 1;
      let sponsorPart = 0;
      for (const sr of sponsors) {
        const total = cut.get(sr.id) ?? 0;
        const left = cutLeft.get(sr.id) ?? 0;
        if (left <= 0) continue;
        const share = last ? left : Math.min(left, roundRupee(total * l.amount, totalL));
        if (share <= 0) continue;
        late.push({
          id: newId(),
          root_id: sr.id,
          concession_id: l.c.id,
          amount: share,
          payer_type: 'sponsor',
        });
        cutLeft.set(sr.id, left - share);
        sponsorPart += share;
      }
      const familyPart = Math.min(Math.max(0, l.amount - sponsorPart), familyLeft);
      if (family && familyPart > 0) {
        late.push({
          id: newId(),
          root_id: family.id,
          concession_id: l.c.id,
          amount: familyPart,
          payer_type: 'family',
        });
        familyLeft -= familyPart;
      }
    });
  }

  // Release, per root, what was paid beyond its new net (all late lines on it together).
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
  // In-batch credit only for fresh charges when nothing is being reduced (a late line changes dues
  // the credit planner would read before this batch lowers them); the second batch below covers it.
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
      credit_applied: 0,
    });

  const stmts: SQL[] = chargeStatements(input.period, plan, input.by);
  if (!stmts.length && late.length)
    stmts.push(sql`INSERT INTO billing_run (id, period_key, run_at, run_by)
      SELECT ${newId()}, ${input.period}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${input.by}
      WHERE NOT EXISTS (SELECT 1 FROM billing_run WHERE period_key = ${input.period})`);
  const rel = allocationsStatement(releases);
  if (rel) stmts.push(rel);
  for (const l of late) {
    const kind = l.payer_type === 'family' ? 'concession' : 'reversal';
    stmts.push(sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type,
        payer_id, amount, due_date, kind, parent_charge_id, reason, created_by)
      SELECT ${l.id}, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id, ${-l.amount},
             due_date, ${kind}, id, ${`concession:${l.concession_id}`}, ${input.by}
      FROM charge WHERE id = ${l.root_id}
        AND NOT EXISTS (SELECT 1 FROM charge x WHERE x.parent_charge_id = ${l.root_id}
                          AND x.reason = ${`concession:${l.concession_id}`})`);
  }
  const alloc = allocationsStatement(credit, true);
  if (alloc) stmts.push(alloc);
  if (!stmts.length) {
    const applied = await applyCreditFor(
      db,
      families.map((f) => ({ payerType: 'family' as const, payerId: f })),
    );
    return result({ ...zero, late_concessions: 0, released: 0, credit_applied: applied });
  }
  stmts.push(
    chunkLogStatement({
      period: input.period,
      kind: 'fees',
      grpId: null,
      studentId: input.studentId,
      nextStudentId: null,
      done: true,
      plan: [
        ...plan,
        ...late
          .filter((l) => l.payer_type === 'family')
          .map((l) => ({ id: l.id, kind: 'concession', payer_type: 'family' })),
      ],
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
          payer_type: l.payer_type,
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
  // Second batch: released (or pre-existing) credit goes to the payers' open dues, oldest first.
  const payers = [
    ...families.map((f) => ({ payerType: 'family' as const, payerId: f })),
    ...roots
      .filter((r) => r.payer_type === 'sponsor')
      .map((r) => ({ payerType: 'sponsor' as const, payerId: r.payer_id })),
    ...plan
      .filter((c) => c.payer_type === 'sponsor')
      .map((c) => ({ payerType: 'sponsor' as const, payerId: c.payer_id })),
  ];
  const applied = await applyCreditFor(db, payers);
  return result({
    ...(n ?? zero),
    late_concessions: late.filter((l) => l.payer_type === 'family').length,
    released: releasedTotal,
    credit_applied: applied,
  });
}

const zero: GenCounts = { fees: 0, concessions: 0, sponsored: 0, allocations: 0 };

/**
 * Concessions of a student that apply to a period (for previews and the family view): live on the
 * period's first day, or on `fromDay` (an enrolment starting later in the period) — the generation rule.
 */
export async function liveConcessions(
  db: AppDb,
  studentId: string,
  period: string,
  fromDay?: string,
) {
  const day = fromDay && fromDay > periodStart(period) ? fromDay : periodStart(period);
  return db.all<{
    id: string;
    fee_head_id: string | null;
    type: string;
    value: number;
    reason: string;
  }>(sql`SELECT id, fee_head_id, type, value, reason FROM concession
    WHERE student_id = ${studentId} AND valid_from <= ${day}
      AND (valid_to IS NULL OR valid_to >= ${day})
      AND (ended_at IS NULL OR ended_at > ${day})
    ORDER BY created_at, id`);
}

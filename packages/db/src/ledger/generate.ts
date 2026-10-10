import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { allocationsStatement, creditSources, openDues, planCredit } from './alloc';
import type { AllocationInput } from './index';
import {
  assertPeriod,
  dayOf,
  daysInclusive,
  daysInPeriod,
  type FeeSettings,
  feeSettings,
  inJson,
  maxDate,
  minDate,
  periodEnd,
  periodOf,
  periodStart,
  roundRupee,
  runBatch,
} from './util';

/**
 * Monthly fee generation (PLAN §5.2, §14.5). A pure planner over pre-loaded data, then one batch:
 *
 *   billing_run (once per period) → root `fee` charges → child concession lines → credit
 *   allocations → billing_chunk log row.
 *
 * Billing unit = (student, fee head, period). Per unit:
 *   G  = rate effective on the period's 1st day (group rate overrides programme rate), pro-rated by
 *        days when asked (monthly heads only), rounded half-up to the rupee.
 *   K  = live concessions in creation order: pct of G (rounded half-up to the rupee) or fixed,
 *        each capped so ΣK ≤ G.
 *   N  = G − K, what is actually owed.
 *   S  = live sponsorships in creation order: share% of N (rounded), capped so ΣS ≤ N; each is
 *        its own root `fee` with payer_type 'sponsor'.
 *   Family root = G − ΣS, with the concession lines −K under it, so the family's net is N − ΣS.
 *   (Every party's share is of the post-concession amount; the family line shows the discount.)
 *
 * Idempotency: a unit is inserted only if no root for (student, head, period) exists other than the
 * ones minted in this plan (the partial unique index charge_fee_once is the backstop). `once` heads
 * (admission) are once per enrolment: skipped when any root of that head exists on the enrolment,
 * and never on a transfer/promotion (prev_enrolment_id set). Imported enrolments are never
 * backfilled: only the requested period is billed.
 */

export type GenEnrolment = {
  id: string;
  student_id: string;
  family_id: string;
  grp_id: string;
  programme_id: string;
  session_id: string | null;
  start_date: string;
  end_date: string | null;
  prev_enrolment_id: string | null;
  is_primary: number;
  /** Group span (its own dates, else its session's); null = open-ended. */
  span_start: string | null;
  span_end: string | null;
};

type Head = { id: string; name: string; kind: string; cadence: string };
type Rate = {
  fee_head_id: string;
  programme_id: string | null;
  grp_id: string | null;
  amount: number;
  effective_from: string;
};
export type LiveConcession = {
  id: string;
  student_id: string;
  fee_head_id: string | null;
  type: 'pct' | 'fixed';
  value: number;
};
type LiveSponsorship = {
  id: string;
  sponsor_id: string;
  student_id: string;
  fee_head_id: string | null;
  share_pct: number;
};

export type GenContext = {
  period: string;
  settings: FeeSettings;
  heads: Head[];
  rates: Rate[];
  /** session ids with a term starting in this period (per_term heads). */
  termSessions: Set<string>;
  concessions: LiveConcession[];
  sponsorships: LiveSponsorship[];
  /** `student|head` units already billed this period. */
  billedUnits: Set<string>;
  /** `student|head|enrolment` for once heads already billed on that enrolment. */
  billedOnce: Set<string>;
};

export type PlannedCharge = {
  id: string;
  student_id: string;
  enrolment_id: string;
  fee_head_id: string;
  head_name: string;
  period_key: string;
  payer_type: 'family' | 'sponsor';
  payer_id: string;
  kind: 'fee' | 'concession';
  amount: number;
  due_date: string;
  parent_charge_id: string | null;
  reason: string | null;
  once: boolean;
};

export type GenOptions = {
  /** Mid-month joiners/leavers billed by days in the period (monthly heads); default full. */
  proRata?: boolean;
  /** Bill once heads even outside the enrolment's first period (admission). */
  admission?: boolean;
  /** Due date is never before this (admission day). */
  dueNotBefore?: string;
};

/** Concessions apply to the head they name; with no head, to every tuition head (PLAN §14.7). */
const concessionApplies = (c: { fee_head_id: string | null }, h: Head) =>
  c.fee_head_id ? c.fee_head_id === h.id : h.kind === 'tuition';
/** Sponsorships with no head cover every head billed. */
const sponsorshipApplies = (s: { fee_head_id: string | null }, h: Head) =>
  !s.fee_head_id || s.fee_head_id === h.id;

function rateFor(ctx: GenContext, e: GenEnrolment, headId: string): number | null {
  const start = periodStart(ctx.period);
  const pick = (rows: Rate[]) =>
    rows
      .filter((r) => r.fee_head_id === headId && r.effective_from <= start)
      .sort((a, b) =>
        a.effective_from < b.effective_from ? 1 : a.effective_from > b.effective_from ? -1 : 0,
      )[0];
  // Same effective date twice = a correction; the later row (loaded in created order) wins.
  const byGroup = pick(ctx.rates.filter((r) => r.grp_id === e.grp_id).reverse());
  if (byGroup) return byGroup.amount;
  const byProg = pick(ctx.rates.filter((r) => r.programme_id === e.programme_id).reverse());
  return byProg ? byProg.amount : null;
}

/** The planner: pure, so the admission preview, dry-run and the real run agree exactly. */
export function planCharges(
  ctx: GenContext,
  enrolments: readonly GenEnrolment[],
  opts: GenOptions = {},
): PlannedCharge[] {
  const p = ctx.period;
  const pStart = periodStart(p);
  const pEnd = periodEnd(p);
  const out: PlannedCharge[] = [];
  const planned = new Set<string>();
  // Primary (school class) first, so its rate wins when two enrolments bill the same head.
  const ordered = [...enrolments].sort(
    (a, b) => b.is_primary - a.is_primary || (a.id < b.id ? -1 : 1),
  );
  for (const e of ordered) {
    if (e.start_date > pEnd) continue;
    if (e.span_start && e.span_start > pEnd) continue;
    if (e.span_end && e.span_end < pStart) continue;
    const firstPeriod = periodOf(e.start_date) === p;
    for (const h of ctx.heads) {
      const unit = `${e.student_id}|${h.id}`;
      if (planned.has(unit) || ctx.billedUnits.has(unit)) continue;
      if (h.cadence === 'once') {
        if (e.prev_enrolment_id) continue;
        if (!firstPeriod && !opts.admission) continue;
        if (ctx.billedOnce.has(`${unit}|${e.id}`)) continue;
      } else if (h.cadence === 'per_term') {
        if (!e.session_id || !ctx.termSessions.has(e.session_id)) continue;
      }
      const rate = rateFor(ctx, e, h.id);
      if (!rate || rate <= 0) continue;
      let gross = rate;
      if (opts.proRata && h.cadence === 'monthly') {
        // Leave dates are not validated against the start (M1): clamp the overlap to the period.
        const from = maxDate(pStart, e.start_date);
        const to = minDate(pEnd, e.end_date ?? pEnd);
        const days = daysInclusive(from, to);
        const total = daysInPeriod(p);
        if (days <= 0) continue;
        if (days < total) gross = roundRupee(rate * days, total);
      }
      if (gross <= 0) continue;
      planned.add(unit);

      const lines: { c: LiveConcession; amount: number }[] = [];
      let k = 0;
      for (const c of ctx.concessions) {
        if (c.student_id !== e.student_id || !concessionApplies(c, h)) continue;
        const want = c.type === 'pct' ? roundRupee(gross * c.value, 100) : c.value;
        const amount = Math.min(want, gross - k);
        if (amount <= 0) continue;
        lines.push({ c, amount });
        k += amount;
      }
      const owed = gross - k;
      const shares: { s: LiveSponsorship; amount: number }[] = [];
      let sTotal = 0;
      let pctLeft = 100;
      for (const s of ctx.sponsorships) {
        if (s.student_id !== e.student_id || !sponsorshipApplies(s, h)) continue;
        const pct = Math.min(s.share_pct, pctLeft);
        if (pct <= 0) continue;
        pctLeft -= pct;
        const amount = Math.min(roundRupee(owed * pct, 100), owed - sTotal);
        if (amount <= 0) continue;
        shares.push({ s, amount });
        sTotal += amount;
      }

      let due = dayOf(p, ctx.settings.dueDay);
      if (e.start_date > due) due = e.start_date;
      if (opts.dueNotBefore && opts.dueNotBefore > due) due = opts.dueNotBefore;
      const base = {
        student_id: e.student_id,
        enrolment_id: e.id,
        fee_head_id: h.id,
        head_name: h.name,
        period_key: p,
        due_date: due,
        once: h.cadence === 'once',
      };
      const familyAmount = gross - sTotal;
      if (familyAmount > 0) {
        const rootId = newId();
        out.push({
          ...base,
          id: rootId,
          payer_type: 'family',
          payer_id: e.family_id,
          kind: 'fee',
          amount: familyAmount,
          parent_charge_id: null,
          reason: null,
        });
        for (const l of lines)
          out.push({
            ...base,
            id: newId(),
            payer_type: 'family',
            payer_id: e.family_id,
            kind: 'concession',
            amount: -l.amount,
            parent_charge_id: rootId,
            reason: `concession:${l.c.id}`,
          });
      }
      for (const sh of shares)
        out.push({
          ...base,
          id: newId(),
          payer_type: 'sponsor',
          payer_id: sh.s.sponsor_id,
          kind: 'fee',
          amount: sh.amount,
          parent_charge_id: null,
          reason: `sponsorship:${sh.s.id}`,
        });
    }
  }
  return out;
}

/** Live in the period: started by its end, not ended before its start (ended_at = end date). */
const liveIn = (from: SQL, to: SQL, ended: SQL | null, p: string) =>
  sql`${from} <= ${periodEnd(p)} AND (${to} IS NULL OR ${to} >= ${periodStart(p)})
      ${ended ? sql`AND (${ended} IS NULL OR ${ended} > ${periodStart(p)})` : sql``}`;

/** Everything the planner needs for these students and groups, in a handful of reads. */
export async function loadContext(
  db: AppDb,
  period: string,
  enrolments: readonly GenEnrolment[],
  settings?: FeeSettings,
): Promise<GenContext> {
  assertPeriod(period);
  const s = settings ?? (await feeSettings(db));
  const students = [...new Set(enrolments.map((e) => e.student_id))];
  const grps = [...new Set(enrolments.map((e) => e.grp_id))];
  const progs = [...new Set(enrolments.map((e) => e.programme_id))];
  const sessions = [
    ...new Set(enrolments.map((e) => e.session_id).filter((x): x is string => !!x)),
  ];
  const heads = await db.all<Head>(sql`SELECT id, name, kind, cadence FROM fee_head
      WHERE archived_at IS NULL AND kind <> 'fine' ORDER BY created_at, id`);
  const rates = students.length
    ? await db.all<Rate>(sql`SELECT fee_head_id, programme_id, grp_id, amount, effective_from
        FROM fee_rate WHERE ${inJson(sql`grp_id`, grps)} OR ${inJson(sql`programme_id`, progs)}
        ORDER BY created_at, id`)
    : [];
  const terms = sessions.length
    ? await db.all<{ session_id: string }>(sql`SELECT DISTINCT session_id FROM term
        WHERE substr(start_date, 1, 7) = ${period} AND ${inJson(sql`session_id`, sessions)}`)
    : [];
  const concessions = students.length
    ? await db.all<LiveConcession>(sql`SELECT id, student_id, fee_head_id, type, value FROM concession
        WHERE ${inJson(sql`student_id`, students)}
          AND ${liveIn(sql`valid_from`, sql`valid_to`, sql`ended_at`, period)}
        ORDER BY created_at, id`)
    : [];
  const sponsorships = students.length
    ? await db.all<LiveSponsorship>(sql`SELECT id, sponsor_id, student_id, fee_head_id, share_pct
        FROM sponsorship WHERE ${inJson(sql`student_id`, students)}
          AND ${liveIn(sql`valid_from`, sql`valid_to`, null, period)}
        ORDER BY created_at, id`)
    : [];
  const billed = students.length
    ? await db.all<{
        student_id: string;
        fee_head_id: string;
      }>(sql`SELECT DISTINCT student_id, fee_head_id
        FROM charge WHERE kind = 'fee' AND period_key = ${period} AND ${inJson(sql`student_id`, students)}`)
    : [];
  const once = students.length
    ? await db.all<{ student_id: string; fee_head_id: string; enrolment_id: string }>(sql`
        SELECT DISTINCT c.student_id, c.fee_head_id, c.enrolment_id FROM charge c
        JOIN fee_head h ON h.id = c.fee_head_id
        WHERE c.kind = 'fee' AND h.cadence = 'once' AND c.enrolment_id IS NOT NULL
          AND ${inJson(sql`c.student_id`, students)}`)
    : [];
  return {
    period,
    settings: s,
    heads,
    rates,
    termSessions: new Set(terms.map((t) => t.session_id)),
    concessions,
    sponsorships,
    billedUnits: new Set(billed.map((b) => `${b.student_id}|${b.fee_head_id}`)),
    billedOnce: new Set(once.map((b) => `${b.student_id}|${b.fee_head_id}|${b.enrolment_id}`)),
  };
}

const ENROLMENT_COLUMNS = sql`e.id, e.student_id, s.family_id, e.grp_id, g.programme_id, g.session_id,
  e.start_date, e.end_date, e.prev_enrolment_id, e.is_primary,
  coalesce(g.start_date, ss.start_date) AS span_start, coalesce(g.end_date, ss.end_date) AS span_end`;

/**
 * Enrolments billed in a period: active and started by its end, or left (withdrawn/completed)
 * during or after it. `transferred`/`promoted`/`retained` rows are never billed — the enrolment
 * that replaced them is, so a mid-month transfer is billed once.
 */
const eligible = (p: string) => sql`e.start_date <= ${periodEnd(p)}
  AND (e.status = 'active' OR (e.status IN ('withdrawn', 'completed') AND e.end_date >= ${periodStart(p)}))`;

export async function groupEnrolments(
  db: AppDb,
  period: string,
  grpId: string,
  afterStudentId: string | null,
  limit: number,
): Promise<GenEnrolment[]> {
  return db.all<GenEnrolment>(sql`SELECT ${ENROLMENT_COLUMNS}
    FROM enrolment e JOIN student s ON s.id = e.student_id JOIN grp g ON g.id = e.grp_id
    LEFT JOIN session ss ON ss.id = g.session_id
    WHERE e.grp_id = ${grpId} AND ${eligible(period)} AND e.student_id > ${afterStudentId ?? ''}
    ORDER BY e.student_id, e.id LIMIT ${limit}`);
}

export async function studentEnrolments(
  db: AppDb,
  period: string,
  studentId: string,
): Promise<GenEnrolment[]> {
  return db.all<GenEnrolment>(sql`SELECT ${ENROLMENT_COLUMNS}
    FROM enrolment e JOIN student s ON s.id = e.student_id JOIN grp g ON g.id = e.grp_id
    LEFT JOIN session ss ON ss.id = g.session_id
    WHERE e.student_id = ${studentId} AND ${eligible(period)} ORDER BY e.id`);
}

/** The next group (by id) with billable enrolments in the period, after `afterGrpId`. */
export async function nextGroup(
  db: AppDb,
  period: string,
  afterGrpId: string | null,
): Promise<string | null> {
  const [row] = await db.all<{ grp_id: string | null }>(sql`SELECT min(e.grp_id) AS grp_id
    FROM enrolment e WHERE ${eligible(period)} AND e.grp_id > ${afterGrpId ?? ''}`);
  return row?.grp_id ?? null;
}

/** Statements that write a plan: run row, roots, children. Ids minted in the plan. */
export function chargeStatements(
  period: string,
  plan: readonly PlannedCharge[],
  by: string | null,
  runId = newId(),
): SQL[] {
  if (!plan.length) return [];
  const roots = plan.filter((c) => c.kind === 'fee');
  const kids = plan.filter((c) => c.kind !== 'fee');
  const rootIds = JSON.stringify(roots.map((c) => c.id));
  const j = (rows: readonly PlannedCharge[]) =>
    JSON.stringify(
      rows.map((c) => ({
        id: c.id,
        s: c.student_id,
        e: c.enrolment_id,
        h: c.fee_head_id,
        pt: c.payer_type,
        pi: c.payer_id,
        a: c.amount,
        d: c.due_date,
        k: c.kind,
        par: c.parent_charge_id,
        r: c.reason,
        o: c.once ? 1 : 0,
      })),
    );
  const cols = sql`json_extract(value, '$.id') AS id, json_extract(value, '$.s') AS s,
    json_extract(value, '$.e') AS e, json_extract(value, '$.h') AS h, json_extract(value, '$.pt') AS pt,
    json_extract(value, '$.pi') AS pi, json_extract(value, '$.a') AS a, json_extract(value, '$.d') AS d,
    json_extract(value, '$.k') AS k, json_extract(value, '$.par') AS par, json_extract(value, '$.r') AS r,
    json_extract(value, '$.o') AS o`;
  const run = sql`(SELECT id FROM billing_run WHERE period_key = ${period})`;
  const others = sql`c.id NOT IN (SELECT value FROM json_each(${rootIds}))`;
  const stmts: SQL[] = [
    sql`INSERT INTO billing_run (id, period_key, run_at, run_by)
        SELECT ${runId}, ${period}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${by}
        WHERE NOT EXISTS (SELECT 1 FROM billing_run WHERE period_key = ${period})`,
  ];
  if (roots.length)
    stmts.push(sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type,
          payer_id, amount, due_date, kind, reason, run_id, created_by)
        SELECT j.id, j.s, j.e, j.h, ${period}, j.pt, j.pi, j.a, j.d, 'fee', j.r, ${run}, ${by}
        FROM (SELECT ${cols} FROM json_each(${j(roots)})) j
        WHERE NOT EXISTS (SELECT 1 FROM charge c WHERE c.kind = 'fee' AND c.student_id = j.s
                            AND c.fee_head_id = j.h AND c.period_key = ${period} AND ${others})
          AND NOT (j.o = 1 AND EXISTS (SELECT 1 FROM charge c WHERE c.kind = 'fee' AND c.student_id = j.s
                            AND c.fee_head_id = j.h AND c.enrolment_id = j.e AND ${others}))`);
  if (kids.length)
    stmts.push(sql`INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type,
          payer_id, amount, due_date, kind, parent_charge_id, reason, run_id, created_by)
        SELECT j.id, j.s, j.e, j.h, ${period}, j.pt, j.pi, j.a, j.d, j.k, j.par, j.r, ${run}, ${by}
        FROM (SELECT ${cols} FROM json_each(${j(kids)})) j
        WHERE EXISTS (SELECT 1 FROM charge c WHERE c.id = j.par)`);
  return stmts;
}

export type GenCounts = {
  fees: number;
  concessions: number;
  sponsored: number;
  allocations: number;
};

export function countPlan(plan: readonly PlannedCharge[]): Omit<GenCounts, 'allocations'> {
  return {
    fees: plan.filter((c) => c.kind === 'fee' && c.payer_type === 'family').length,
    concessions: plan.filter((c) => c.kind === 'concession').length,
    sponsored: plan.filter((c) => c.kind === 'fee' && c.payer_type === 'sponsor').length,
  };
}

/** The log row: counts of what this batch actually inserted (minted ids that now exist). */
export function chunkLogStatement(o: {
  period: string;
  kind: 'fees' | 'fines';
  grpId: string | null;
  studentId: string | null;
  nextStudentId: string | null;
  done: boolean;
  plan: readonly { id: string; kind: string; payer_type: string }[];
  allocationIds: readonly string[];
  by: string | null;
}): SQL {
  const ids = (f: (c: (typeof o.plan)[number]) => boolean) =>
    JSON.stringify(o.plan.filter(f).map((c) => c.id));
  const n = (json: string) =>
    sql`(SELECT count(*) FROM charge WHERE id IN (SELECT value FROM json_each(${json})))`;
  return sql`INSERT INTO billing_chunk (id, run_id, kind, grp_id, student_id, next_student_id, done,
      fees, concessions, sponsored, fines, allocations, created_by)
    VALUES (${newId()}, (SELECT id FROM billing_run WHERE period_key = ${o.period}), ${o.kind},
      ${o.grpId}, ${o.studentId}, ${o.nextStudentId}, ${o.done ? 1 : 0},
      ${n(ids((c) => c.kind === 'fee' && c.payer_type === 'family'))},
      ${n(ids((c) => c.kind === 'concession'))},
      ${n(ids((c) => c.kind === 'fee' && c.payer_type === 'sponsor'))},
      ${n(ids((c) => c.kind === 'fine'))},
      (SELECT count(*) FROM receipt_allocation WHERE id IN (SELECT value FROM json_each(${JSON.stringify(o.allocationIds)}))),
      ${o.by})`;
}

/**
 * Credit auto-apply for the families a plan touches (PLAN §5.2: unallocated credit applies to new
 * charges): existing dues plus the plan's new family roots, oldest first, paid from the oldest
 * receipts that still hold money. Rows for a planned root that does not get inserted are skipped.
 */
export async function planCreditForFamilies(
  db: AppDb,
  familyIds: readonly string[],
  plan: readonly PlannedCharge[],
  maxRows: number,
): Promise<(AllocationInput & { receiptId: string })[]> {
  const out: (AllocationInput & { receiptId: string })[] = [];
  if (maxRows <= 0 || !familyIds.length) return out;
  const withCredit = await db.all<{ payer_id: string }>(sql`SELECT payer_id FROM payer_credit
    WHERE payer_type = 'family' AND credit > 0 AND ${inJson(sql`payer_id`, familyIds)}`);
  for (const { payer_id } of withCredit) {
    const { credit, sources } = await creditSources(db, 'family', payer_id);
    if (credit <= 0) continue;
    const existing = await openDues(db, 'family', payer_id);
    const fresh = plan
      .filter((c) => c.kind === 'fee' && c.payer_type === 'family' && c.payer_id === payer_id)
      .map((r) => ({
        id: r.id,
        due_date: r.due_date,
        period_key: r.period_key,
        due:
          r.amount +
          plan.filter((k) => k.parent_charge_id === r.id).reduce((a, k) => a + k.amount, 0),
      }));
    const targets = [...existing, ...fresh].sort((a, b) =>
      a.due_date !== b.due_date
        ? a.due_date < b.due_date
          ? -1
          : 1
        : a.period_key < b.period_key
          ? -1
          : a.period_key > b.period_key
            ? 1
            : 0,
    );
    out.push(...planCredit(credit, sources, targets, maxRows - out.length));
    if (out.length >= maxRows) break;
  }
  return out;
}

export type GenerateInput = {
  period: string;
  /** One group chunk (resume after `afterStudentId`) or one student (admission, regenerate). */
  scope: { grpId: string; afterStudentId?: string | null } | { studentId: string };
  by: string | null;
  dryRun?: boolean;
  proRata?: boolean;
  /** Row budget for one request (PLAN §15: ≤ 200 rows via json_each). */
  maxRows?: number;
};

export type GenerateResult = {
  period: string;
  grp_id: string | null;
  student_id: string | null;
  dry_run: boolean;
  planned: PlannedCharge[];
  counts: GenCounts;
  /** This group (or student) is finished; else resume with next_student_id. */
  group_done: boolean;
  next_student_id: string | null;
  /** The next group to send, or null when the period is complete. */
  next_grp_id: string | null;
};

/**
 * One chunk of generation as one batch. A group is cut into student slices so a request never
 * writes more than `maxRows` rows (charges + credit allocations); the caller loops on
 * `next_student_id` / `next_grp_id`. Re-running any chunk is a no-op.
 */
export async function generateCharges(db: AppDb, input: GenerateInput): Promise<GenerateResult> {
  const { period } = input;
  assertPeriod(period);
  const maxRows = input.maxRows ?? 200;
  const settings = await feeSettings(db);
  let enrolments: GenEnrolment[];
  let grpId: string | null = null;
  let studentId: string | null = null;
  let more = false;
  if ('studentId' in input.scope) {
    studentId = input.scope.studentId;
    enrolments = await studentEnrolments(db, period, studentId);
  } else {
    grpId = input.scope.grpId;
    // A student has at most a handful of rows per period (heads × payers + concessions), so 60
    // students can never exceed the budget by much; the slice below trims to the budget exactly.
    const page = 60;
    enrolments = await groupEnrolments(
      db,
      period,
      grpId,
      input.scope.afterStudentId ?? null,
      page + 1,
    );
    more = enrolments.length > page;
    if (more) enrolments = enrolments.slice(0, page);
  }
  const ctx = await loadContext(db, period, enrolments, settings);
  const full = planCharges(ctx, enrolments, { proRata: input.proRata });

  // Trim to whole students within the budget, leaving room for credit allocations.
  let plan: PlannedCharge[] = full;
  let lastStudent: string | null = enrolments.at(-1)?.student_id ?? null;
  if (full.length > maxRows - 20) {
    const byStudent = new Map<string, PlannedCharge[]>();
    for (const c of full) byStudent.set(c.student_id, [...(byStudent.get(c.student_id) ?? []), c]);
    plan = [];
    lastStudent = null;
    for (const e of enrolments) {
      if (e.student_id === lastStudent) continue;
      const rows = byStudent.get(e.student_id) ?? [];
      if (plan.length + rows.length > maxRows - 20 && plan.length) {
        more = true;
        break;
      }
      plan.push(...rows);
      lastStudent = e.student_id;
    }
  }
  const families = [
    ...new Set(
      enrolments.filter((e) => e.student_id <= (lastStudent ?? '')).map((e) => e.family_id),
    ),
  ];
  const allocations = input.dryRun
    ? []
    : await planCreditForFamilies(db, families, plan, maxRows - plan.length);
  const groupDone = !more;
  const nextStudent = groupDone ? null : lastStudent;
  const nextGrp = grpId === null ? null : groupDone ? await nextGroup(db, period, grpId) : grpId;

  if (!input.dryRun) {
    const stmts = chargeStatements(period, plan, input.by);
    if (!stmts.length)
      stmts.push(sql`INSERT INTO billing_run (id, period_key, run_at, run_by)
        SELECT ${newId()}, ${period}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${input.by}
        WHERE NOT EXISTS (SELECT 1 FROM billing_run WHERE period_key = ${period})`);
    const alloc = allocationsStatement(allocations, true);
    if (alloc) stmts.push(alloc);
    stmts.push(
      chunkLogStatement({
        period,
        kind: 'fees',
        grpId,
        studentId,
        nextStudentId: nextStudent,
        done: groupDone,
        plan,
        allocationIds: allocations.map((a) => a.id),
        by: input.by,
      }),
    );
    await runBatch(db, stmts);
  }
  const counts = input.dryRun
    ? { ...countPlan(plan), allocations: 0 }
    : await insertedCounts(db, plan, allocations);
  return {
    period,
    grp_id: grpId,
    student_id: studentId,
    dry_run: !!input.dryRun,
    planned: plan,
    counts,
    group_done: groupDone,
    next_student_id: nextStudent,
    next_grp_id: nextGrp,
  };
}

async function insertedCounts(
  db: AppDb,
  plan: readonly PlannedCharge[],
  allocations: readonly { id: string }[],
): Promise<GenCounts> {
  if (!plan.length && !allocations.length)
    return { fees: 0, concessions: 0, sponsored: 0, allocations: 0 };
  const present = new Set(
    (
      await db.all<{ id: string }>(
        sql`SELECT id FROM charge WHERE ${inJson(
          sql`id`,
          plan.map((c) => c.id),
        )}`,
      )
    ).map((r) => r.id),
  );
  const [a] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM receipt_allocation WHERE ${inJson(
      sql`id`,
      allocations.map((x) => x.id),
    )}`,
  );
  return {
    ...countPlan(plan.filter((c) => present.has(c.id))),
    allocations: a?.n ?? 0,
  };
}

/**
 * Where a resumable run stands, in one read: the first group (by id) with billable enrolments whose
 * latest fees chunk is missing or unfinished, and its cursor. null = the period is complete.
 */
export async function generationCursor(
  db: AppDb,
  period: string,
): Promise<{ grp_id: string; after_student_id: string | null } | null> {
  const [row] = await db.all<{ grp_id: string; next_student_id: string | null }>(sql`
    WITH g AS (SELECT DISTINCT e.grp_id FROM enrolment e WHERE ${eligible(period)}),
    last AS (
      SELECT k.grp_id, k.done, k.next_student_id,
             row_number() OVER (PARTITION BY k.grp_id ORDER BY k.created_at DESC, k.id DESC) AS rn
      FROM billing_chunk k JOIN billing_run r ON r.id = k.run_id
      WHERE r.period_key = ${period} AND k.kind = 'fees' AND k.grp_id IS NOT NULL)
    SELECT g.grp_id, l.next_student_id FROM g LEFT JOIN last l ON l.grp_id = g.grp_id AND l.rn = 1
    WHERE l.done IS NULL OR l.done = 0
    ORDER BY g.grp_id LIMIT 1`);
  return row ? { grp_id: row.grp_id, after_student_id: row.next_student_id ?? null } : null;
}

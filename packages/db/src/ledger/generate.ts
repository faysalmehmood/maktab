import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { allocationsStatement, creditSources, openDues, planCredit } from './alloc';
import type { AllocationInput } from './index';
import {
  addDays,
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
 *        days when asked (monthly heads only), rounded half-up to the rupee. Pro-rata follows the
 *        enrolment chain: a mid-month transfer bills the old row's days at its rate and the new
 *        row's days at its rate, once, on the current enrolment.
 *   K  = live concessions in creation order: pct of G (rounded half-up to the rupee) or fixed,
 *        each capped so ΣK ≤ G.
 *   N  = G − K, what is actually owed.
 *   S  = per sponsor, its latest-starting live sponsorship: share% of N (rounded), capped so ΣS ≤ N
 *        (a sponsor's rows never add up; the DB refuses overlapping rows); each sponsor is its own
 *        root `fee` with payer_type 'sponsor'.
 *   Family root = G − ΣS, with the concession lines −K under it, so the family's net is N − ΣS.
 *   (Every party's share is of the post-concession amount; the family line shows the discount.)
 *
 * Liveness (PLAN §14.7): a concession or sponsorship applies to a period when it is live on the
 * period's FIRST day — or, for an enrolment that starts later in the period, on its first day. A
 * change mid-month (end + new row) therefore affects the next period only; regenerateForStudent uses
 * the same rule.
 *
 * Due date: the school's due day; for a mid-period joiner (the enrolment chain starts in the period),
 * no earlier than its start plus the same grace the month gives everyone (due day − 1 days). A
 * mid-month transfer continues its chain and keeps the normal due date. Late fines skip the first period of a
 * new enrolment (fines.ts).
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
  valid_from: string;
  valid_to: string | null;
  /** First day it no longer applies (endConcession). */
  ended_at: string | null;
};
export type LiveSponsorship = {
  id: string;
  sponsor_id: string;
  student_id: string;
  fee_head_id: string | null;
  share_pct: number;
  valid_from: string;
  valid_to: string | null;
};
/** An earlier enrolment in the chain (prev_enrolment_id) that overlaps the period. */
export type ChainSegment = {
  grp_id: string;
  programme_id: string;
  start_date: string;
  end_date: string | null;
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
  /** enrolment id → its predecessors overlapping the period, oldest first (pro-rata). */
  chains: Map<string, ChainSegment[]>;
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

function rateFor(
  ctx: GenContext,
  e: { grp_id: string; programme_id: string },
  headId: string,
): number | null {
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

/** Live on `day`: started, not past valid_to, not ended (ended_at is the first day it stops). */
export const liveOn = (
  r: { valid_from: string; valid_to: string | null; ended_at?: string | null },
  day: string,
): boolean =>
  r.valid_from <= day && (!r.valid_to || r.valid_to >= day) && (!r.ended_at || r.ended_at > day);

/**
 * The day a period's concessions and sponsorships are read on for this enrolment: the period's first
 * day, or the first day the student is in school in it (the chain's start, for a mid-month joiner).
 */
export function referenceDay(ctx: GenContext, e: { id: string; start_date: string }): string {
  const pStart = periodStart(ctx.period);
  const first = ctx.chains.get(e.id)?.[0]?.start_date ?? e.start_date;
  return maxDate(pStart, first);
}

/**
 * Sponsor shares of `owed` (M3a closing pass): ONE row per sponsor — the live row that started
 * latest (ties: the later-created) — never a sum of a sponsor's rows. The database refuses
 * overlapping rows for one sponsor (sponsorship_no_overlap); this keeps rows written before that
 * trigger, or straight into the DB, from silently adding up. Sponsors in creation order of their
 * first row, capped at 100% in total, each rounded half-up to the rupee, ΣS ≤ owed.
 */
export function sponsorShares(
  sponsorships: readonly LiveSponsorship[],
  owed: number,
): { sponsor_id: string; ids: string[]; pct: number; amount: number }[] {
  const pick = new Map<string, LiveSponsorship>();
  for (const s of sponsorships) {
    const cur = pick.get(s.sponsor_id);
    if (!cur || s.valid_from >= cur.valid_from) pick.set(s.sponsor_id, s);
  }
  let pctLeft = 100;
  let total = 0;
  const out: { sponsor_id: string; ids: string[]; pct: number; amount: number }[] = [];
  for (const s of pick.values()) {
    const pct = Math.min(s.share_pct, pctLeft);
    if (pct <= 0) continue;
    pctLeft -= pct;
    const amount = Math.min(roundRupee(owed * pct, 100), owed - total);
    if (amount <= 0) continue;
    total += amount;
    out.push({ sponsor_id: s.sponsor_id, ids: [s.id], pct, amount });
  }
  return out;
}

/** Gross for a monthly head billed by days: every enrolment of the chain for its own days. */
function proRataGross(ctx: GenContext, e: GenEnrolment, headId: string, rate: number): number {
  const p = ctx.period;
  const pStart = periodStart(p);
  const pEnd = periodEnd(p);
  const segs: ChainSegment[] = [...(ctx.chains.get(e.id) ?? []), e];
  let paisaDays = 0;
  let days = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as ChainSegment;
    const next = segs[i + 1];
    // Leave dates are not validated against the start (M1): clamp the overlap to the period, and a
    // segment ends the day before the next one starts.
    const from = maxDate(pStart, seg.start_date);
    let to = minDate(pEnd, seg.end_date ?? pEnd);
    if (next) to = minDate(to, addDays(next.start_date, -1));
    const d = daysInclusive(from, to);
    if (d <= 0) continue;
    const r = i === segs.length - 1 ? rate : (rateFor(ctx, seg, headId) ?? rate);
    paisaDays += r * d;
    days += d;
  }
  const total = daysInPeriod(p);
  if (days <= 0) return 0;
  if (days >= total && paisaDays === rate * total) return rate;
  return roundRupee(paisaDays, total);
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
      if (opts.proRata && h.cadence === 'monthly') gross = proRataGross(ctx, e, h.id, rate);
      if (gross <= 0) continue;
      planned.add(unit);
      const ref = referenceDay(ctx, e);

      const lines: { c: LiveConcession; amount: number }[] = [];
      let k = 0;
      for (const c of ctx.concessions) {
        if (c.student_id !== e.student_id || !concessionApplies(c, h) || !liveOn(c, ref)) continue;
        const want = c.type === 'pct' ? roundRupee(gross * c.value, 100) : c.value;
        const amount = Math.min(want, gross - k);
        if (amount <= 0) continue;
        lines.push({ c, amount });
        k += amount;
      }
      const owed = gross - k;
      const shares = sponsorShares(
        ctx.sponsorships.filter(
          (s) => s.student_id === e.student_id && sponsorshipApplies(s, h) && liveOn(s, ref),
        ),
        owed,
      );
      const sTotal = shares.reduce((a, sh) => a + sh.amount, 0);

      let due = dayOf(p, ctx.settings.dueDay);
      // A mid-period joiner gets the same grace as everyone: start + (due day − 1) days. Only when
      // the enrolment CHAIN starts in the period: a mid-month transfer keeps the normal due date.
      const chainStart = ctx.chains.get(e.id)?.[0]?.start_date ?? e.start_date;
      if (chainStart > pStart) due = maxDate(due, addDays(chainStart, ctx.settings.dueDay - 1));
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
          payer_id: sh.sponsor_id,
          kind: 'fee',
          amount: sh.amount,
          parent_charge_id: null,
          reason: `sponsorship:${sh.ids.join(',')}`,
        });
    }
  }
  return out;
}

/**
 * Rows that could be live on some day of the period (the planner then picks the reference day per
 * enrolment with liveOn): started by its end, not ended before its start.
 */
const liveIn = (from: SQL, to: SQL, ended: SQL | null, p: string) =>
  sql`${from} <= ${periodEnd(p)} AND (${to} IS NULL OR ${to} >= ${periodStart(p)})
      ${ended ? sql`AND (${ended} IS NULL OR ${ended} > ${periodStart(p)})` : sql``}`;

/** Predecessors (prev_enrolment_id, any depth) of these enrolments that overlap the period. */
async function loadChains(
  db: AppDb,
  period: string,
  enrolmentIds: readonly string[],
): Promise<Map<string, ChainSegment[]>> {
  const out = new Map<string, ChainSegment[]>();
  if (!enrolmentIds.length) return out;
  const rows = await db.all<ChainSegment & { root: string; depth: number }>(sql`
    WITH RECURSIVE ch(root, id, prev, depth) AS (
      SELECT e.id, p.id, p.prev_enrolment_id, 1 FROM enrolment e JOIN enrolment p ON p.id = e.prev_enrolment_id
      WHERE ${inJson(sql`e.id`, enrolmentIds)} AND p.end_date >= ${periodStart(period)}
      UNION ALL
      SELECT ch.root, p.id, p.prev_enrolment_id, ch.depth + 1 FROM ch JOIN enrolment p ON p.id = ch.prev
      WHERE ch.depth < 12 AND p.end_date >= ${periodStart(period)})
    SELECT ch.root, ch.depth, p.grp_id, g.programme_id, p.start_date, p.end_date
    FROM ch JOIN enrolment p ON p.id = ch.id JOIN grp g ON g.id = p.grp_id
    WHERE p.start_date <= ${periodEnd(period)}
    ORDER BY ch.root, ch.depth DESC`);
  for (const { root, depth: _d, ...seg } of rows) out.set(root, [...(out.get(root) ?? []), seg]);
  return out;
}

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
  const chains = await loadChains(
    db,
    period,
    enrolments.filter((e) => e.prev_enrolment_id).map((e) => e.id),
  );
  const segs = [...enrolments, ...[...chains.values()].flat()];
  const grps = [...new Set(segs.map((e) => e.grp_id))];
  const progs = [...new Set(segs.map((e) => e.programme_id))];
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
    ? await db.all<LiveConcession>(sql`SELECT id, student_id, fee_head_id, type, value, valid_from,
        valid_to, ended_at FROM concession
        WHERE ${inJson(sql`student_id`, students)}
          AND ${liveIn(sql`valid_from`, sql`valid_to`, sql`ended_at`, period)}
        ORDER BY created_at, id`)
    : [];
  const sponsorships = students.length
    ? await db.all<LiveSponsorship>(sql`SELECT id, sponsor_id, student_id, fee_head_id, share_pct,
        valid_from, valid_to FROM sponsorship WHERE ${inJson(sql`student_id`, students)}
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
    chains,
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

/**
 * Every billable enrolment of these students in the period, whatever the group (a student in a class
 * and a batch is planned from both, primary first, whichever group's chunk reaches them first).
 */
export async function studentsEnrolments(
  db: AppDb,
  period: string,
  studentIds: readonly string[],
): Promise<GenEnrolment[]> {
  if (!studentIds.length) return [];
  return db.all<GenEnrolment>(sql`SELECT ${ENROLMENT_COLUMNS}
    FROM enrolment e JOIN student s ON s.id = e.student_id JOIN grp g ON g.id = e.grp_id
    LEFT JOIN session ss ON ss.id = g.session_id
    WHERE ${inJson(sql`e.student_id`, studentIds)} AND ${eligible(period)}
    ORDER BY e.student_id, e.id`);
}

/**
 * The next group (by id) after `afterGrpId` that still needs a request: billable enrolments and no
 * finished fees chunk for the period. A group that is already done is skipped, so `next` never
 * points at a no-op request.
 */
export async function nextGroup(
  db: AppDb,
  period: string,
  afterGrpId: string | null,
): Promise<string | null> {
  return (await generationCursor(db, period, { afterGrpId }))?.grp_id ?? null;
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
  // Plan from every enrolment of these students (primary first), not only this group's rows.
  const planWith =
    'studentId' in input.scope
      ? enrolments
      : await studentsEnrolments(db, period, [...new Set(enrolments.map((e) => e.student_id))]);
  const ctx = await loadContext(db, period, planWith, settings);
  const full = planCharges(ctx, planWith, { proRata: input.proRata });

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

/** The cron runs every 30 minutes (wrangler.toml triggers); backoff is counted in these ticks. */
export const CRON_TICK_MS = 30 * 60_000;
/**
 * After the n-th consecutive failure a group waits 2^n ticks (1 h, 2 h, 4 h, …) before the cron tries
 * it again, never longer than a day (failedChunkStatements computes it).
 */
export const BACKOFF_CAP_MS = 24 * 3_600_000;
/** This many consecutive failures of one group for a period = attention_required. */
export const ATTENTION_AFTER = 3;

/**
 * Where a resumable run stands, in one read: a group with billable enrolments whose latest fees
 * chunk is missing or unfinished, and its cursor. null = the period is complete.
 *
 * Order (M3a closing pass): with `afterGrpId` (the button's "next"), strictly by group id after it;
 * otherwise healthy or unattempted groups first and groups whose latest chunk FAILED last, so a bad
 * group can never starve the others. With `now` (the cron), a failed group still inside its backoff
 * window (billing_chunk.retry_after) is not offered at all.
 */
export async function generationCursor(
  db: AppDb,
  period: string,
  o: { exclude?: readonly string[]; afterGrpId?: string | null; now?: string | null } = {},
): Promise<{ grp_id: string; after_student_id: string | null } | null> {
  const [row] = await db.all<{ grp_id: string; next_student_id: string | null }>(sql`
    WITH g AS (SELECT DISTINCT e.grp_id FROM enrolment e WHERE ${eligible(period)}),
    last AS (
      SELECT k.grp_id, k.done, k.next_student_id, k.status, k.retry_after,
             row_number() OVER (PARTITION BY k.grp_id ORDER BY k.created_at DESC, k.id DESC) AS rn
      FROM billing_chunk k JOIN billing_run r ON r.id = k.run_id
      WHERE r.period_key = ${period} AND k.kind = 'fees' AND k.grp_id IS NOT NULL)
    SELECT g.grp_id, l.next_student_id, coalesce(l.status = 'failed', 0) AS failing
    FROM g LEFT JOIN last l ON l.grp_id = g.grp_id AND l.rn = 1
    WHERE (l.done IS NULL OR l.done = 0) AND g.grp_id > ${o.afterGrpId ?? ''}
      AND g.grp_id NOT IN (SELECT value FROM json_each(${JSON.stringify(o.exclude ?? [])}))
      ${
        o.now
          ? sql`AND (l.status IS NULL OR l.status <> 'failed' OR l.retry_after IS NULL OR l.retry_after <= ${o.now})`
          : sql``
      }
    ORDER BY ${o.afterGrpId ? sql`` : sql`failing,`} g.grp_id LIMIT 1`);
  return row ? { grp_id: row.grp_id, after_student_id: row.next_student_id ?? null } : null;
}

export type BillingAlert = {
  grp_id: string;
  fail_streak: number;
  error_code: string | null;
  error_message: string | null;
  retry_after: string | null;
  at: string;
  attention_required: boolean;
};

/**
 * Groups whose latest fees chunk for the period failed, with their streak; `attention_required` once
 * the streak reaches ATTENTION_AFTER (the M3b banner; dashboard `billing_alerts` counts those).
 */
export async function failingGroups(db: AppDb, period: string): Promise<BillingAlert[]> {
  const rows = await db.all<Omit<BillingAlert, 'attention_required'>>(sql`
    WITH last AS (
      SELECT k.grp_id, k.status, k.fail_streak, k.error_code, k.error_message, k.retry_after,
             k.created_at,
             row_number() OVER (PARTITION BY k.grp_id ORDER BY k.created_at DESC, k.id DESC) AS rn
      FROM billing_chunk k JOIN billing_run r ON r.id = k.run_id
      WHERE r.period_key = ${period} AND k.kind = 'fees' AND k.grp_id IS NOT NULL)
    SELECT grp_id, fail_streak, error_code, error_message, retry_after, created_at AS at
    FROM last WHERE rn = 1 AND status = 'failed' ORDER BY grp_id`);
  return rows.map((r) => ({ ...r, attention_required: r.fail_streak >= ATTENTION_AFTER }));
}

/**
 * Logs a chunk that failed (status 'failed', done 0, the cursor it started from) so the period never
 * sticks on one bad group: the cursor moves on within this tick, GET /api/fees/runs shows it, and the
 * cron retries it after its backoff. The streak (previous row failed → its streak + 1, else 1) and
 * `retry_after` (now + 2^streak ticks, at most 24 h) are computed inside the insert, so logging needs
 * no read that could fail the same way. One batch; the run header is created if the failed batch
 * rolled it back.
 */
export function failedChunkStatements(o: {
  period: string;
  grpId: string;
  afterStudentId: string | null;
  code: string;
  message: string;
  by: string | null;
  /** ISO instant the backoff is counted from. */
  now: string;
}): SQL[] {
  const tickMin = CRON_TICK_MS / 60_000;
  const capTicks = BACKOFF_CAP_MS / CRON_TICK_MS;
  return [
    sql`INSERT INTO billing_run (id, period_key, run_at, run_by)
        SELECT ${newId()}, ${o.period}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${o.by}
        WHERE NOT EXISTS (SELECT 1 FROM billing_run WHERE period_key = ${o.period})`,
    sql`INSERT INTO billing_chunk (id, run_id, kind, grp_id, student_id, next_student_id, done, status,
          error_code, error_message, fail_streak, retry_after, created_by)
        SELECT ${newId()}, (SELECT id FROM billing_run WHERE period_key = ${o.period}), 'fees', ${o.grpId},
          NULL, ${o.afterStudentId}, 0, 'failed', ${o.code}, ${o.message.slice(0, 500)}, n.streak,
          strftime('%Y-%m-%dT%H:%M:%fZ', ${o.now},
                   '+' || (min(${capTicks}, 1 << min(n.streak, 10)) * ${tickMin}) || ' minutes'),
          ${o.by}
        FROM (SELECT 1 + coalesce((
                SELECT CASE WHEN k.status = 'failed' THEN k.fail_streak ELSE 0 END
                FROM billing_chunk k JOIN billing_run r ON r.id = k.run_id
                WHERE r.period_key = ${o.period} AND k.kind = 'fees' AND k.grp_id = ${o.grpId}
                ORDER BY k.created_at DESC, k.id DESC LIMIT 1), 0) AS streak) n`,
  ];
}

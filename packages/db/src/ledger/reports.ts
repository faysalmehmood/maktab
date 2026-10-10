import { duesHash } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import type { PayerType, PaymentMethod } from './index';
import { inJson, periodEnd, periodStart } from './util';

/**
 * Read models over the ledger (PLAN §14.4–14.7, §14.11). Everything is derived from charges,
 * allocations and receipts at query time; nothing here is stored.
 */

/** A root charge with its tree folded into columns (child lines are never separate dues). */
export type RootLine = {
  id: string;
  student_id: string;
  student_name: string;
  admission_no: string;
  fee_head_id: string;
  head_name: string;
  head_name_ur: string | null;
  head_kind: string;
  period_key: string;
  due_date: string;
  payer_type: PayerType;
  payer_id: string;
  gross: number;
  concession: number;
  /** fines net of waivers (and fine reversals) */
  fine: number;
  /** reversal lines on the fee itself */
  adjustment: number;
  net: number;
  paid: number;
  due: number;
  status: 'paid' | 'partial' | 'overdue' | 'due';
};

const rootColumns = sql`c.id, c.student_id, st.name AS student_name, st.admission_no, c.fee_head_id,
  h.name AS head_name, h.name_ur AS head_name_ur, h.kind AS head_kind, c.period_key, c.due_date,
  c.payer_type, c.payer_id, c.amount AS gross,
  coalesce((SELECT sum(x.amount) FROM charge x WHERE x.parent_charge_id = c.id AND x.kind = 'concession'), 0) AS concession,
  coalesce((SELECT sum(x.amount) FROM charge x WHERE (x.parent_charge_id = c.id AND x.kind = 'fine')
            OR x.parent_charge_id IN (SELECT f.id FROM charge f WHERE f.parent_charge_id = c.id AND f.kind = 'fine')), 0) AS fine,
  coalesce((SELECT sum(x.amount) FROM charge x WHERE x.parent_charge_id = c.id AND x.kind = 'reversal'), 0) AS adjustment,
  cs.net, cs.paid, cs.due, cs.status`;

const rootFrom = sql`charge c JOIN charge_status cs ON cs.id = c.id JOIN student st ON st.id = c.student_id
  JOIN fee_head h ON h.id = c.fee_head_id`;

export async function rootLines(db: AppDb, where: SQL, order?: SQL): Promise<RootLine[]> {
  return db.all<RootLine>(sql`SELECT ${rootColumns} FROM ${rootFrom}
    WHERE c.parent_charge_id IS NULL AND ${where}
    ORDER BY ${order ?? sql`c.due_date, c.period_key, st.name, h.name, c.id`}`);
}

export async function payerCredit(
  db: AppDb,
  payerType: PayerType,
  payerId: string,
): Promise<number> {
  const [c] = await db.all<{ credit: number }>(
    sql`SELECT credit FROM payer_credit WHERE payer_type = ${payerType} AND payer_id = ${payerId}`,
  );
  return c?.credit ?? 0;
}

export type ReceiptAllocationLine = {
  charge_id: string;
  student_id: string;
  student_name: string;
  admission_no: string;
  fee_head_id: string;
  head_name: string;
  head_name_ur: string | null;
  period_key: string;
  amount: number;
};

export type ReceiptRow = {
  id: string;
  receipt_no: string;
  kind: 'payment' | 'reversal' | 'refund' | 'opening';
  reverses_id: string | null;
  reversed_by: string | null;
  payer_type: PayerType;
  payer_id: string;
  payer_name: string | null;
  amount: number;
  method: PaymentMethod;
  account_id: string | null;
  collector_id: string;
  collector_name: string | null;
  cash_session_id: string | null;
  business_date: string;
  reference: string | null;
  note: string | null;
  created_at: string;
};

const receiptColumns = sql`r.id, r.receipt_no, r.kind, r.reverses_id,
  (SELECT v.id FROM receipt v WHERE v.reverses_id = r.id) AS reversed_by,
  r.payer_type, r.payer_id,
  CASE r.payer_type WHEN 'family' THEN (SELECT name FROM family WHERE id = r.payer_id)
                    ELSE (SELECT name FROM sponsor WHERE id = r.payer_id) END AS payer_name,
  r.amount, r.method, r.account_id, r.collector_id, u.name AS collector_name, r.cash_session_id,
  r.business_date, r.reference, r.note, r.created_at`;

export type ReceiptDetail = ReceiptRow & {
  /** Net per charge (a release or unwind folds into its pair). */
  allocations: ReceiptAllocationLine[];
  allocated: number;
  /** What this receipt left unallocated (credit it added; 0 for reversals and refunds). */
  unallocated: number;
  payer_credit: number;
  payer_due: number;
};

export async function receiptDetail(db: AppDb, id: string): Promise<ReceiptDetail | null> {
  const [r] = await db.all<ReceiptRow>(
    sql`SELECT ${receiptColumns} FROM receipt r LEFT JOIN "user" u ON u.id = r.collector_id WHERE r.id = ${id}`,
  );
  if (!r) return null;
  const allocations = await db.all<ReceiptAllocationLine>(sql`
    SELECT a.charge_id, c.student_id, st.name AS student_name, st.admission_no, c.fee_head_id,
           h.name AS head_name, h.name_ur AS head_name_ur, c.period_key, sum(a.amount) AS amount
    FROM receipt_allocation a JOIN charge c ON c.id = a.charge_id JOIN student st ON st.id = c.student_id
    JOIN fee_head h ON h.id = c.fee_head_id
    WHERE a.receipt_id = ${id}
    GROUP BY a.charge_id HAVING sum(a.amount) <> 0
    ORDER BY st.name, c.period_key, h.name`);
  const allocated = allocations.reduce((s, a) => s + a.amount, 0);
  const [due] = await db.all<{
    due: number;
  }>(sql`SELECT coalesce(sum(due), 0) AS due FROM charge_status
    WHERE payer_type = ${r.payer_type} AND payer_id = ${r.payer_id} AND due > 0`);
  const credit = await payerCredit(db, r.payer_type, r.payer_id);
  return {
    ...r,
    allocations,
    allocated,
    unallocated: r.kind === 'payment' || r.kind === 'opening' ? r.amount - allocated : 0,
    payer_credit: credit,
    // What the payer still owes: dues net of unallocated credit (floor 0).
    payer_due: Math.max(0, (due?.due ?? 0) - credit),
  };
}

export async function receiptsOf(
  db: AppDb,
  payerType: PayerType,
  payerId: string,
  limit = 50,
): Promise<ReceiptRow[]> {
  return db.all<ReceiptRow>(sql`SELECT ${receiptColumns} FROM receipt r LEFT JOIN "user" u ON u.id = r.collector_id
    WHERE r.payer_type = ${payerType} AND r.payer_id = ${payerId}
    ORDER BY r.business_date DESC, r.created_at DESC, r.id DESC LIMIT ${limit}`);
}

export type FamilyStatement = {
  family: { id: string; name: string; area: string | null };
  students: {
    id: string;
    name: string;
    admission_no: string;
    status: string;
    group: string | null;
    sponsored: boolean;
  }[];
  /** Family-payer roots: every open one, plus settled ones from the last 12 months. */
  charges: RootLine[];
  /** What sponsors are billed for this family's children (shown, never collected here). */
  sponsored: RootLine[];
  receipts: ReceiptRow[];
  credit: number;
  /** duesHash of the open family roots; the fee counter echoes it as expected_due_hash. */
  dues_hash: string;
  totals: {
    gross: number;
    concession: number;
    fine: number;
    net: number;
    paid: number;
    /** Net of unallocated credit (floor 0). */
    due: number;
    /** Net of unallocated credit (floor 0). */
    overdue: number;
    due_before_credit: number;
  };
};

/**
 * Dues net of a payer's unallocated credit, floor 0 (M3 fix pass). Credit and dues can coexist for a
 * moment (credit released by a concession, money paid in advance before the month is billed); what the
 * family owes, what the defaulter list and reminders say, is always the net.
 */
export const netOfCredit = (due: number, credit: number): number => Math.max(0, due - credit);

export async function familyStatement(
  db: AppDb,
  familyId: string,
  today: string,
): Promise<FamilyStatement | null> {
  const [family] = await db.all<{ id: string; name: string; area: string | null }>(
    sql`SELECT id, name, area FROM family WHERE id = ${familyId}`,
  );
  if (!family) return null;
  const students = await db.all<{
    id: string;
    name: string;
    admission_no: string;
    status: string;
    group: string | null;
    sponsored: number;
  }>(sql`SELECT s.id, s.name, s.admission_no, s.status,
      (SELECT p.name || ' ' || g.name FROM enrolment e JOIN grp g ON g.id = e.grp_id
         JOIN programme p ON p.id = g.programme_id
       WHERE e.student_id = s.id AND e.status = 'active' ORDER BY e.is_primary DESC LIMIT 1) AS "group",
      EXISTS (SELECT 1 FROM sponsorship sp WHERE sp.student_id = s.id AND sp.valid_from <= ${today}
              AND (sp.valid_to IS NULL OR sp.valid_to >= ${today})) AS sponsored
    FROM student s WHERE s.family_id = ${familyId} ORDER BY s.admission_date, s.name`);
  const since = new Date(`${today}T00:00:00Z`);
  since.setUTCMonth(since.getUTCMonth() - 12);
  const cutoff = since.toISOString().slice(0, 7);
  const charges = await rootLines(
    db,
    sql`c.payer_type = 'family' AND c.payer_id = ${familyId} AND (cs.due <> 0 OR c.period_key >= ${cutoff})`,
  );
  const sponsored = await rootLines(
    db,
    sql`c.payer_type = 'sponsor' AND c.period_key >= ${cutoff}
        AND c.student_id IN (SELECT id FROM student WHERE family_id = ${familyId})`,
  );
  const totals = {
    gross: 0,
    concession: 0,
    fine: 0,
    net: 0,
    paid: 0,
    due: 0,
    overdue: 0,
    due_before_credit: 0,
  };
  for (const c of charges) {
    totals.gross += c.gross;
    totals.concession += c.concession;
    totals.fine += c.fine;
    totals.net += c.net;
    totals.paid += c.paid;
    totals.due_before_credit += Math.max(0, c.due);
    if (c.due > 0 && c.due_date < today) totals.overdue += c.due;
  }
  const credit = await payerCredit(db, 'family', familyId);
  totals.due = netOfCredit(totals.due_before_credit, credit);
  totals.overdue = netOfCredit(totals.overdue, credit);
  return {
    family,
    students: students.map((s) => ({ ...s, sponsored: !!s.sponsored })),
    charges,
    sponsored,
    receipts: await receiptsOf(db, 'family', familyId),
    credit,
    dues_hash: duesHash(charges),
    totals,
  };
}

export type FamilyHit = {
  family_id: string;
  family_name: string;
  students: { id: string; name: string; admission_no: string; group: string | null }[];
  due: number;
  credit: number;
};

/**
 * Fee-counter search (PLAN §14.4): student name, admission number, or guardian phone (digits; a
 * leading 0 / +92 is normalised) → families with their dues. At most 20 families.
 */
export async function searchFamilies(db: AppDb, q: string): Promise<FamilyHit[]> {
  const text = q.trim();
  if (!text) return [];
  const digits = text.replace(/\D/g, '');
  const phone =
    digits.length >= 6 ? (digits.startsWith('0') ? `92${digits.slice(1)}` : digits) : null;
  const like = `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const fams = await db.all<{ id: string; name: string }>(sql`SELECT f.id, f.name FROM family f
    WHERE f.id IN (
      SELECT s.family_id FROM student s WHERE s.name LIKE ${like} ESCAPE '\\' OR s.admission_no = ${text}
      UNION
      SELECT g.family_id FROM guardian g WHERE ${phone ?? ''} <> ''
        AND (g.phone LIKE ${`%${phone ?? '-'}%`} OR g.whatsapp LIKE ${`%${phone ?? '-'}%`}))
    ORDER BY f.name LIMIT 20`);
  if (!fams.length) return [];
  const ids = fams.map((f) => f.id);
  const students = await db.all<{
    id: string;
    family_id: string;
    name: string;
    admission_no: string;
    group: string | null;
  }>(sql`SELECT s.id, s.family_id, s.name, s.admission_no,
      (SELECT p.name || ' ' || g.name FROM enrolment e JOIN grp g ON g.id = e.grp_id
         JOIN programme p ON p.id = g.programme_id
       WHERE e.student_id = s.id AND e.status = 'active' ORDER BY e.is_primary DESC LIMIT 1) AS "group"
    FROM student s WHERE ${inJson(sql`s.family_id`, ids)} ORDER BY s.name`);
  const dues = await db.all<{ payer_id: string; due: number }>(sql`SELECT payer_id, sum(due) AS due
    FROM charge_status WHERE payer_type = 'family' AND due > 0 AND ${inJson(sql`payer_id`, ids)}
    GROUP BY payer_id`);
  const credits = await db.all<{ payer_id: string; credit: number }>(sql`SELECT payer_id, credit
    FROM payer_credit WHERE payer_type = 'family' AND ${inJson(sql`payer_id`, ids)}`);
  return fams.map((f) => ({
    family_id: f.id,
    family_name: f.name,
    students: students.filter((s) => s.family_id === f.id).map(({ family_id: _f, ...s }) => s),
    due: netOfCredit(
      dues.find((d) => d.payer_id === f.id)?.due ?? 0,
      credits.find((c) => c.payer_id === f.id)?.credit ?? 0,
    ),
    credit: credits.find((c) => c.payer_id === f.id)?.credit ?? 0,
  }));
}

export type DefaulterRow = {
  student_id: string;
  student_name: string;
  admission_no: string;
  family_id: string;
  family_name: string;
  grp_id: string | null;
  group: string | null;
  /** distinct periods with money overdue */
  months_overdue: number;
  overdue: number;
  /** all money due, overdue or not */
  due: number;
  oldest_period: string;
  sponsored: boolean;
};

/**
 * Students whose family owes money past its due date (PLAN §14.5): by group, months overdue and
 * amount; `excludeSponsored` drops students with a live sponsorship. Family-payer roots only (a
 * sponsor's unpaid share never makes a family a defaulter). `studentScope` narrows rows (teacher).
 */
export async function defaulters(
  db: AppDb,
  o: {
    today: string;
    grpId?: string | null;
    minMonths?: number;
    minAmount?: number;
    excludeSponsored?: boolean;
    studentScope?: SQL;
    limit?: number;
  },
): Promise<DefaulterRow[]> {
  const sponsoredSql = sql`EXISTS (SELECT 1 FROM sponsorship sp WHERE sp.student_id = st.id
    AND sp.valid_from <= ${o.today} AND (sp.valid_to IS NULL OR sp.valid_to >= ${o.today}))`;
  const rows = await db.all<
    Omit<DefaulterRow, 'sponsored'> & { sponsored: number; credit: number }
  >(sql`
    SELECT st.id AS student_id, st.name AS student_name, st.admission_no, st.family_id, f.name AS family_name,
      e.grp_id, CASE WHEN g.id IS NULL THEN NULL ELSE p.name || ' ' || g.name END AS "group",
      count(DISTINCT CASE WHEN cs.due_date < ${o.today} THEN cs.period_key END) AS months_overdue,
      sum(CASE WHEN cs.due_date < ${o.today} THEN cs.due ELSE 0 END) AS overdue,
      sum(cs.due) AS due, min(cs.period_key) AS oldest_period, ${sponsoredSql} AS sponsored,
      coalesce((SELECT pc.credit FROM payer_credit pc WHERE pc.payer_type = 'family' AND pc.payer_id = st.family_id), 0) AS credit
    FROM charge_status cs JOIN student st ON st.id = cs.student_id JOIN family f ON f.id = st.family_id
    LEFT JOIN enrolment e ON e.id = (SELECT e2.id FROM enrolment e2 WHERE e2.student_id = st.id
                                      AND e2.status = 'active' ORDER BY e2.is_primary DESC, e2.start_date DESC LIMIT 1)
    LEFT JOIN grp g ON g.id = e.grp_id LEFT JOIN programme p ON p.id = g.programme_id
    WHERE cs.payer_type = 'family' AND cs.due > 0
      ${o.grpId ? sql`AND st.id IN (SELECT student_id FROM enrolment WHERE grp_id = ${o.grpId} AND status = 'active')` : sql``}
      ${o.studentScope ? sql`AND ${o.studentScope}` : sql``}
      ${o.excludeSponsored ? sql`AND NOT ${sponsoredSql}` : sql``}
    GROUP BY st.id
    HAVING overdue > 0 AND months_overdue >= ${o.minMonths ?? 1}
    ORDER BY st.family_id, oldest_period, st.name, st.id`);
  // Net of the family's unallocated credit (floor 0), spent oldest first across its children — the
  // order credit would be applied in — so a family whose credit covers its dues is not a defaulter.
  const left = new Map<string, { overdue: number; due: number }>();
  const out: DefaulterRow[] = [];
  for (const { credit, sponsored, ...r } of rows) {
    const c = left.get(r.family_id) ?? { overdue: credit, due: credit };
    const overdue = netOfCredit(r.overdue, c.overdue);
    const due = netOfCredit(r.due, c.due);
    c.overdue = Math.max(0, c.overdue - r.overdue);
    c.due = Math.max(0, c.due - r.due);
    left.set(r.family_id, c);
    if (overdue <= 0 || overdue < (o.minAmount ?? 1)) continue;
    out.push({ ...r, overdue, due, sponsored: !!sponsored });
  }
  return out
    .sort((a, b) => b.overdue - a.overdue || a.student_name.localeCompare(b.student_name))
    .slice(0, o.limit ?? 1000);
}

export type CollectionRow = {
  collector_id: string;
  collector_name: string | null;
  method: string;
  payments: number;
  received: number;
  reversed: number;
  refunded: number;
  net: number;
};

/** Money in by collector and method over business dates (opening credit is not money; excluded). */
export async function collectionByCollector(
  db: AppDb,
  o: { from: string; to: string },
): Promise<CollectionRow[]> {
  return db.all<CollectionRow>(sql`SELECT r.collector_id, u.name AS collector_name, r.method,
      sum(r.kind = 'payment') AS payments,
      coalesce(sum(CASE WHEN r.kind = 'payment' THEN r.amount END), 0) AS received,
      coalesce(sum(CASE WHEN r.kind = 'reversal' THEN r.amount END), 0) AS reversed,
      coalesce(sum(CASE WHEN r.kind = 'refund' THEN r.amount END), 0) AS refunded,
      sum(r.amount) AS net
    FROM receipt r LEFT JOIN "user" u ON u.id = r.collector_id
    WHERE r.kind IN ('payment', 'reversal', 'refund') AND r.business_date BETWEEN ${o.from} AND ${o.to}
    GROUP BY r.collector_id, r.method ORDER BY u.name, r.collector_id, r.method`);
}

export type RegisterRow = RootLine & { father_name: string | null; roll_no: string | null };

/**
 * Fee register (PLAN §14.11): every root billed in the period through an enrolment in this group
 * (a mid-month transfer shows in the group that billed it), family and sponsor payers, one row per
 * (student, head, payer). Roots with no enrolment (opening balances) show for students enrolled here.
 */
export async function feeRegister(
  db: AppDb,
  o: { grpId: string; period: string },
): Promise<RegisterRow[]> {
  const enrolled = sql`(SELECT e.student_id FROM enrolment e WHERE e.grp_id = ${o.grpId}
    AND e.start_date <= ${periodEnd(o.period)} AND (e.end_date IS NULL OR e.end_date >= ${periodStart(o.period)}))`;
  return db.all<RegisterRow>(sql`SELECT ${rootColumns}, st.father_name,
      (SELECT e.roll_no FROM enrolment e WHERE e.grp_id = ${o.grpId} AND e.student_id = st.id
       ORDER BY e.start_date DESC LIMIT 1) AS roll_no
    FROM ${rootFrom}
    WHERE c.parent_charge_id IS NULL AND c.period_key = ${o.period} AND c.student_id IN ${enrolled}
      AND (c.enrolment_id IS NULL OR c.enrolment_id IN (SELECT id FROM enrolment WHERE grp_id = ${o.grpId}))
    ORDER BY CAST(roll_no AS INTEGER), st.name, h.name, c.payer_type, c.id`);
}

export type ConcessionRegisterRow = {
  id: string;
  student_id: string;
  student_name: string;
  admission_no: string;
  fee_head_id: string | null;
  head_name: string | null;
  type: string;
  value: number;
  reason: string;
  note: string | null;
  approved_by_name: string | null;
  valid_from: string;
  valid_to: string | null;
  ended_at: string | null;
  end_reason: string | null;
  /** Σ concession lines charged under this concession (positive paisa), within the period range. */
  amount_given: number;
};

export async function concessionRegister(
  db: AppDb,
  o: { from?: string | null; to?: string | null; reason?: string | null; activeOn?: string | null },
): Promise<ConcessionRegisterRow[]> {
  const range = sql`${o.from ? sql`AND x.period_key >= ${o.from}` : sql``} ${o.to ? sql`AND x.period_key <= ${o.to}` : sql``}`;
  return db.all<ConcessionRegisterRow>(sql`SELECT k.id, k.student_id, st.name AS student_name, st.admission_no,
      k.fee_head_id, h.name AS head_name, k.type, k.value, k.reason, k.note, u.name AS approved_by_name,
      k.valid_from, k.valid_to, k.ended_at, k.end_reason,
      -coalesce((SELECT sum(x.amount) FROM charge x WHERE x.kind IN ('concession', 'reversal')
                 AND x.reason = 'concession:' || k.id ${range}), 0) AS amount_given
    FROM concession k JOIN student st ON st.id = k.student_id LEFT JOIN fee_head h ON h.id = k.fee_head_id
    LEFT JOIN "user" u ON u.id = k.approved_by
    WHERE 1 ${o.reason ? sql`AND k.reason = ${o.reason}` : sql``}
      ${o.activeOn ? sql`AND k.valid_from <= ${o.activeOn} AND (k.valid_to IS NULL OR k.valid_to >= ${o.activeOn}) AND (k.ended_at IS NULL OR k.ended_at > ${o.activeOn})` : sql``}
    ORDER BY st.name, k.created_at`);
}

export type SponsorStatement = {
  sponsor: { id: string; name: string; phone: string | null };
  sponsorships: {
    id: string;
    student_id: string;
    student_name: string;
    fee_head_id: string | null;
    share_pct: number;
    valid_from: string;
    valid_to: string | null;
  }[];
  charges: RootLine[];
  receipts: ReceiptRow[];
  credit: number;
  dues_hash: string;
  totals: { net: number; paid: number; due: number };
};

export async function sponsorStatement(
  db: AppDb,
  sponsorId: string,
): Promise<SponsorStatement | null> {
  const [sponsor] = await db.all<{ id: string; name: string; phone: string | null }>(
    sql`SELECT id, name, phone FROM sponsor WHERE id = ${sponsorId}`,
  );
  if (!sponsor) return null;
  const sponsorships = await db.all<
    SponsorStatement['sponsorships'][number]
  >(sql`SELECT sp.id, sp.student_id,
      st.name AS student_name, sp.fee_head_id, sp.share_pct, sp.valid_from, sp.valid_to
    FROM sponsorship sp JOIN student st ON st.id = sp.student_id WHERE sp.sponsor_id = ${sponsorId}
    ORDER BY st.name, sp.valid_from`);
  const charges = await rootLines(db, sql`c.payer_type = 'sponsor' AND c.payer_id = ${sponsorId}`);
  const totals = charges.reduce(
    (t, c) => ({ net: t.net + c.net, paid: t.paid + c.paid, due: t.due + Math.max(0, c.due) }),
    { net: 0, paid: 0, due: 0 },
  );
  return {
    sponsor,
    sponsorships,
    charges,
    receipts: await receiptsOf(db, 'sponsor', sponsorId),
    credit: await payerCredit(db, 'sponsor', sponsorId),
    dues_hash: duesHash(charges),
    totals,
  };
}

/** Teacher-safe dues summary per student for given students (no receipts, no payments detail). */
export async function duesSummary(db: AppDb, studentIds: readonly string[], today: string) {
  if (!studentIds.length) return [];
  return db.all<{ student_id: string; due: number; overdue: number; months_overdue: number }>(sql`
    SELECT cs.student_id, sum(cs.due) AS due,
      sum(CASE WHEN cs.due_date < ${today} THEN cs.due ELSE 0 END) AS overdue,
      count(DISTINCT CASE WHEN cs.due_date < ${today} THEN cs.period_key END) AS months_overdue
    FROM charge_status cs WHERE cs.payer_type = 'family' AND cs.due > 0
      AND ${inJson(sql`cs.student_id`, studentIds)}
    GROUP BY cs.student_id`);
}

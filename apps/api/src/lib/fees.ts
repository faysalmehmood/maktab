import {
  type AppDb,
  allocationsStatement,
  chargeStatements,
  chunkLogStatement,
  concessionStatement,
  expectedSql,
  feeSettings,
  type GenEnrolment,
  loadContext,
  periodOf,
  planCharges,
  planCreditForFamilies,
  type ReceiptDetail,
  receiptDetail,
  type SessionRow,
  siblingPct,
} from '@maktab/db';
import {
  type AdmissionFeesDto,
  type CashSessionDto,
  newId,
  type PlannedChargeDto,
  RECEIPT_LABELS,
  type ReceiptPrintDto,
} from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import { ApiError } from './errors';

/**
 * Fee plumbing shared by the fee, receipt, cash and admission routes. The money rules live in
 * @maktab/db's ledger; this file shapes inputs and outputs for HTTP.
 */

export const toPlannedDto = (c: {
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
}): PlannedChargeDto => ({
  id: c.id,
  student_id: c.student_id,
  enrolment_id: c.enrolment_id,
  fee_head_id: c.fee_head_id,
  head_name: c.head_name,
  period_key: c.period_key,
  payer_type: c.payer_type,
  payer_id: c.payer_id,
  kind: c.kind,
  amount: c.amount,
  due_date: c.due_date,
  parent_charge_id: c.parent_charge_id,
  reason: c.reason,
});

export type AdmissionFeesInput = {
  enrolmentId: string;
  studentId: string;
  familyId: string;
  /** null for a family created in the same batch. */
  existingFamily: boolean;
  grpId: string;
  startDate: string;
  today: string;
  by: string;
  proRata: boolean;
  sibling: boolean;
};

/**
 * PLAN §14.2 step 5: the first period's charges for a new enrolment (admission + current month,
 * with the sibling rule's concession), as statements for the admission batch, plus the preview.
 * The billed period is the later of the start month and the current month (admission never
 * backfills); `once` heads (admission fee) are included. Due no earlier than the admission day.
 */
export async function planAdmissionFees(
  db: AppDb,
  input: AdmissionFeesInput,
): Promise<{ dto: AdmissionFeesDto; statements: SQL[] }> {
  const settings = await feeSettings(db);
  const [g] = await db.all<{
    programme_id: string;
    session_id: string | null;
    is_primary: number;
    span_start: string | null;
    span_end: string | null;
  }>(sql`SELECT g.programme_id, g.session_id, g.is_primary,
      coalesce(g.start_date, s.start_date) AS span_start, coalesce(g.end_date, s.end_date) AS span_end
    FROM grp g LEFT JOIN session s ON s.id = g.session_id WHERE g.id = ${input.grpId}`);
  if (!g) throw new ApiError(400, 'invalid', 'Unknown group');
  const startPeriod = periodOf(input.startDate);
  const nowPeriod = periodOf(input.today);
  const period = startPeriod > nowPeriod ? startPeriod : nowPeriod;
  const enrol: GenEnrolment = {
    id: input.enrolmentId,
    student_id: input.studentId,
    family_id: input.familyId,
    grp_id: input.grpId,
    programme_id: g.programme_id,
    session_id: g.session_id,
    start_date: input.startDate,
    end_date: null,
    prev_enrolment_id: null,
    is_primary: g.is_primary,
    span_start: g.span_start,
    span_end: g.span_end,
  };
  const ctx = await loadContext(db, period, [enrol], settings);
  // nth child = this one plus the family's other active students.
  const [others] = input.existingFamily
    ? await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM student
        WHERE family_id = ${input.familyId} AND status = 'active' AND id <> ${input.studentId}`)
    : [{ n: 0 }];
  const nth = (others?.n ?? 0) + 1;
  const pct = siblingPct(settings.siblingRule, nth);
  const hasSibling = ctx.concessions.some((c) => c.student_id === input.studentId);
  const applySibling = input.sibling && pct > 0 && !hasSibling;
  const statements: SQL[] = [];
  if (applySibling) {
    const id = newId();
    ctx.concessions.push({
      id,
      student_id: input.studentId,
      fee_head_id: null,
      type: 'pct',
      value: pct,
    });
    statements.push(
      concessionStatement({
        id,
        studentId: input.studentId,
        feeHeadId: null,
        type: 'pct',
        value: pct,
        reason: 'sibling',
        note: `sibling rule: child ${nth} of the family (auto at admission)`,
        approvedBy: input.by,
        validFrom: input.startDate,
      }),
    );
  }
  const dueNotBefore = input.today > input.startDate ? input.today : input.startDate;
  const plan = planCharges(ctx, [enrol], {
    admission: true,
    proRata: input.proRata,
    dueNotBefore,
  });
  if (plan.length) {
    const credit = input.existingFamily
      ? await planCreditForFamilies(db, [input.familyId], plan, 50)
      : [];
    statements.push(...chargeStatements(period, plan, input.by));
    const alloc = allocationsStatement(credit, true);
    if (alloc) statements.push(alloc);
    statements.push(
      chunkLogStatement({
        period,
        kind: 'fees',
        grpId: null,
        studentId: input.studentId,
        nextStudentId: null,
        done: true,
        plan,
        allocationIds: credit.map((a) => a.id),
        by: input.by,
      }),
    );
  }
  const net = (payer: 'family' | 'sponsor') =>
    plan.filter((c) => c.payer_type === payer).reduce((a, c) => a + c.amount, 0);
  return {
    dto: {
      period,
      charges: plan.map(toPlannedDto),
      sibling: { nth, pct, applied: applySibling },
      total_family: net('family'),
      total_sponsor: net('sponsor'),
    },
    statements,
  };
}

/** Sessions with live figures: an open session's expected is computed now. */
export async function sessionDtos(db: AppDb, rows: SessionRow[]): Promise<CashSessionDto[]> {
  const out: CashSessionDto[] = [];
  for (const s of rows) {
    const [live] = await db.all<{ expected: number; collector_name: string | null }>(
      sql`SELECT ${expectedSql(s.id)} AS expected, (SELECT name FROM "user" WHERE id = ${s.collector_id}) AS collector_name`,
    );
    const byMethod = await db.all<{ method: string; amount: number; count: number }>(sql`
      SELECT method, sum(amount) AS amount, count(*) AS count FROM receipt
      WHERE cash_session_id = ${s.id} GROUP BY method ORDER BY method`);
    out.push({
      id: s.id,
      collector_id: s.collector_id,
      collector_name: live?.collector_name ?? null,
      business_date: s.business_date,
      opening: s.opening,
      expected: s.closed_at && s.expected != null ? s.expected : (live?.expected ?? s.opening),
      counted: s.counted,
      variance: s.variance,
      closed_at: s.closed_at,
      closed_by: s.closed_by,
      reopened_by: s.reopened_by,
      reopened_at: s.reopened_at,
      reopen_reason: s.reopen_reason,
      by_method: byMethod,
    });
  }
  return out;
}

/** The print-ready receipt (PLAN §14.4): school header, both label sets, one block per child. */
export async function receiptPrint(db: AppDb, id: string): Promise<ReceiptPrintDto | null> {
  const r: ReceiptDetail | null = await receiptDetail(db, id);
  if (!r) return null;
  const [school] = await db.all<{
    name: string;
    name_ur: string | null;
    address: string | null;
    phone: string | null;
    logo_key: string | null;
    default_lang: 'en' | 'ur';
  }>(
    sql`SELECT name, name_ur, address, phone, logo_key, default_lang FROM school ORDER BY created_at LIMIT 1`,
  );
  const blocks = new Map<string, ReceiptPrintDto['students'][number]>();
  for (const a of r.allocations) {
    const b = blocks.get(a.student_id) ?? {
      student_id: a.student_id,
      student_name: a.student_name,
      admission_no: a.admission_no,
      lines: [],
      subtotal: 0,
    };
    b.lines.push({
      charge_id: a.charge_id,
      period_key: a.period_key,
      head_name: a.head_name,
      head_name_ur: a.head_name_ur,
      amount: a.amount,
    });
    b.subtotal += a.amount;
    blocks.set(a.student_id, b);
  }
  const { allocations: _a, allocated, unallocated, payer_credit, payer_due, ...receipt } = r;
  return {
    school: {
      name: school?.name ?? '',
      name_ur: school?.name_ur ?? null,
      address: school?.address ?? null,
      phone: school?.phone ?? null,
      has_logo: !!school?.logo_key,
    },
    labels: RECEIPT_LABELS,
    lang: school?.default_lang ?? 'ur',
    receipt: receipt as ReceiptPrintDto['receipt'],
    students: [...blocks.values()],
    totals: {
      amount: r.amount,
      allocated,
      credit_added: unallocated,
      payer_due,
      payer_credit,
    },
    reversed: !!r.reversed_by,
  };
}

/**
 * Message rows for families, one per family (PLAN §14.9): WhatsApp (manual send) to the first
 * guardian with consent and a number, else a "call" row; cooldown via reminder_state unless
 * `cooldownDays` is null. Same guardian choice as the M2 absence queue.
 */
export function familyMessageStatements(o: {
  template: string;
  today: string;
  by: string;
  cooldownDays: number | null;
  /** [{m: message id, f: family id, p: payload object}] */
  rows: { m: string; f: string; p: Record<string, unknown> }[];
}): SQL[] {
  if (!o.rows.length) return [];
  const json = JSON.stringify(o.rows.map((r) => ({ m: r.m, f: r.f, p: JSON.stringify(r.p) })));
  const firstWith = (cond: SQL) => sql`(SELECT g2.id FROM guardian g2
      WHERE g2.family_id = x.f AND ${cond} ORDER BY g2.priority, g2.created_at, g2.id LIMIT 1)`;
  const hasNumber = sql`COALESCE(NULLIF(g2.whatsapp, ''), NULLIF(g2.phone, '')) IS NOT NULL`;
  const cooldown =
    o.cooldownDays == null
      ? sql``
      : sql`AND NOT EXISTS (SELECT 1 FROM reminder_state rs WHERE rs.family_id = x.f
              AND rs.template_key = ${o.template}
              AND rs.last_sent_on > date(${o.today}, ${`-${o.cooldownDays} days`}))`;
  const insert = sql`INSERT INTO message (id, family_id, guardian_id, channel, template_key, lang, payload, status, created_by)
        SELECT y.m, y.f, COALESCE(y.wa, y.callg), CASE WHEN y.wa IS NOT NULL THEN 'wa_manual' ELSE 'call' END,
               ${o.template}, COALESCE((SELECT lang FROM guardian WHERE id = COALESCE(y.wa, y.callg)), 'ur'),
               y.p, 'queued', ${o.by}
        FROM (SELECT x.m, x.f, x.p,
                     ${firstWith(sql`g2.consent_whatsapp = 1 AND ${hasNumber}`)} AS wa,
                     COALESCE(${firstWith(hasNumber)}, ${firstWith(sql`1`)}) AS callg
              FROM (SELECT json_extract(value, '$.m') AS m, json_extract(value, '$.f') AS f,
                           json_extract(value, '$.p') AS p FROM json_each(${json})) x
              WHERE EXISTS (SELECT 1 FROM family WHERE id = x.f) ${cooldown}) y`;
  if (o.cooldownDays == null) return [insert];
  return [
    insert,
    sql`INSERT INTO reminder_state (family_id, template_key, last_sent_on)
        SELECT family_id, ${o.template}, ${o.today} FROM message
        WHERE id IN (SELECT json_extract(value, '$.m') FROM json_each(${json}))
        ON CONFLICT (family_id, template_key) DO UPDATE SET last_sent_on = excluded.last_sent_on
          WHERE excluded.last_sent_on > reminder_state.last_sent_on`,
  ];
}

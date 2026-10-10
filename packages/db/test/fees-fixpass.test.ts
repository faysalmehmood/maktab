import { duesHash, newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import {
  addConcession,
  applyLateFines,
  closeSession,
  collect,
  concessionRegister,
  defaulters,
  endConcession,
  familyStatement,
  generateCharges,
  generationCursor,
  nextGroup,
  openDues,
  receiptDetail,
  recordOpeningBalance,
  regenerateForStudent,
  reopenSession,
  runScheduled,
  sessionFor,
  voidCharge,
  waiveFine,
} from '../src/ledger';
import { createTestDb } from '../src/node';

/**
 * M3a fix pass: every bug the independent review reproduced (its scenario script, review-m3a/scen.ts)
 * and every attack it found ALLOWED, as permanent tests. Every test ends with ledger_consistency empty.
 */

type Row = Record<string, unknown>;
const RS = (n: number) => n * 100;
let db: AppDb;
const all = (q: SQL) => db.all<Row>(q);
const run = (...qs: string[]) =>
  atomic(
    db,
    () => qs.map((q) => rawStatement(db, sql.raw(q))) as [ReturnType<typeof rawStatement>],
  );
const consistency = () => all(sql`SELECT * FROM ledger_consistency`);

async function expectFail(fn: () => Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected failure ${pattern}`).toBeDefined();
  const parts: string[] = [];
  for (let e: unknown = caught, d = 0; e && d < 4; d++) {
    parts.push(
      e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e),
    );
    e = e instanceof Error ? e.cause : undefined;
  }
  expect(parts.join(' | ')).toMatch(pattern);
}

/** The reviewer's world (scen.ts): two classes, a sponsored child, a late joiner, a transfer. */
async function seed() {
  await run(
    `INSERT INTO "user" (id, email, name, status) VALUES ('U1','a@x','Admin','active'),('U2','b@x','Acct','active')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at, fine_rule, sibling_rule) VALUES ('SCH','T','R','2026-04-01','{"enabled":true,"grace_day":10,"type":"fixed","value":20000,"cap":null}','[{"nth":2,"pct":10}]')`,
    `INSERT INTO session (id, name, start_date, end_date, is_current) VALUES ('SES','2026-27','2026-04-01','2027-03-31',1)`,
    `INSERT INTO programme (id, name, kind) VALUES ('P5','Class 5','grade'),('P6','Class 6','grade')`,
    `INSERT INTO grp (id, programme_id, session_id, name) VALUES ('G5A','P5','SES','A'),('G5B','P5','SES','B'),('G6','P6','SES','A')`,
    `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI','Tuition','tuition','monthly'),('ADM','Admission','admission','once')`,
    `INSERT INTO fee_rate (id, fee_head_id, programme_id, grp_id, amount, effective_from) VALUES
      ('r1','TUI','P5',NULL,${RS(3000)},'2026-04-01'),('r2','TUI',NULL,'G5B',${RS(3500)},'2026-04-01'),
      ('r3','TUI','P6',NULL,${RS(4000)},'2026-04-01'),('r4','ADM','P5',NULL,${RS(5000)},'2026-04-01'),
      ('r5','TUI','P5',NULL,${RS(3200)},'2026-11-01')`,
    `INSERT INTO family (id, name) VALUES ('F1','Khan'),('F2','Ahmed'),('F3','Bibi'),('F4','New')`,
    `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES
      ('S1','F1','0001','Ali','2026-04-01'),('S2','F1','0002','Sara','2026-04-01'),('S3','F2','0003','Omar','2026-04-01'),
      ('S4','F3','0004','Zara','2026-04-01'),('S5','F4','0005','Late','2026-10-20'),('S6','F4','0006','Mover','2026-04-01')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES
      ('E1','S1','G5A',1,'2026-04-01'),('E2','S2','G6',1,'2026-04-01'),('E3','S3','G5B',1,'2026-04-01'),
      ('E4','S4','G5A',1,'2026-04-01'),('E5','S5','G5A',1,'2026-10-20')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, end_date, status) VALUES ('E6a','S6','G5A',0,'2026-04-01','2026-10-15','transferred')`,
    `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, prev_enrolment_id) VALUES ('E6b','S6','G5B',1,'2026-10-16','E6a')`,
    `INSERT INTO sponsor (id, name) VALUES ('SP','Trust')`,
    `INSERT INTO sponsorship (id, sponsor_id, student_id, fee_head_id, share_pct, valid_from) VALUES ('SH','SP','S4',NULL,50,'2026-04-01')`,
    `INSERT INTO account (id, name, kind) VALUES ('CASH','Drawers','cash'),('BANK','Bank','bank')`,
  );
}

beforeEach(async () => {
  db = createTestDb();
  await seed();
});

const genAll = async (period: string, proRata = false) => {
  for (let cur = await generationCursor(db, period); cur; cur = await generationCursor(db, period))
    await generateCharges(db, {
      period,
      scope: { grpId: cur.grp_id, afterStudentId: cur.after_student_id },
      by: 'U1',
      proRata,
    });
};
const pay = (payer: string, amount: number, day: string, extra: Record<string, unknown> = {}) =>
  collect(db, {
    payerType: 'family',
    payerId: payer,
    amount,
    method: 'cash',
    businessDate: day,
    today: day,
    collectorId: 'U2',
    idempotencyKey: newId(),
    ...extra,
  });
const roots = (student: string, period: string) =>
  all(sql`SELECT c.id, c.fee_head_id AS h, c.payer_type AS pt, c.payer_id AS pi, c.amount AS a,
      n.net, n.paid, c.due_date AS d, c.enrolment_id AS e, c.reason AS r
    FROM charge c JOIN charge_net n ON n.id = c.id
    WHERE c.student_id = ${student} AND c.period_key = ${period} ORDER BY c.fee_head_id, c.payer_type`);
const rootId = async (student: string, period: string, payer = 'family', head = 'TUI') =>
  (
    await all(sql`SELECT id FROM charge WHERE student_id = ${student} AND period_key = ${period}
      AND fee_head_id = ${head} AND payer_type = ${payer} AND parent_charge_id IS NULL`)
  )[0]?.id as string;
const credit = async (payer: string) =>
  ((await all(sql`SELECT credit FROM payer_credit WHERE payer_id = ${payer}`))[0]?.credit ??
    0) as number;

describe('H1 overlapping sponsorships never stick generation', () => {
  it("reviewer's December repro: two rows of one sponsor merge into one root; every group bills", async () => {
    await genAll('2026-10');
    // A second, overlapping row for the same sponsor (the route now refuses this; the DB allows it).
    await run(
      `INSERT INTO sponsorship (id, sponsor_id, student_id, share_pct, valid_from) VALUES ('SH3','SP','S4',60,'2026-12-01')`,
    );
    await genAll('2026-12');
    expect(await generationCursor(db, '2026-12')).toBeNull();
    const perGroup = await all(sql`SELECT e.grp_id, count(*) AS n FROM charge c
      JOIN enrolment e ON e.id = c.enrolment_id WHERE c.period_key = '2026-12' AND c.parent_charge_id IS NULL
      GROUP BY 1 ORDER BY 1`);
    expect(perGroup.map((r) => r.grp_id)).toEqual(['G5A', 'G5B', 'G6']);
    // 50% + 60% caps at 100% and is ONE sponsor root; the family owes nothing for December tuition.
    expect(await roots('S4', '2026-12')).toEqual([
      expect.objectContaining({ pt: 'sponsor', pi: 'SP', a: RS(3200), r: 'sponsorship:SH,SH3' }),
    ]);
    expect(await consistency()).toEqual([]);
  });

  it('cron logs a failing group, bills every other group, still fines, and retries after its backoff', async () => {
    await run(
      `CREATE TRIGGER test_boom BEFORE INSERT ON charge WHEN NEW.student_id = 'S3' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const now = Date.parse('2026-12-20T03:00:00Z');
    const r1 = await runScheduled(db, { now });
    expect(r1.failed).toEqual([
      { grp_id: 'G5B', code: 'constraint', message: expect.stringMatching(/boom/) },
    ]);
    expect(r1.generated.map((g) => g.grp_id)).toEqual(['G5A', 'G6']);
    expect(r1.fines[0]?.applied).toBeGreaterThan(0);
    const failed = await all(sql`SELECT grp_id, done, status, error_code, next_student_id
      FROM billing_chunk WHERE status = 'failed'`);
    expect(failed).toEqual([
      { grp_id: 'G5B', done: 0, status: 'failed', error_code: 'constraint', next_student_id: null },
    ]);
    // The cursor still points at the failed group: it is retried, not forgotten.
    expect(await generationCursor(db, '2026-12')).toEqual({
      grp_id: 'G5B',
      after_student_id: null,
    });
    await run('DROP TRIGGER test_boom');
    // Inside its backoff (2 ticks after the first failure) the cron leaves it alone.
    expect((await runScheduled(db, { now: now + 1_800_000 })).generated).toEqual([]);
    const r2 = await runScheduled(db, { now: now + 3_600_000 });
    expect(r2.failed).toEqual([]);
    expect(r2.generated.map((g) => g.grp_id)).toEqual(['G5B']);
    expect(await generationCursor(db, '2026-12')).toBeNull();
    expect((await roots('S3', '2026-12')).length).toBe(1);
    expect(await consistency()).toEqual([]);
  });
});

describe('H2 business date', () => {
  it("reviewer's 2025-12-31 repro: a backdated collection is refused, no session or series opened", async () => {
    await genAll('2026-10');
    await expectFail(
      () => pay('F1', RS(50), '2025-12-31', { today: '2026-10-10' }),
      /bad_business_date|must be today/,
    );
    await expectFail(
      () => pay('F1', RS(50), '2026-10-11', { today: '2026-10-10' }),
      /must be today/,
    );
    expect(await all(sql`SELECT * FROM cash_session`)).toEqual([]);
    expect(await all(sql`SELECT * FROM receipt_series`)).toEqual([]);
  });

  it('yesterday: owner/admin only, with a reason, audited, into TODAY’s drawer and series year', async () => {
    await genAll('2026-12');
    await expectFail(
      () => pay('F1', RS(50), '2026-12-31', { today: '2027-01-01' }),
      /Only an owner or admin/,
    );
    await expectFail(
      () => pay('F1', RS(50), '2026-12-31', { today: '2027-01-01', allowYesterday: true }),
      /needs a reason/,
    );
    const r = await pay('F1', RS(50), '2026-12-31', {
      today: '2027-01-01',
      allowYesterday: true,
      backdateReason: 'forgot to enter',
    });
    const [rc] = await all(sql`SELECT r.receipt_no, r.business_date, s.business_date AS session_day
      FROM receipt r JOIN cash_session s ON s.id = r.cash_session_id WHERE r.id = ${r.receipt_id}`);
    // Never a session for a past date; never a number from an earlier year's series.
    expect(rc).toEqual({
      receipt_no: 'R-2027-00001',
      business_date: '2026-12-31',
      session_day: '2027-01-01',
    });
    expect(await all(sql`SELECT business_date FROM cash_session`)).toEqual([
      { business_date: '2027-01-01' },
    ]);
    const audit = await all(
      sql`SELECT action, json_extract(diff, '$.reason') AS reason, json_extract(diff, '$.receipt_no') AS no
          FROM audit WHERE entity_id = ${r.receipt_id} ORDER BY action`,
    );
    expect(audit).toEqual([
      { action: 'backdate', reason: 'forgot to enter', no: 'R-2027-00001' },
      { action: 'collect', reason: null, no: 'R-2027-00001' },
    ]);
    expect(await consistency()).toEqual([]);
  });
});

describe('M3 liveness = the row live on the period’s first day', () => {
  it('end 12-15 + new from 12-16: December uses the old row only; regenerate agrees', async () => {
    const old = await addConcession(db, {
      studentId: 'S2',
      feeHeadId: null,
      type: 'pct',
      value: 10,
      reason: 'sibling',
      approvedBy: 'U1',
      validFrom: '2026-04-01',
    });
    await endConcession(db, { id: old, endedAt: '2026-12-15', reason: 'changed', by: 'U1' });
    const fresh = await addConcession(db, {
      studentId: 'S2',
      feeHeadId: null,
      type: 'pct',
      value: 25,
      reason: 'sibling',
      approvedBy: 'U1',
      validFrom: '2026-12-16',
    });
    await genAll('2026-12');
    const kids = () =>
      all(sql`SELECT reason, amount FROM charge WHERE student_id = 'S2' AND period_key = ${'2026-12'}
        AND kind = 'concession'`);
    expect(await kids()).toEqual([{ reason: `concession:${old}`, amount: -RS(400) }]);
    const rg = await regenerateForStudent(db, { studentId: 'S2', period: '2026-12', by: 'U1' });
    expect(rg.late_concessions).toEqual([]);
    expect(await kids()).toHaveLength(1);
    // January: only the new row is live on 01-01.
    await genAll('2027-01');
    expect(
      await all(sql`SELECT reason, amount FROM charge WHERE student_id = 'S2'
        AND period_key = '2027-01' AND kind = 'concession'`),
    ).toEqual([{ reason: `concession:${fresh}`, amount: -RS(1000) }]);
    // A concession ended ON the 1st is not live that month.
    const c4 = await addConcession(db, {
      studentId: 'S4',
      feeHeadId: null,
      type: 'pct',
      value: 33,
      reason: 'needy',
      approvedBy: 'U1',
      validFrom: '2026-04-01',
    });
    await endConcession(db, { id: c4, endedAt: '2027-02-01', reason: 'x', by: 'U1' });
    await genAll('2027-02');
    expect(
      await all(
        sql`SELECT 1 FROM charge WHERE student_id = 'S4' AND period_key = '2027-02' AND kind = 'concession'`,
      ),
    ).toEqual([]);
    expect(await consistency()).toEqual([]);
  });
});

describe('M4 due date and fines for a mid-period joiner', () => {
  it('admitted 10-20: due 10-29 (start + grace), not fined on 10-21 nor later in October', async () => {
    await genAll('2026-10', true);
    expect(await roots('S5', '2026-10')).toEqual([
      expect.objectContaining({ h: 'ADM', d: '2026-10-29' }),
      expect.objectContaining({ h: 'TUI', d: '2026-10-29', a: RS(1161) }),
    ]);
    for (const asOf of ['2026-10-21', '2026-10-31']) {
      await applyLateFines(db, { period: '2026-10', asOf, by: null });
    }
    const fined = await all(
      sql`SELECT DISTINCT student_id FROM charge WHERE kind = 'fine' ORDER BY 1`,
    );
    expect(fined.map((r) => r.student_id)).not.toContain('S5');
    expect(fined.map((r) => r.student_id)).toContain('S1');
    // November is a normal month for S5.
    await genAll('2026-11');
    await applyLateFines(db, { period: '2026-11', asOf: '2026-11-11', by: null });
    expect(
      await all(
        sql`SELECT 1 FROM charge WHERE kind = 'fine' AND student_id = 'S5' AND period_key = '2026-11'`,
      ),
    ).toHaveLength(1);
    expect(await consistency()).toEqual([]);
  });
});

describe('M5 pro-rata across an enrolment chain', () => {
  it("reviewer's S6: transferred 10-15 → 10-16 bills 15 days at 5-A and 16 at 5-B, once", async () => {
    await genAll('2026-10', true);
    const s6 = (await roots('S6', '2026-10')).filter((r) => r.h === 'TUI');
    // (3000 × 15 + 3500 × 16) / 31 = Rs 3,258.06 → Rs 3,258; on the current enrolment; transfer grace.
    expect(s6).toEqual([
      expect.objectContaining({ a: RS(3258), e: 'E6b', d: '2026-10-25', pt: 'family' }),
    ]);
    // Without pro-rata the month is billed whole, once, at the current group's rate.
    db = createTestDb();
    await seed();
    await genAll('2026-10');
    expect((await roots('S6', '2026-10')).filter((r) => r.h === 'TUI')).toEqual([
      expect.objectContaining({ a: RS(3500), e: 'E6b' }),
    ]);
  });
});

describe('M6 credit after regenerate and waiver; dues net of credit', () => {
  it('regenerate releases into credit and applies it to the next due in the same call', async () => {
    await genAll('2026-10');
    await genAll('2026-11');
    await pay('F2', RS(3500), '2026-10-05');
    await addConcession(db, {
      studentId: 'S3',
      feeHeadId: null,
      type: 'pct',
      value: 50,
      reason: 'orphan',
      approvedBy: 'U1',
      validFrom: '2026-10-01',
    });
    const rg = await regenerateForStudent(db, { studentId: 'S3', period: '2026-10', by: 'U1' });
    expect([rg.counts.released, rg.counts.credit_applied]).toEqual([RS(1750), RS(1750)]);
    expect(await credit('F2')).toBe(0);
    expect((await roots('S3', '2026-11'))[0]).toMatchObject({ net: RS(3500), paid: RS(1750) });
    expect(await consistency()).toEqual([]);
  });

  it('a waiver on a paid root: the released fine money pays the next month', async () => {
    await genAll('2026-10');
    await genAll('2026-11');
    await applyLateFines(db, { period: '2026-10', asOf: '2026-10-11', by: null });
    const [fine] = await all(sql`SELECT id FROM charge WHERE kind = 'fine' AND student_id = 'S3'`);
    await pay('F2', RS(3700), '2026-10-12');
    const w = await waiveFine(db, { fineId: fine?.id as string, reason: 'hardship', by: 'U1' });
    expect([w.released, w.credit_applied]).toEqual([RS(200), RS(200)]);
    expect(await credit('F2')).toBe(0);
    expect((await roots('S3', '2026-11'))[0]).toMatchObject({ paid: RS(200) });
    expect(await consistency()).toEqual([]);
  });

  it('defaulters, the family view, search and receipts net dues of credit', async () => {
    await genAll('2026-10');
    // Opening credit is recorded but not yet applied: dues and credit coexist.
    await recordOpeningBalance(db, {
      studentId: 'S3',
      amount: -RS(3500),
      asOf: '2026-09-30',
      by: 'U1',
    });
    await recordOpeningBalance(db, {
      studentId: 'S1',
      amount: -RS(1000),
      asOf: '2026-09-30',
      by: 'U1',
    });
    const d = await defaulters(db, { today: '2026-10-20' });
    expect(d.map((r) => r.student_id)).not.toContain('S3');
    // F1 owes 3000 (S1) + 3600 (S2) overdue, credit 1000 → spent on the oldest first.
    const f1 = d.filter((r) => r.family_id === 'F1');
    expect(f1.reduce((a, r) => a + r.overdue, 0)).toBe(RS(3000 + 4000 - 1000));
    const st = await familyStatement(db, 'F2', '2026-10-20');
    expect(st?.totals).toMatchObject({ due: 0, overdue: 0, due_before_credit: RS(3500) });
    expect(await consistency()).toEqual([]);
  });
});

describe('L7 ledger triggers (reviewer ALLOWED attacks)', () => {
  beforeEach(async () => {
    await genAll('2026-10');
  });

  it('A3c / A4: no concession or fine line on a sponsor root', async () => {
    const sp = await rootId('S4', '2026-10', 'sponsor');
    await expectFail(
      () =>
        run(
          `INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind, parent_charge_id) VALUES ('cs','S4','TUI','2026-10','sponsor','SP',-100,'2026-10-10','concession','${sp}')`,
        ),
      /a sponsor root takes reversals only/,
    );
    await expectFail(
      () =>
        run(
          `INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind, parent_charge_id) VALUES ('fs','S4','TUI','2026-10','sponsor','SP',100,'2026-10-21','fine','${sp}')`,
        ),
      /a sponsor root takes reversals only/,
    );
    expect(await consistency()).toEqual([]);
  });

  it('A5: no fine on a root with nothing due', async () => {
    await pay('F2', RS(3500), '2026-10-05');
    const s3 = await rootId('S3', '2026-10');
    await expectFail(
      () =>
        run(
          `INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind, parent_charge_id) VALUES ('fp','S3','TUI','2026-10','family','F2',100,'2026-10-21','fine','${s3}')`,
        ),
      /a fine needs money still due/,
    );
    const f = await applyLateFines(db, { period: '2026-10', asOf: '2026-10-21', by: null });
    expect(f.planned.map((p) => p.student_id)).not.toContain('S3');
  });

  it('A11c: a cash payment needs a session and its series number; non-cash an account', async () => {
    await expectFail(
      () =>
        run(
          `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key) VALUES ('rz','R-2026-99999','payment','family','F3',100,'cash','U2','2026-10-06','kx4')`,
        ),
      /a cash payment needs a cash session/,
    );
    await run(
      `INSERT INTO cash_session (id, collector_id, business_date) VALUES ('CS','U2','2026-10-06')`,
      `INSERT INTO receipt_series (series, year, next_no) VALUES ('R', 2026, 3)`,
    );
    await expectFail(
      () =>
        run(
          `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, cash_session_id, business_date, idempotency_key) VALUES ('rz','R-2026-99999','payment','family','F3',100,'cash','U2','CS','2026-10-06','kx4')`,
        ),
      /receipt number must be the next number/,
    );
    await expectFail(
      () =>
        run(
          `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key) VALUES ('rb','B-1','payment','family','F3',100,'bank','U2','2026-10-06','kx5')`,
        ),
      /non-cash payment names its account/,
    );
    await expectFail(
      () =>
        run(
          `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, account_id, collector_id, cash_session_id, business_date, idempotency_key) VALUES ('rb','B-1','payment','family','F3',100,'bank','BANK','U2','CS','2026-10-06','kx5')`,
        ),
      /non-cash payment names its account/,
    );
    // The helper's shape passes: R-2026-00003 is the number the bump just took.
    await run(
      `UPDATE receipt_series SET next_no = next_no + 1`,
      `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, cash_session_id, business_date, idempotency_key) VALUES ('ok','R-2026-00003','payment','family','F3',100,'cash','U2','CS','2026-10-06','kx6')`,
    );
    expect(await consistency()).toEqual([]);
  });

  it('a non-cash collection opens no drawer session and must name the account', async () => {
    await expectFail(
      () => pay('F1', RS(100), '2026-10-05', { method: 'bank' }),
      /account_required|needs the account/,
    );
    const r = await pay('F1', RS(100), '2026-10-05', { method: 'cheque', accountId: 'BANK' });
    expect(
      await all(
        sql`SELECT method, account_id, cash_session_id FROM receipt WHERE id = ${r.receipt_id}`,
      ),
    ).toEqual([{ method: 'cheque', account_id: 'BANK', cash_session_id: null }]);
    expect(await all(sql`SELECT * FROM cash_session`)).toEqual([]);
  });
});

describe('L8 dual enrolment plans from every enrolment, primary first', () => {
  it("the batch group's chunk bills tuition at the primary class's rate", async () => {
    await run(
      `INSERT INTO grp (id, programme_id, session_id, name) VALUES ('G0X','P6','SES','Batch')`,
      `INSERT INTO fee_rate (id, fee_head_id, grp_id, amount, effective_from) VALUES ('rx','TUI','G0X',${RS(9999)},'2026-04-01')`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('EX','S1','G0X',0,'2026-04-01')`,
    );
    // G0X sorts first, so its chunk reaches S1 before G5A's does.
    await generateCharges(db, { period: '2026-10', scope: { grpId: 'G0X' }, by: 'U1' });
    expect((await roots('S1', '2026-10')).filter((r) => r.h === 'TUI')).toEqual([
      expect.objectContaining({ a: RS(3000), e: 'E1' }),
    ]);
  });
});

describe('L9 regenerate re-bills the sponsor share on the new base', () => {
  it('a 20% concession on a 50% sponsored, fully paid month: both shares drop, surplus released', async () => {
    await genAll('2026-10');
    await pay('F3', RS(1500), '2026-10-05');
    const c = await addConcession(db, {
      studentId: 'S4',
      feeHeadId: null,
      type: 'pct',
      value: 20,
      reason: 'needy',
      approvedBy: 'U1',
      validFrom: '2026-10-01',
    });
    const rg = await regenerateForStudent(db, { studentId: 'S4', period: '2026-10', by: 'U1' });
    // N' = 3000 − 600 = 2400; sponsor 50% = 1200 (was 1500); family 1200 (was 1500).
    expect(rg.late_concessions.map((l) => [l.payer_type, l.amount])).toEqual([
      ['sponsor', RS(300)],
      ['family', RS(300)],
    ]);
    expect((await roots('S4', '2026-10')).map((r) => [r.pt, r.net, r.paid])).toEqual([
      ['family', RS(1200), RS(1200)],
      ['sponsor', RS(1200), 0],
    ]);
    expect(await credit('F3')).toBe(RS(300));
    const reg = await concessionRegister(db, {});
    expect(reg.find((r) => r.id === c)?.amount_given).toBe(RS(600));
    // Idempotent.
    const again = await regenerateForStudent(db, { studentId: 'S4', period: '2026-10', by: 'U1' });
    expect(again.late_concessions).toEqual([]);
    expect(await consistency()).toEqual([]);
  });
});

describe('L10 / L11 the counter: dues hash, audit, per-user idempotency', () => {
  beforeEach(async () => {
    await genAll('2026-10');
  });

  it('a stale dues hash is 409 stale_dues; the current one collects; directed ignores it', async () => {
    const seen = duesHash(await openDues(db, 'family', 'F1'));
    await pay('F1', RS(100), '2026-10-05'); // someone else collects first
    await expectFail(
      () => pay('F1', RS(500), '2026-10-05', { expectedDueHash: seen }),
      /stale_dues|Dues changed/,
    );
    const now = duesHash(await openDues(db, 'family', 'F1'));
    const st = await familyStatement(db, 'F1', '2026-10-05');
    expect(st?.dues_hash).toBe(now);
    await pay('F1', RS(500), '2026-10-05', { expectedDueHash: now });
    const s1 = await rootId('S1', '2026-10');
    await pay('F1', RS(100), '2026-10-05', {
      expectedDueHash: seen,
      directed: [{ chargeId: s1, amount: RS(100) }],
    });
    expect(await consistency()).toEqual([]);
  });

  it('a payment writes an audit row with its receipt number; another user replaying the key is refused', async () => {
    const key = 'counter-key-1';
    const r = await pay('F1', RS(100), '2026-10-05', { idempotencyKey: key });
    expect(
      await all(sql`SELECT user_id, action, json_extract(diff, '$.receipt_no') AS no FROM audit
        WHERE entity = 'receipt' AND entity_id = ${r.receipt_id}`),
    ).toEqual([{ user_id: 'U2', action: 'collect', no: 'R-2026-00001' }]);
    expect(await pay('F1', RS(100), '2026-10-05', { idempotencyKey: key })).toEqual({
      receipt_id: r.receipt_id,
      replayed: true,
    });
    await expectFail(
      () => pay('F1', RS(100), '2026-10-05', { idempotencyKey: key, collectorId: 'U1' }),
      /idempotency key was already used/,
    );
    expect((await receiptDetail(db, r.receipt_id))?.receipt_no).toBe('R-2026-00001');
  });
});

describe('L12 void a charge', () => {
  it('a paid fee is voided by a reversal line; the money becomes credit and pays the next due', async () => {
    await genAll('2026-10');
    await genAll('2026-11');
    await pay('F1', RS(3000), '2026-10-05', {
      directed: [{ chargeId: await rootId('S1', '2026-10'), amount: RS(3000) }],
    });
    const s1 = await rootId('S1', '2026-10');
    await expectFail(() => voidCharge(db, { chargeId: s1, reason: ' ', by: 'U1' }), /reason/);
    const v = await voidCharge(db, { chargeId: s1, reason: 'never attended', by: 'U1' });
    expect([v.amount, v.released, v.credit_applied]).toEqual([RS(3000), RS(3000), RS(3000)]);
    expect((await roots('S1', '2026-10'))[0]).toMatchObject({ net: 0, paid: 0 });
    expect(
      await all(sql`SELECT kind, amount, reason FROM charge WHERE parent_charge_id = ${s1}`),
    ).toEqual([{ kind: 'reversal', amount: -RS(3000), reason: 'void: never attended' }]);
    await expectFail(
      () => voidCharge(db, { chargeId: s1, reason: 'again', by: 'U1' }),
      /Nothing is left/,
    );
    // A fine is voided for what is left of it.
    await applyLateFines(db, { period: '2026-11', asOf: '2026-11-11', by: null });
    const [fine] = await all(sql`SELECT id FROM charge WHERE kind = 'fine' AND student_id = 'S2'`);
    const vf = await voidCharge(db, {
      chargeId: fine?.id as string,
      reason: 'bank holiday',
      by: 'U1',
    });
    expect(vf.amount).toBe(RS(200));
    expect(await consistency()).toEqual([]);
  });
});

describe('coordinator fixes', () => {
  it('a reopen reason repeated in another case or spacing is refused (helper and trigger)', async () => {
    await genAll('2026-10');
    await pay('F1', RS(100), '2026-10-05');
    const s = await sessionFor(db, 'U2', '2026-10-05');
    const sid = s?.id as string;
    await closeSession(db, { sessionId: sid, counted: RS(100), by: 'U2' });
    await reopenSession(db, { sessionId: sid, reason: 'Recount', by: 'U1' });
    await closeSession(db, { sessionId: sid, counted: RS(100), by: 'U2' });
    await expectFail(
      () => reopenSession(db, { sessionId: sid, reason: '  recount ', by: 'U1' }),
      /reason_repeated|new reason/,
    );
    await expectFail(
      () =>
        run(
          `UPDATE cash_session SET closed_at = NULL, reopened_by = 'U1', reopened_at = 'z', reopen_reason = ' RECOUNT' WHERE id = '${sid}'`,
        ),
      /reopen reason must differ/,
    );
  });

  it('next group skips groups already done (no no-op request)', async () => {
    await generateCharges(db, { period: '2026-10', scope: { grpId: 'G5B' }, by: 'U1' });
    const a = await generateCharges(db, { period: '2026-10', scope: { grpId: 'G5A' }, by: 'U1' });
    expect(a.next_grp_id).toBe('G6');
    expect(await nextGroup(db, '2026-10', null)).toBe('G6');
    const g6 = await generateCharges(db, { period: '2026-10', scope: { grpId: 'G6' }, by: 'U1' });
    expect(g6.next_grp_id).toBeNull();
  });

  it('a student added after the group’s chunk completed: the cron skips the group; regenerate bills them', async () => {
    await genAll('2026-10');
    await run(
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S9','F2','0009','Later','2026-10-01')`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date) VALUES ('E9','S9','G5A',1,'2026-10-01')`,
    );
    const cron = await runScheduled(db, { now: Date.parse('2026-10-08T03:00:00Z') });
    expect(cron.generated).toEqual([]);
    expect(await roots('S9', '2026-10')).toEqual([]);
    const rg = await regenerateForStudent(db, { studentId: 'S9', period: '2026-10', by: 'U1' });
    expect(rg.counts.fees).toBe(2); // admission + tuition (first period of the enrolment)
    expect(await consistency()).toEqual([]);
  });
});

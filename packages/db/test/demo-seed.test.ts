import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/client';
import {
  advanceDemoSeed,
  DEMO_SEED_WRITE_CAP,
  DEMO_SEED_WRITES,
  DEMO_UNDO_WRITE_CAP,
  DEMO_USERS,
  demoCalendar,
  demoPlan,
  demoStatus,
  estimateUndo,
  isQuotaError,
  markDemoDirty,
  seedDemo,
  startDemoReset,
  startDemoUndo,
} from '../src/demo';
import { collect, incomeExpense, reverseReceipt } from '../src/ledger';
import { createTestDb } from '../src/node';

const SECRET = 'test-parent-link-secret-at-least-32-characters';
/** The seed day the tests pin (a Wednesday mid-month); the dataset is laid out around it. */
const TODAY = '2026-10-14';
const CAL = demoCalendar(TODAY);
const n = async (db: AppDb, q: string) =>
  Number((await db.all<{ n: number }>(sql.raw(q)))[0]?.n ?? 0);

/**
 * What a seed cost on D1: a row write = the row + one per index on its table; updates and the
 * runner's own state writes (`changes` beyond the rows) are counted twice (row + index), which
 * over-counts a little.
 */
async function writesOf(db: AppDb, changes: number): Promise<number> {
  const tables = await db.all<{ name: string; idx: number }>(sql`SELECT m.name,
      (SELECT count(*) FROM sqlite_master i WHERE i.type = 'index' AND i.tbl_name = m.name) AS idx
    FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite%'
      AND m.name NOT IN ('d1_migrations', '__drizzle_migrations', '_demo_state', '_demo_undo')`);
  let rows = 0;
  let writes = 0;
  for (const t of tables) {
    const c = await n(db, `SELECT count(*) n FROM "${t.name}"`);
    rows += c;
    writes += c * (1 + t.idx);
  }
  return writes + Math.max(0, changes - rows) * 2;
}

/** What a reseed must reproduce exactly (ids minted by the ledger helpers excluded). */
async function fingerprint(db: AppDb) {
  const one = async (q: string) => JSON.stringify(await db.all(sql.raw(q)));
  return {
    people: await one(
      `SELECT s.id, s.name, s.admission_no, f.name AS family, g.phone FROM student s
       JOIN family f ON f.id = s.family_id JOIN guardian g ON g.family_id = f.id AND g.priority = 1 ORDER BY s.id`,
    ),
    charges: await one(
      `SELECT c.student_id, h.name AS head, c.period_key, c.kind, c.amount, c.due_date FROM charge c
       JOIN fee_head h ON h.id = c.fee_head_id
       ORDER BY c.student_id, c.period_key, h.name, c.kind, c.amount`,
    ),
    receipts: await one(
      `SELECT receipt_no, kind, payer_id, amount, method, business_date FROM receipt ORDER BY receipt_no`,
    ),
    sessions: await one(
      `SELECT business_date, opening, expected, counted FROM cash_session ORDER BY business_date`,
    ),
    marks: await one(`SELECT status, count(*) FROM att_mark GROUP BY status ORDER BY status`),
    messages: await one(
      `SELECT template_key, status, count(*) FROM message GROUP BY 1, 2 ORDER BY 1, 2`,
    ),
  };
}

describe('demo dataset', () => {
  let db: AppDb;
  let changes0 = 0;
  let changes = 0;
  beforeAll(async () => {
    db = createTestDb();
    const t0 = Date.now();
    changes0 = await n(db, 'SELECT total_changes() n');
    const r = await seedDemo(db, {
      parentSecret: SECRET,
      ownerEmail: 'Owner@Example.com',
      today: TODAY,
    });
    changes = (await n(db, 'SELECT total_changes() n')) - changes0;
    expect(r.phase).toBe('done');
    // The brief: a local seed in well under two minutes.
    expect(Date.now() - t0).toBeLessThan(120_000);
  }, 180_000);

  it('has the promised shape', async () => {
    expect(await n(db, 'SELECT count(*) n FROM school')).toBe(1);
    expect(await n(db, 'SELECT count(*) n FROM student')).toBe(135);
    expect(await n(db, 'SELECT count(*) n FROM family')).toBe(84);
    expect(await n(db, 'SELECT count(*) n FROM grp')).toBe(19);
    expect(await n(db, 'SELECT count(*) n FROM staff')).toBe(14);
    expect(await n(db, 'SELECT count(*) n FROM grp WHERE is_primary = 0')).toBe(2);
    // 30% of families have more than one child here.
    expect(
      await n(
        db,
        'SELECT count(*) n FROM (SELECT family_id FROM student GROUP BY 1 HAVING count(*) > 1)',
      ),
    ).toBe(25);
    expect(await n(db, 'SELECT count(*) n FROM concession')).toBe(12);
    expect(await n(db, 'SELECT count(*) n FROM sponsor')).toBe(3);
    expect(await n(db, 'SELECT count(*) n FROM opening_balance')).toBe(10);
    expect(await n(db, 'SELECT count(*) n FROM parent_link')).toBe(40);
    expect(await n(db, 'SELECT count(*) n FROM staff_advance')).toBe(2);
    // Payslips through last month (14 staff × 5 months); this month's are not prepared yet.
    expect(await n(db, "SELECT count(*) n FROM payslip WHERE status = 'paid'")).toBe(70);
    expect(await n(db, "SELECT count(*) n FROM receipt WHERE kind = 'reversal'")).toBe(4);
    expect(await n(db, "SELECT count(*) n FROM receipt WHERE kind = 'refund'")).toBe(1);
    expect(await n(db, "SELECT count(*) n FROM charge WHERE kind = 'fine'")).toBeGreaterThan(40);
    expect(await n(db, "SELECT count(*) n FROM charge WHERE kind = 'fine_waiver'")).toBeGreaterThan(
      3,
    );
    expect(await n(db, "SELECT count(*) n FROM receipt WHERE kind = 'payment'")).toBeGreaterThan(
      350,
    );
    expect(await n(db, "SELECT count(DISTINCT method) n FROM receipt WHERE kind = 'payment'")).toBe(
      4,
    );
    // Only today's drawer is still open.
    expect(await n(db, `SELECT count(*) n FROM cash_session WHERE closed_at IS NULL`)).toBe(1);
    expect(
      await n(
        db,
        `SELECT count(*) n FROM cash_session WHERE closed_at IS NULL AND business_date = '${TODAY}'`,
      ),
    ).toBe(1);
    expect(await n(db, 'SELECT count(*) n FROM cash_session WHERE variance <> 0')).toBeGreaterThan(
      5,
    );
    expect(await n(db, 'SELECT count(*) n FROM expense WHERE voided_by IS NOT NULL')).toBe(1);
    // One week of registers (the write budget): 5 school days × 19 groups, today's partly taken.
    expect(await n(db, 'SELECT count(DISTINCT date) n FROM att_register')).toBe(5);
    expect(await n(db, 'SELECT count(*) n FROM att_register')).toBeGreaterThan(80);
    expect(await n(db, 'SELECT count(DISTINCT status) n FROM message')).toBe(3);
    expect(await n(db, 'SELECT count(DISTINCT template_key) n FROM message')).toBe(5);
    expect(await n(db, 'SELECT count(*) n FROM audit')).toBeGreaterThan(700);
    // The fixed demo logins plus the installation owner (lower-cased).
    for (const email of [...Object.values(DEMO_USERS), 'owner@example.com'])
      expect(
        await n(db, `SELECT count(*) n FROM "user" WHERE email = '${email}' AND status = 'active'`),
        email,
      ).toBe(1);
  });

  it('collects most of the past months, part of this one, and has real defaulters', async () => {
    const pct = async (cmp: string) =>
      n(
        db,
        `SELECT round(100.0 * sum(paid) / sum(net)) n FROM charge_net
         WHERE payer_type = 'family' AND period_key ${cmp} '${CAL.current}'`,
      );
    const past = await pct('<');
    expect(past).toBeGreaterThanOrEqual(85);
    expect(past).toBeLessThanOrEqual(97);
    // Mid-month: on-time payers are in, late payers still trickling in.
    const now = await pct('=');
    expect(now).toBeGreaterThanOrEqual(40);
    expect(now).toBeLessThanOrEqual(85);
    expect(
      await n(
        db,
        "SELECT count(DISTINCT payer_id) n FROM charge_status WHERE payer_type = 'family' AND due > 0",
      ),
    ).toBeGreaterThan(20);
    // Absence about 5% (3–8%) on the week's registers.
    const abs = await n(db, "SELECT round(1000.0 * sum(status = 'A') / count(*)) n FROM att_mark");
    expect(abs).toBeGreaterThanOrEqual(30);
    expect(abs).toBeLessThanOrEqual(80);
  });

  it('is laid out around the seed day: today is a working day in the middle of its month', async () => {
    const one = async (q: string) =>
      String((await db.all<{ v: string | number | null }>(sql.raw(q)))[0]?.v);
    // Nothing is dated after today.
    for (const q of [
      'SELECT max(business_date) v FROM receipt',
      'SELECT max(date) v FROM expense',
      'SELECT max(date) v FROM att_register',
      'SELECT max(substr(created_at, 1, 10)) v FROM message',
      'SELECT max(business_date) v FROM cash_session',
    ])
      expect(await one(q), q).toBe(TODAY);
    // Six months billed, ending with this one; payslips through last month only.
    expect(await one('SELECT group_concat(DISTINCT period_key) v FROM charge')).toBe(
      CAL.months.join(','),
    );
    expect(await one('SELECT max(period_key) v FROM payslip')).toBe(CAL.months.at(-2));
    // Collected today (cash, in today's open drawer).
    expect(
      await n(
        db,
        `SELECT count(*) n FROM receipt r JOIN cash_session s ON s.id = r.cash_session_id
         WHERE r.business_date = '${TODAY}' AND r.kind = 'payment' AND s.closed_at IS NULL`,
      ),
    ).toBeGreaterThanOrEqual(3);
    // Today's registers partly taken (12 of 19), the week's earlier days complete.
    expect(await n(db, `SELECT count(*) n FROM att_register WHERE date = '${TODAY}'`)).toBe(12);
    expect(
      await n(
        db,
        `SELECT count(*) n FROM att_register r JOIN grp g ON g.id = r.grp_id
         WHERE r.date = '${TODAY}' AND g.name = 'A' AND g.programme_id = (SELECT id FROM programme WHERE name = 'Class 5')`,
      ),
    ).toBe(0);
    // Today's absences are queued for sending; reminders and expenses in this month too.
    expect(
      await n(
        db,
        `SELECT count(*) n FROM message WHERE template_key = 'absence' AND status = 'queued'
         AND json_extract(payload, '$.date') = '${TODAY}'`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await n(db, `SELECT count(*) n FROM expense WHERE date LIKE '${CAL.current}-%'`),
    ).toBeGreaterThan(2);
    expect(
      await n(db, `SELECT count(*) n FROM message WHERE template_key = 'fee_overdue'`),
    ).toBeGreaterThan(0);
    // Sponsors owe the months since they last paid.
    expect(
      await n(
        db,
        "SELECT count(DISTINCT payer_id) n FROM charge_status WHERE payer_type = 'sponsor' AND due > 0",
      ),
    ).toBe(3);
    // The session still is 2026-27 and contains today.
    expect(await one("SELECT name || ' ' || start_date || ' ' || end_date v FROM session")).toBe(
      '2026-27 2026-04-01 2027-03-31',
    );
  });

  it('works for any seed day: a month end, a Sunday, and a day past the session', async () => {
    for (const today of ['2026-10-31', '2026-11-01', '2027-05-03']) {
      const d = createTestDb();
      const c0 = await n(d, 'SELECT total_changes() n');
      const r = await seedDemo(d, { parentSecret: SECRET, today });
      expect(r.phase, today).toBe('done');
      expect(await d.all(sql`SELECT * FROM ledger_consistency`), today).toEqual([]);
      expect(
        await writesOf(d, (await n(d, 'SELECT total_changes() n')) - c0),
        today,
      ).toBeLessThanOrEqual(DEMO_SEED_WRITES);
      const [sess] = await d.all<{ name: string; end_date: string }>(
        sql`SELECT name, end_date FROM session`,
      );
      expect(sess?.name).toBe('2026-27');
      expect((sess?.end_date ?? '') >= today).toBe(true);
      expect(await n(d, `SELECT count(*) n FROM receipt WHERE business_date > '${today}'`)).toBe(0);
      // A Sunday: no counter and no registers today, nothing left open.
      if (today === '2026-11-01')
        expect(await n(d, 'SELECT count(*) n FROM cash_session WHERE closed_at IS NULL')).toBe(0);
    }
  }, 180_000);

  it('fits the D1 write budget (docs/demo.md): a full seed ≤ DEMO_SEED_WRITES ≤ the cap', async () => {
    const writes = await writesOf(db, changes);
    console.log(`demo seed: ~${writes} D1 row writes (budget ${DEMO_SEED_WRITES})`);
    expect(writes).toBeLessThanOrEqual(DEMO_SEED_WRITES);
    expect(DEMO_SEED_WRITES).toBeLessThanOrEqual(DEMO_SEED_WRITE_CAP);
    // Not so far under that the constant stops meaning anything.
    expect(writes).toBeGreaterThan(DEMO_SEED_WRITES * 0.9);
  });

  it('keeps every money rule: ledger_consistency empty, the P&L ties, no FK problem', async () => {
    expect(await db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    const ie = await incomeExpense(db, { from: CAL.months[0] as string, to: CAL.current });
    expect(ie.reconciliation.ties).toBe(true);
    expect(ie.income.total).toBeGreaterThan(0);
    expect(ie.expenses.total).toBeGreaterThan(0);
    expect(ie.salaries.pay).toBeGreaterThan(0);
  });

  it('gives every family a guardian with a number, all of them visibly fake', async () => {
    expect(
      await n(
        db,
        `SELECT count(*) n FROM family f WHERE NOT EXISTS (SELECT 1 FROM guardian g
        WHERE g.family_id = f.id AND coalesce(g.phone, '') <> '')`,
      ),
    ).toBe(0);
    // 03XX 555 NNNN (mobile) or 042 3555 NNNN (landline): the 555 block, nothing else.
    expect(
      await n(
        db,
        "SELECT count(*) n FROM guardian WHERE phone NOT GLOB '923[0-4][0-9]555[0-9][0-9][0-9][0-9]' AND phone NOT GLOB '9242355[0-9][0-9][0-9][0-9][0-9]'",
      ),
    ).toBe(0);
  });

  it('a reset reproduces the same school (wipe + reseed is idempotent and deterministic)', async () => {
    const before = await fingerprint(db);
    await markDemoDirty(db);
    expect((await demoStatus(db)).dirty).toBe(true);
    const r = await seedDemo(db, {
      parentSecret: SECRET,
      ownerEmail: 'owner@example.com',
      today: TODAY,
    });
    expect(r.phase).toBe('done');
    expect(r.dirty).toBe(false);
    expect(await fingerprint(db)).toEqual(before);
    expect(await db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
    // The schema came back whole: every trigger and view the migrations made.
    expect(
      await n(
        db,
        "SELECT count(*) n FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE '!_demo!_%' ESCAPE '!'",
      ),
    ).toBe(97);
    expect(await n(db, "SELECT count(*) n FROM sqlite_master WHERE type = 'view'")).toBe(8);
  }, 180_000);

  it('resumes after being cut off at any point, without writing anything twice', async () => {
    const db2 = createTestDb();
    await startDemoReset(db2, { reason: 'test', today: TODAY });
    let calls = 0;
    // Tiny slices (one step call each), as a Worker tick that runs out of time would leave it.
    for (let i = 0; i < 5000; i++) {
      const r = await advanceDemoSeed(db2, {
        deadline: Number.POSITIVE_INFINITY,
        maxCalls: 1,
        parentSecret: SECRET,
      });
      calls += r.calls;
      if (r.phase === 'done') break;
    }
    expect((await demoStatus(db2)).phase).toBe('done');
    expect(calls).toBeGreaterThan(demoPlan(TODAY).length);
    expect(await fingerprint(db2)).toEqual(await fingerprint(db));
  }, 180_000);

  it('ids do not depend on the order a process asks for them (each Worker isolate is fresh)', async () => {
    const keys = ['user:accountant', 'account:drawer', 'head:tuition', 'user:principal', 'rate:x'];
    const fresh = async (order: string[]) => {
      vi.resetModules();
      const m = await import('../src/demo/world');
      return Object.fromEntries(order.map((k) => [k, m.demoIds(k)]));
    };
    expect(await fresh([...keys].reverse())).toEqual(await fresh(keys));
  });

  it('a reset started by another version of the plan begins again from the wipe', async () => {
    const db3 = createTestDb();
    await startDemoReset(db3, { reason: 'test', today: TODAY });
    await advanceDemoSeed(db3, { deadline: Number.POSITIVE_INFINITY, maxCalls: 8 });
    await db3.run(sql`UPDATE _demo_state SET value = 'old-plan' WHERE key = 'plan'`);
    await db3.run(sql`UPDATE _demo_state SET value = '40' WHERE key = 'step'`);
    const r = await advanceDemoSeed(db3, { deadline: Number.POSITIVE_INFINITY, maxCalls: 1 });
    // Back to the start: the one call allowed ran the wipe's snapshot step (step 0) again.
    expect(r.step).toBe(1);
    expect(
      (await db3.all<{ value: string }>(sql`SELECT value FROM _demo_state WHERE key = 'plan'`))[0]
        ?.value,
    ).not.toBe('old-plan');
  });

  it('the nightly undo puts back exactly what a visitor changed, cheaply, once a UTC day', async () => {
    const before = await fingerprint(db);
    const extra = async () =>
      JSON.stringify(
        await db.all(sql`SELECT (SELECT group_concat(area) FROM family) a,
          (SELECT count(*) FROM holiday) h, (SELECT count(*) FROM receipt) r`),
      );
    const before2 = await extra();
    const one = async (q: string) => String((await db.all<{ v: string }>(sql.raw(q)))[0]?.v);
    // A visitor's afternoon: edits, an insert, a delete, a bank payment and a reversal.
    await db.run(
      sql`UPDATE family SET area = 'Johar Town' WHERE id IN (SELECT id FROM family LIMIT 3)`,
    );
    await db.run(sql`DELETE FROM holiday WHERE rowid = (SELECT min(rowid) FROM holiday)`);
    const fam = await one(
      "SELECT payer_id v FROM charge_status WHERE payer_type = 'family' AND due > 0 LIMIT 1",
    );
    const bank = await one("SELECT id v FROM account WHERE kind = 'bank'");
    const accountant = await one(
      `SELECT id v FROM "user" WHERE email = '${DEMO_USERS.accountant}'`,
    );
    await collect(db, {
      receiptId: 'VISITOR-RECEIPT-1',
      payerType: 'family',
      payerId: fam,
      amount: 1000_00,
      method: 'bank',
      accountId: bank,
      reference: 'TEST-1',
      collectorId: accountant,
      idempotencyKey: 'visitor:1',
      businessDate: TODAY,
      today: TODAY,
    });
    const target = await one(
      "SELECT id v FROM receipt WHERE kind = 'payment' AND method = 'bank' AND id NOT IN (SELECT reverses_id FROM receipt WHERE reverses_id IS NOT NULL) LIMIT 1",
    );
    await reverseReceipt(db, {
      receiptId: target,
      byUserId: accountant,
      reason: 'visitor test',
      series: { series: 'AN', year: 2026 },
      reversalId: 'VISITOR-REVERSAL-1',
      businessDate: TODAY,
      cashSessionId: null,
    });
    expect(await extra()).not.toBe(before2);
    const est = await estimateUndo(db);
    expect(est.entries).toBeGreaterThan(5);
    expect(est.writes).toBeLessThan(DEMO_UNDO_WRITE_CAP);

    // A night well after the seeds above (each one counts as that UTC day's reset).
    const at = Date.parse('2027-01-05T21:00:30Z');
    const u = await startDemoUndo(db, { now: at });
    expect(u).toMatchObject({ started: true });
    for (let i = 0; i < 50 && (await demoStatus(db)).phase === 'undoing'; i++)
      await advanceDemoSeed(db, { deadline: Number.POSITIVE_INFINITY, maxCalls: 4 });
    expect((await demoStatus(db)).phase).toBe('done');
    expect(await extra()).toBe(before2);
    expect(await fingerprint(db)).toEqual(before);
    expect(await db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    expect(await n(db, 'SELECT count(*) n FROM _demo_undo')).toBe(0);
    // The money guards and the log's own triggers are all back.
    expect(
      await n(
        db,
        "SELECT count(*) n FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE '!_demo!_%' ESCAPE '!'",
      ),
    ).toBe(97);
    expect(
      await n(
        db,
        "SELECT count(*) n FROM sqlite_master WHERE type = 'trigger' AND name LIKE '!_demo!_undo!_%' ESCAPE '!'",
      ),
    ).toBeGreaterThan(150);
    // Logging again, and a second reset the same UTC day is refused.
    await db.run(
      sql`UPDATE family SET area = 'Model Town' WHERE id = (SELECT id FROM family LIMIT 1)`,
    );
    expect(await startDemoUndo(db, { now: at + 3_600_000 })).toEqual({
      started: false,
      reason: 'today',
    });
    await expect(startDemoReset(db, { reason: 'x', now: new Date(at) })).rejects.toThrow(/UTC day/);
    // The next day it runs.
    expect(await startDemoUndo(db, { now: at + 86_400_000 })).toMatchObject({ started: true });
    for (let i = 0; i < 10 && (await demoStatus(db)).phase === 'undoing'; i++)
      await advanceDemoSeed(db, { deadline: Number.POSITIVE_INFINITY });
    expect(await fingerprint(db)).toEqual(before);
  }, 60_000);

  it('skips (and does not start) an undo that would cost more than the cap', async () => {
    const big = Array.from(
      { length: 3000 },
      (_, i) => `(${1_000_000 + i}, 'charge', 'I', '{}', NULL)`,
    );
    await db.run(sql.raw(`INSERT INTO _demo_undo (id, tbl, op, pk, old) VALUES ${big.join(',')}`));
    expect((await estimateUndo(db)).writes).toBeGreaterThan(DEMO_UNDO_WRITE_CAP);
    const r = await startDemoUndo(db, { now: Date.parse('2027-02-01T21:00:00Z') });
    expect(r).toMatchObject({ started: false, reason: 'over_budget' });
    expect((await demoStatus(db)).last_error).toMatch(/undo skipped/);
    await db.run(sql`DELETE FROM _demo_undo WHERE id >= 1000000`);
  });

  it('recognises a D1 quota error (then backs off until the next UTC midnight)', () => {
    expect(isQuotaError(new Error('D1_ERROR: Exceeded maximum rows written per day'))).toBe(true);
    expect(
      isQuotaError(new Error('Failed query', { cause: new Error('daily limit reached') })),
    ).toBe(true);
    expect(isQuotaError(new Error('UNIQUE constraint failed: receipt.id'))).toBe(false);
  });

  it('refuses to wipe a database that belongs to another school', async () => {
    const other = createTestDb();
    await other.run(sql`INSERT INTO school (id, name) VALUES ('S', 'Global Science Academy')`);
    await expect(startDemoReset(other, { reason: 'test' })).rejects.toThrow(/belongs to/);
    await expect(startDemoReset(other, { reason: 'test', force: true })).resolves.toMatchObject({
      phase: 'running',
    });
  });
});

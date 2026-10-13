import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '../src/client';
import {
  advanceDemoSeed,
  DEMO_USERS,
  demoPlan,
  demoStatus,
  markDemoDirty,
  seedDemo,
  startDemoReset,
} from '../src/demo';
import { incomeExpense } from '../src/ledger';
import { createTestDb } from '../src/node';

const SECRET = 'test-parent-link-secret-at-least-32-characters';
const n = async (db: AppDb, q: string) =>
  Number((await db.all<{ n: number }>(sql.raw(q)))[0]?.n ?? 0);

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
  beforeAll(async () => {
    db = createTestDb();
    const t0 = Date.now();
    const r = await seedDemo(db, { parentSecret: SECRET, ownerEmail: 'Owner@Example.com' });
    expect(r.phase).toBe('done');
    // The brief: a local seed in well under two minutes.
    expect(Date.now() - t0).toBeLessThan(120_000);
  }, 180_000);

  it('has the promised shape', async () => {
    expect(await n(db, 'SELECT count(*) n FROM school')).toBe(1);
    expect(await n(db, 'SELECT count(*) n FROM student')).toBe(300);
    expect(await n(db, 'SELECT count(*) n FROM family')).toBe(190);
    expect(await n(db, 'SELECT count(*) n FROM grp')).toBe(19);
    expect(await n(db, 'SELECT count(*) n FROM staff')).toBe(14);
    expect(await n(db, 'SELECT count(*) n FROM grp WHERE is_primary = 0')).toBe(2);
    // 30% of families have more than one child here.
    expect(
      await n(
        db,
        'SELECT count(*) n FROM (SELECT family_id FROM student GROUP BY 1 HAVING count(*) > 1)',
      ),
    ).toBe(57);
    expect(await n(db, 'SELECT count(*) n FROM concession')).toBe(20);
    expect(await n(db, 'SELECT count(*) n FROM sponsor')).toBe(3);
    expect(await n(db, 'SELECT count(*) n FROM opening_balance')).toBe(10);
    expect(await n(db, 'SELECT count(*) n FROM parent_link')).toBe(40);
    expect(await n(db, 'SELECT count(*) n FROM staff_advance')).toBe(2);
    expect(await n(db, "SELECT count(*) n FROM payslip WHERE status = 'paid'")).toBe(84);
    expect(await n(db, "SELECT count(*) n FROM receipt WHERE kind = 'reversal'")).toBe(4);
    expect(await n(db, "SELECT count(*) n FROM receipt WHERE kind = 'refund'")).toBe(1);
    expect(await n(db, "SELECT count(*) n FROM charge WHERE kind = 'fine'")).toBeGreaterThan(50);
    expect(await n(db, "SELECT count(*) n FROM charge WHERE kind = 'fine_waiver'")).toBeGreaterThan(
      3,
    );
    expect(await n(db, "SELECT count(*) n FROM receipt WHERE kind = 'payment'")).toBeGreaterThan(
      800,
    );
    expect(await n(db, "SELECT count(DISTINCT method) n FROM receipt WHERE kind = 'payment'")).toBe(
      4,
    );
    expect(await n(db, 'SELECT count(*) n FROM cash_session WHERE closed_at IS NULL')).toBe(0);
    expect(await n(db, 'SELECT count(*) n FROM cash_session WHERE variance <> 0')).toBeGreaterThan(
      5,
    );
    expect(await n(db, 'SELECT count(*) n FROM expense WHERE voided_by IS NOT NULL')).toBe(1);
    expect(await n(db, 'SELECT count(*) n FROM att_register')).toBeGreaterThan(400);
    expect(await n(db, 'SELECT count(DISTINCT status) n FROM message')).toBe(3);
    expect(await n(db, 'SELECT count(DISTINCT template_key) n FROM message')).toBe(5);
    expect(await n(db, 'SELECT count(*) n FROM audit')).toBeGreaterThan(1000);
    // The fixed demo logins plus the installation owner (lower-cased).
    for (const email of [...Object.values(DEMO_USERS), 'owner@example.com'])
      expect(
        await n(db, `SELECT count(*) n FROM "user" WHERE email = '${email}' AND status = 'active'`),
        email,
      ).toBe(1);
  });

  it('collects about 85% and has real defaulters', async () => {
    const pct = await n(
      db,
      "SELECT round(100.0 * sum(paid) / sum(net)) n FROM charge_net WHERE payer_type = 'family'",
    );
    expect(pct).toBeGreaterThanOrEqual(80);
    expect(pct).toBeLessThanOrEqual(92);
    expect(
      await n(
        db,
        "SELECT count(DISTINCT payer_id) n FROM charge_status WHERE payer_type = 'family' AND due > 0",
      ),
    ).toBeGreaterThan(40);
    // Absence 5–8% on the September registers.
    const abs = await n(db, "SELECT round(1000.0 * sum(status = 'A') / count(*)) n FROM att_mark");
    expect(abs).toBeGreaterThanOrEqual(40);
    expect(abs).toBeLessThanOrEqual(80);
  });

  it('keeps every money rule: ledger_consistency empty, the P&L ties, no FK problem', async () => {
    expect(await db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    const ie = await incomeExpense(db, { from: '2026-04', to: '2026-09' });
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
    const r = await seedDemo(db, { parentSecret: SECRET, ownerEmail: 'owner@example.com' });
    expect(r.phase).toBe('done');
    expect(r.dirty).toBe(false);
    expect(await fingerprint(db)).toEqual(before);
    expect(await db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
    // The schema came back whole: every trigger and view the migrations made.
    expect(await n(db, "SELECT count(*) n FROM sqlite_master WHERE type = 'trigger'")).toBe(97);
    expect(await n(db, "SELECT count(*) n FROM sqlite_master WHERE type = 'view'")).toBe(8);
  }, 180_000);

  it('resumes after being cut off at any point, without writing anything twice', async () => {
    const db2 = createTestDb();
    await startDemoReset(db2, { reason: 'test' });
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
    expect(calls).toBeGreaterThan(demoPlan().length);
    expect(await fingerprint(db2)).toEqual(await fingerprint(db));
  }, 180_000);

  it('ids do not depend on the order a process asks for them (each Worker isolate is fresh)', async () => {
    const keys = ['user:accountant', 'account:drawer', 'head:tuition', 'user:principal', 'rate:x'];
    const fresh = async (order: string[]) => {
      vi.resetModules();
      const m = await import('../src/demo/world');
      const w = m.world();
      return Object.fromEntries(order.map((k) => [k, w.ids(k)]));
    };
    expect(await fresh([...keys].reverse())).toEqual(await fresh(keys));
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

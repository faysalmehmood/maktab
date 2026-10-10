import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCustomSql, CUSTOM_MIGRATION } from '../scripts/sync-custom-sql';
import { type AppDb, atomic, rawStatement } from '../src/client';
import { createTestDb } from '../src/node';
import * as t from '../src/schema';

// Port of experiment 1 (PLAN §12) onto the full schema: ids are ULID-like strings, amounts paisa.

type Row = Record<string, unknown>;

/** drizzle wraps driver errors; the trigger text lives on the cause. */
async function expectAbort(fn: () => unknown, pattern: RegExp) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected failure matching ${pattern}`).toBeDefined();
  const text = [caught, (caught as { cause?: unknown }).cause]
    .map((e) => (e instanceof Error ? e.message : String(e)))
    .join(' | ');
  expect(text).toMatch(pattern);
}

const all = (db: AppDb, query: ReturnType<typeof sql>) => db.all<Row>(query);

async function seed(db: AppDb) {
  await db.insert(t.user).values({ id: 'U1', email: 'collector@example.com', status: 'active' });
  await db.insert(t.family).values({ id: 'F1', name: 'Khan family' });
  await db.insert(t.student).values([
    { id: 'S1', familyId: 'F1', admissionNo: 'A-1', name: 'Ali', admissionDate: '2026-03-01' },
    { id: 'S2', familyId: 'F1', admissionNo: 'A-2', name: 'Sara', admissionDate: '2026-03-01' },
  ]);
  await db
    .insert(t.feeHead)
    .values({ id: 'H1', name: 'Tuition', kind: 'tuition', cadence: 'monthly' });
  await db.insert(t.receiptSeries).values({ series: 'R', year: 2026, nextNo: 1 });
  const base = {
    feeHeadId: 'H1',
    periodKey: '2026-03',
    payerType: 'family',
    payerId: 'F1',
    dueDate: '2026-03-10',
  } as const;
  await db.insert(t.charge).values([
    { ...base, id: 'c1', studentId: 'S1', kind: 'fee', amount: 800000 },
    { ...base, id: 'c2', studentId: 'S2', kind: 'fee', amount: 1200000 },
    {
      ...base,
      id: 'c2d',
      studentId: 'S2',
      kind: 'concession',
      parentChargeId: 'c2',
      amount: -240000,
    },
    { ...base, id: 'c1f', studentId: 'S1', kind: 'fine', parentChargeId: 'c1', amount: 50000 },
  ]);
}

/** One receipt = series bump + INSERT…SELECT numbering + allocations, atomically (PLAN §5.2). */
function receipt(
  db: AppDb,
  o: { id: string; idem: string; amount: number; allocs: [string, number][]; reverses?: string },
) {
  return atomic(db, () => [
    rawStatement(
      db,
      sql`UPDATE receipt_series SET next_no = next_no + 1 WHERE series = 'R' AND year = 2026`,
    ),
    rawStatement(
      db,
      sql`
      INSERT INTO receipt (id, receipt_no, kind, reverses_id, payer_type, payer_id, amount, method,
                           collector_id, business_date, idempotency_key)
      SELECT ${o.id}, 'R-2026-' || printf('%05d', next_no - 1), ${o.reverses ? 'reversal' : 'payment'},
             ${o.reverses ?? null}, 'family', 'F1', ${o.amount}, 'cash', 'U1', '2026-03-05', ${o.idem}
      FROM receipt_series WHERE series = 'R' AND year = 2026`,
    ),
    ...o.allocs.map(([chargeId, amount]) =>
      db.insert(t.receiptAllocation).values({ receiptId: o.id, chargeId, amount }),
    ),
  ]);
}

const status = (db: AppDb) =>
  all(db, sql`SELECT id, net, paid, due, status FROM charge_status ORDER BY id`);
const seriesNo = async (db: AppDb) =>
  (await all(db, sql`SELECT next_no FROM receipt_series`))[0]?.next_no;
const receiptCount = async (db: AppDb) =>
  (await all(db, sql`SELECT count(*) AS n FROM receipt`))[0]?.n;

describe('ledger (experiment 1 scenario)', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await seed(db);
  });

  it('rejects a duplicate fee for the same student, head, period and payer', async () => {
    await expectAbort(
      () =>
        db.insert(t.charge).values({
          id: 'c1dup',
          studentId: 'S1',
          feeHeadId: 'H1',
          periodKey: '2026-03',
          payerType: 'family',
          payerId: 'F1',
          dueDate: '2026-03-10',
          kind: 'fee',
          amount: 800000,
        }),
      /UNIQUE constraint failed/,
    );
  });

  it('folds child lines into root charges (root-charge net rule)', async () => {
    const rows = await status(db);
    expect(rows).toEqual([
      { id: 'c1', net: 850000, paid: 0, due: 850000, status: 'overdue' },
      { id: 'c2', net: 960000, paid: 0, due: 960000, status: 'overdue' },
    ]);
  });

  it('refuses allocations to child lines and grandchild lines', async () => {
    await expectAbort(
      () => receipt(db, { id: 'rc', idem: 'i-c', amount: 50000, allocs: [['c1f', 50000]] }),
      /allocation must target a root charge/,
    );
    await expectAbort(
      () =>
        db.insert(t.charge).values({
          id: 'c1fw',
          studentId: 'S1',
          feeHeadId: 'H1',
          periodKey: '2026-03',
          payerType: 'family',
          payerId: 'F1',
          dueDate: '2026-03-10',
          kind: 'fine_waiver',
          parentChargeId: 'c1f',
          amount: -50000,
        }),
      /parent charge must be a root charge/,
    );
  });

  it('issues a numbered receipt and allocates in one batch', async () => {
    await receipt(db, {
      id: 'r1',
      idem: 'idem-1',
      amount: 1000000,
      allocs: [
        ['c1', 850000],
        ['c2', 150000],
      ],
    });
    expect(await all(db, sql`SELECT receipt_no, amount FROM receipt`)).toEqual([
      { receipt_no: 'R-2026-00001', amount: 1000000 },
    ]);
    expect(await status(db)).toEqual([
      { id: 'c1', net: 850000, paid: 850000, due: 0, status: 'paid' },
      { id: 'c2', net: 960000, paid: 150000, due: 810000, status: 'partial' },
    ]);
  });

  it('a retried request (same idempotency key) fails and does not advance the series', async () => {
    await receipt(db, { id: 'r1', idem: 'idem-1', amount: 1000000, allocs: [['c1', 850000]] });
    await expectAbort(
      () => receipt(db, { id: 'r1-retry', idem: 'idem-1', amount: 1000000, allocs: [] }),
      /UNIQUE constraint failed: receipt.idempotency_key/,
    );
    expect(await seriesNo(db)).toBe(2);
  });

  it('over-allocation rolls back the whole batch (no receipt, series unchanged)', async () => {
    await receipt(db, { id: 'r1', idem: 'idem-1', amount: 1000000, allocs: [['c2', 150000]] });
    await expectAbort(
      () => receipt(db, { id: 'r2', idem: 'idem-2', amount: 500000, allocs: [['c2', 900000]] }),
      /allocations exceed receipt amount|allocation exceeds charge net/,
    );
    expect(await receiptCount(db)).toBe(1);
    expect(await seriesNo(db)).toBe(2);
    // Within the receipt but above the charge net (960,000 after the concession, not 1,200,000).
    await expectAbort(
      () => receipt(db, { id: 'r3', idem: 'idem-3', amount: 2000000, allocs: [['c2', 1000000]] }),
      /allocation exceeds charge net/,
    );
    expect(await receiptCount(db)).toBe(1);
  });

  it('money rows are append-only', async () => {
    await receipt(db, { id: 'r1', idem: 'idem-1', amount: 1000000, allocs: [['c1', 850000]] });
    await expectAbort(
      () => db.update(t.receipt).set({ amount: 1 }).where(eq(t.receipt.id, 'r1')),
      /append-only/,
    );
    await expectAbort(() => db.delete(t.charge).where(eq(t.charge.id, 'c1')), /append-only/);
    await expectAbort(
      () => db.delete(t.receiptAllocation).where(eq(t.receiptAllocation.receiptId, 'r1')),
      /append-only/,
    );
  });

  it('reverses a receipt with a negative receipt and mirrored allocations, once only', async () => {
    await receipt(db, {
      id: 'r1',
      idem: 'idem-1',
      amount: 1000000,
      allocs: [
        ['c1', 850000],
        ['c2', 150000],
      ],
    });
    await receipt(db, {
      id: 'r1x',
      idem: 'idem-1x',
      amount: -1000000,
      reverses: 'r1',
      allocs: [
        ['c1', -850000],
        ['c2', -150000],
      ],
    });
    expect(
      await all(db, sql`SELECT receipt_no, kind, amount FROM receipt ORDER BY receipt_no`),
    ).toEqual([
      { receipt_no: 'R-2026-00001', kind: 'payment', amount: 1000000 },
      { receipt_no: 'R-2026-00002', kind: 'reversal', amount: -1000000 },
    ]);
    expect((await status(db)).map((r) => [r.id, r.paid, r.due])).toEqual([
      ['c1', 0, 850000],
      ['c2', 0, 960000],
    ]);
    await expectAbort(
      () =>
        receipt(db, { id: 'r1y', idem: 'idem-1y', amount: -1000000, reverses: 'r1', allocs: [] }),
      /UNIQUE constraint failed: receipt.reverses_id/,
    );
  });

  it('rejects a reversal-shaped row that is not a reversal (CHECK)', async () => {
    await expectAbort(
      () => receipt(db, { id: 'rbad', idem: 'idem-bad', amount: -100, allocs: [] }),
      /CHECK constraint failed/,
    );
  });

  it('derives the family due from root charges only', async () => {
    await receipt(db, {
      id: 'r1',
      idem: 'idem-1',
      amount: 1000000,
      allocs: [
        ['c1', 850000],
        ['c2', 150000],
      ],
    });
    expect(
      await all(
        db,
        sql`SELECT payer_id, sum(due) AS family_due FROM charge_status GROUP BY payer_id`,
      ),
    ).toEqual([{ payer_id: 'F1', family_due: 810000 }]);
  });
});

describe('other hand-written rules', () => {
  let db: AppDb;
  beforeEach(async () => {
    db = createTestDb();
    await seed(db);
    await db.insert(t.programme).values({ id: 'P1', name: 'Class 5', kind: 'grade' });
    await db.insert(t.grp).values([
      { id: 'G1', programmeId: 'P1', name: '5-A' },
      { id: 'G2', programmeId: 'P1', name: '5-B' },
      { id: 'G3', programmeId: 'P1', name: 'English batch', isPrimary: false },
    ]);
  });

  it('allows one active primary enrolment per student, plus any non-primary', async () => {
    const e = { studentId: 'S1', startDate: '2026-04-01' };
    await db.insert(t.enrolment).values({ ...e, id: 'E1', grpId: 'G1', isPrimary: true });
    await db.insert(t.enrolment).values({ ...e, id: 'E3', grpId: 'G3', isPrimary: false });
    await expectAbort(
      () => db.insert(t.enrolment).values({ ...e, id: 'E2', grpId: 'G2', isPrimary: true }),
      /UNIQUE constraint failed: enrolment.student_id/,
    );
    await db
      .insert(t.enrolment)
      .values({ ...e, id: 'E4', grpId: 'G2', isPrimary: true, status: 'promoted' });
  });

  it('a concession can be ended once and never edited', async () => {
    await db.insert(t.concession).values({
      id: 'K1',
      studentId: 'S2',
      type: 'pct',
      value: 20,
      reason: 'sibling',
      approvedBy: 'U1',
      validFrom: '2026-03-01',
    });
    await expectAbort(
      () => db.update(t.concession).set({ value: 25 }).where(eq(t.concession.id, 'K1')),
      /never edited/,
    );
    await db
      .update(t.concession)
      .set({ endedAt: '2026-06-01', endedBy: 'U1', endReason: 'changed to 25%' })
      .where(eq(t.concession.id, 'K1'));
    await expectAbort(
      () => db.update(t.concession).set({ endReason: 'x' }).where(eq(t.concession.id, 'K1')),
      /already ended/,
    );
    await expectAbort(
      () => db.delete(t.concession).where(eq(t.concession.id, 'K1')),
      /cannot be deleted/,
    );
  });

  it('the custom migration matches sql/*.sql', () => {
    const path = fileURLToPath(new URL(`../${CUSTOM_MIGRATION}`, import.meta.url));
    expect(readFileSync(path, 'utf8')).toBe(buildCustomSql());
  });
});

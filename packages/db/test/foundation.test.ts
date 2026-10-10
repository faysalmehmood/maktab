import { type SQL, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import { createTestDb } from '../src/node';

// Milestone 1 rules (sql/40_foundation.sql) on a fresh database built from every migration.

const batch = (db: AppDb, ...qs: SQL[]) =>
  atomic(db, () => qs.map((q) => rawStatement(db, q)) as [ReturnType<typeof rawStatement>]);
const raw = (q: string) => sql.raw(q);

/** SQLite's text lives on the error or its `cause` (drizzle wraps it). */
async function aborts(p: Promise<unknown>, pattern: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected failure matching ${pattern}`).toBeTruthy();
  const text = [err, (err as { cause?: unknown }).cause]
    .map((e) => (e instanceof Error ? e.message : String(e)))
    .join(' | ');
  expect(text).toMatch(pattern);
}
const count = async (db: AppDb, q: string) =>
  (await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM (${q})`)))[0]?.n;

async function owners(db: AppDb) {
  await batch(
    db,
    raw(
      `INSERT INTO "user" (id, email, status) VALUES ('A', 'a@x.pk', 'active'), ('B', 'b@x.pk', 'active')`,
    ),
    raw(`INSERT INTO role (user_id, role) VALUES ('A', 'owner'), ('B', 'owner'), ('B', 'teacher')`),
  );
}

describe('foundation migration', () => {
  it('creates the M1 tables and school columns', async () => {
    const db = createTestDb();
    for (const t of ['admission_series', 'import_run', 'import_row']) {
      expect(
        await count(db, `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'`),
      ).toBe(1);
    }
    const cols = await db.all<{ name: string }>(sql`PRAGMA table_info(school)`);
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(['logo_key', 'receipt_prefix', 'setup_completed_at']),
    );
  });

  it('keeps at least one active owner: role delete and disable both abort', async () => {
    const db = createTestDb();
    await owners(db);
    await batch(db, raw(`DELETE FROM role WHERE user_id = 'B' AND role = 'owner'`));
    await aborts(
      batch(db, raw(`DELETE FROM role WHERE user_id = 'A' AND role = 'owner'`)),
      /last_owner/,
    );
    await aborts(
      batch(db, raw(`UPDATE "user" SET status = 'disabled' WHERE id = 'A'`)),
      /last_owner/,
    );
    // Non-owner roles and non-owner users are unaffected.
    await batch(
      db,
      raw(`DELETE FROM role WHERE user_id = 'B'`),
      raw(`UPDATE "user" SET status = 'disabled' WHERE id = 'B'`),
    );
    expect(await count(db, `SELECT 1 FROM role WHERE role = 'owner'`)).toBe(1);
  });

  it('an inactive owner does not count as the remaining owner', async () => {
    const db = createTestDb();
    await owners(db);
    await batch(db, raw(`UPDATE "user" SET status = 'disabled' WHERE id = 'B'`));
    await aborts(
      batch(db, raw(`DELETE FROM role WHERE user_id = 'A' AND role = 'owner'`)),
      /last_owner/,
    );
  });

  it('one current session; roll numbers unique among active enrolments only', async () => {
    const db = createTestDb();
    await batch(
      db,
      raw(`INSERT INTO session (id, name, start_date, end_date, is_current) VALUES
           ('S1', '2026-27', '2026-04-01', '2027-03-31', 1), ('S2', '2027-28', '2027-04-01', '2028-03-31', 0)`),
    );
    await aborts(batch(db, raw(`UPDATE session SET is_current = 1 WHERE id = 'S2'`)), /UNIQUE/);
    await batch(
      db,
      raw(`UPDATE session SET is_current = 0 WHERE id = 'S1'`),
      raw(`UPDATE session SET is_current = 1 WHERE id = 'S2'`),
    );
    await batch(
      db,
      raw(`INSERT INTO programme (id, name, kind) VALUES ('P', 'Class 5', 'grade')`),
      raw(`INSERT INTO grp (id, programme_id, name) VALUES ('G', 'P', '5-A')`),
      raw(`INSERT INTO family (id, name) VALUES ('F', 'Khan')`),
      raw(`INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES
           ('X', 'F', '1', 'Ali', '2026-04-01'), ('Y', 'F', '2', 'Sara', '2026-04-01')`),
      raw(`INSERT INTO enrolment (id, student_id, grp_id, is_primary, roll_no, start_date, status)
           VALUES ('E1', 'X', 'G', 1, '1', '2026-04-01', 'withdrawn')`),
      // Roll 1 is free again once its holder left.
      raw(`INSERT INTO enrolment (id, student_id, grp_id, is_primary, roll_no, start_date)
           VALUES ('E2', 'Y', 'G', 1, '1', '2026-04-01')`),
    );
    await aborts(
      batch(
        db,
        raw(`INSERT INTO enrolment (id, student_id, grp_id, is_primary, roll_no, start_date)
             VALUES ('E3', 'X', 'G', 1, '1', '2026-05-01')`),
      ),
      /UNIQUE constraint failed: enrolment\.grp_id, enrolment\.roll_no/,
    );
  });
});

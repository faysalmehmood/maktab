import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/node';

// 0004 rebuilds `enrolment` (wider status CHECK). On a fresh test database the table is empty, so
// this replays it the way D1 does — one transaction, foreign keys ON (where PRAGMA foreign_keys=OFF
// is a no-op) — over rows that reference enrolment, which is where a rebuild can fail.

const statements = (tag: string) =>
  readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s && !/^(--[^\n]*\n?)*$/.test(s));

function apply(db: Database.Database, tags: string[]) {
  db.exec('BEGIN');
  for (const tag of tags) for (const s of statements(tag)) db.exec(s);
  db.exec('COMMIT');
}

describe('migration 0004 (enrolment.transferred) on populated data', () => {
  it('keeps rows, references and the partial indexes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    apply(db, ['0000_init', '0001_ledger_rules', '0002_m1_foundation', '0003_m1_rules']);
    db.exec(`
      INSERT INTO programme (id, name, kind) VALUES ('P', 'Class 5', 'grade');
      INSERT INTO grp (id, programme_id, name, is_primary) VALUES ('G', 'P', '5-A', 1), ('H', 'P', '5-B', 1);
      INSERT INTO family (id, name) VALUES ('F', 'Khan');
      INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('X', 'F', '1', 'Ali', '2026-04-01');
      INSERT INTO enrolment (id, student_id, grp_id, is_primary, roll_no, start_date, status)
        VALUES ('E1', 'X', 'G', 1, '1', '2026-04-01', 'withdrawn');
      INSERT INTO enrolment (id, student_id, grp_id, is_primary, roll_no, start_date, prev_enrolment_id)
        VALUES ('E2', 'X', 'H', 1, '1', '2026-05-01', 'E1');
      INSERT INTO fee_head (id, name, kind, cadence) VALUES ('FH', 'Tuition', 'tuition', 'monthly');
      INSERT INTO charge (id, student_id, enrolment_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind)
        VALUES ('C1', 'X', 'E1', 'FH', '2026-04', 'family', 'F', 100000, '2026-04-10', 'fee');
    `);
    apply(db, ['0004_enrolment_transferred', '0005_enrolment_rules']);

    expect(
      db.prepare('SELECT id, prev_enrolment_id AS p FROM enrolment ORDER BY id').all(),
    ).toEqual([
      { id: 'E1', p: null },
      { id: 'E2', p: 'E1' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'enrolment'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toEqual(
      expect.arrayContaining(['one_primary', 'enrolment_roll_once', 'enrolment_grp']),
    );
    db.exec(`UPDATE enrolment SET status = 'transferred' WHERE id = 'E1'`);
    // one_primary is back: a second active primary row is refused.
    expect(() =>
      db.exec(`INSERT INTO enrolment (id, student_id, grp_id, is_primary, roll_no, start_date)
               VALUES ('E3', 'X', 'G', 1, '2', '2026-06-01')`),
    ).toThrow(/UNIQUE/);
  });
});

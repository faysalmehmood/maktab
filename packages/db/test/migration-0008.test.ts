import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/node';

// 0008 rebuilds `receipt` (kind 'opening'). Replayed the way D1 runs it — one transaction, foreign
// keys ON (PRAGMA foreign_keys=OFF is a no-op there) — over receipts that allocations and a
// reversal reference, which is where a rebuild under live foreign keys fails without
// defer_foreign_keys.

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

describe('migration 0008 (receipt kind opening) on populated data', () => {
  it('keeps receipts, allocations, the reversal link, and every ledger rule', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    apply(db, [
      '0000_init',
      '0001_ledger_rules',
      '0002_m1_foundation',
      '0003_m1_rules',
      '0004_enrolment_transferred',
      '0005_enrolment_rules',
      '0006_m2_attendance',
      '0007_message_call_channel',
    ]);
    db.exec(`
      INSERT INTO "user" (id, email) VALUES ('U', 'u@x.pk');
      INSERT INTO family (id, name) VALUES ('F', 'Khan');
      INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('X', 'F', '1', 'Ali', '2026-04-01');
      INSERT INTO fee_head (id, name, kind, cadence) VALUES ('FH', 'Tuition', 'tuition', 'monthly');
      INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind)
        VALUES ('C1', 'X', 'FH', '2026-04', 'family', 'F', 100000, '2026-04-10', 'fee');
      INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key)
        VALUES ('R1', 'R-1', 'payment', 'family', 'F', 100000, 'cash', 'U', '2026-04-05', 'k1');
      INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A1', 'R1', 'C1', 100000);
      INSERT INTO receipt (id, receipt_no, kind, reverses_id, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key)
        VALUES ('R2', 'R-2', 'reversal', 'R1', 'family', 'F', -100000, 'cash', 'U', '2026-04-06', 'k2');
      INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A2', 'R2', 'C1', -100000);
    `);
    apply(db, ['0008_m3_fees', '0009_m3_fee_rules']);
    expect(db.prepare('SELECT id, reverses_id FROM receipt ORDER BY id').all()).toEqual([
      { id: 'R1', reverses_id: null },
      { id: 'R2', reverses_id: 'R1' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM receipt_allocation').get()).toEqual({ n: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT * FROM ledger_consistency').all()).toEqual([]);
    // The rules are back on the rebuilt table.
    expect(() => db.exec(`UPDATE receipt SET amount = 1 WHERE id = 'R1'`)).toThrow(/append-only/);
    expect(() =>
      db.exec(
        `INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A3', 'R1', 'C1', 1)`,
      ),
    ).toThrow(/receipt has been reversed/);
  });
});

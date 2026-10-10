import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { compareObjects, expectedObjects, MASTER_QUERY } from '../scripts/verify-db';
import { MIGRATIONS_DIR } from '../src/node';

// 0010 is the last enum pass before the pilot: it rebuilds `receipt` (methods cheque/other),
// `payslip` (status void) and `role` (explicit ON DELETE RESTRICT) under D1's always-on foreign keys,
// with rows that other tables reference; 0011 re-creates the rules. Replayed as D1 runs it (one
// transaction, foreign keys ON).

const statements = (file: string) =>
  readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s && !/^(--[^\n]*\n?)*$/.test(s));
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

function apply(db: Database.Database, list: string[]) {
  db.exec('BEGIN');
  for (const f of list) for (const s of statements(f)) db.exec(s);
  db.exec('COMMIT');
}

describe('migration 0010 (final enums) on populated data', () => {
  it('keeps receipts, payslips and roles with everything that points at them; rules re-created', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    apply(
      db,
      files.filter((f) => f < '0010'),
    );
    db.exec(`
      INSERT INTO "user" (id, email, status) VALUES ('U', 'u@x.pk', 'active'), ('O', 'o@x.pk', 'active');
      INSERT INTO role (user_id, role) VALUES ('O', 'owner'), ('U', 'accountant');
      INSERT INTO family (id, name) VALUES ('F', 'Khan');
      INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('X', 'F', '1', 'Ali', '2026-04-01');
      INSERT INTO fee_head (id, name, kind, cadence) VALUES ('FH', 'Tuition', 'tuition', 'monthly');
      INSERT INTO account (id, name, kind) VALUES ('BANK', 'Bank', 'bank');
      INSERT INTO cash_session (id, collector_id, business_date) VALUES ('CS', 'U', '2026-04-05');
      INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind)
        VALUES ('C1', 'X', 'FH', '2026-04', 'family', 'F', 100000, '2026-04-10', 'fee');
      INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, cash_session_id, business_date, idempotency_key)
        VALUES ('R1', 'R-1', 'payment', 'family', 'F', 100000, 'cash', 'U', 'CS', '2026-04-05', 'k1');
      INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A1', 'R1', 'C1', 100000);
      INSERT INTO receipt (id, receipt_no, kind, reverses_id, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key)
        VALUES ('R2', 'R-2', 'reversal', 'R1', 'family', 'F', -100000, 'cash', 'U', '2026-04-06', 'k2');
      INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A2', 'R2', 'C1', -100000);
      INSERT INTO staff (id, name) VALUES ('T', 'Teacher');
      INSERT INTO payslip (id, staff_id, period_key) VALUES ('P1', 'T', '2026-04'), ('P2', 'T', '2026-05');
      INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('L1', 'P1', 'basic', 3000000), ('L2', 'P2', 'basic', 3000000);
      UPDATE payslip SET status = 'approved', approved_by = 'O' WHERE id = 'P1';
      INSERT INTO salary_payment (id, payslip_id, amount, account_id, date) VALUES ('SP1', 'P1', 1000000, 'BANK', '2026-05-01');
      INSERT INTO billing_run (id, period_key, run_at) VALUES ('BR', '2026-04', 't');
      INSERT INTO billing_chunk (id, run_id, kind, grp_id) VALUES ('BC', 'BR', 'fees', NULL);
    `);
    apply(
      db,
      files.filter((f) => f >= '0010'),
    );
    expect(db.prepare('SELECT id, reverses_id, method FROM receipt ORDER BY id').all()).toEqual([
      { id: 'R1', reverses_id: null, method: 'cash' },
      { id: 'R2', reverses_id: 'R1', method: 'cash' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM receipt_allocation').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT id, status FROM payslip ORDER BY id').all()).toEqual([
      { id: 'P1', status: 'approved' },
      { id: 'P2', status: 'draft' },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM salary_payment').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT user_id, role FROM role ORDER BY user_id').all()).toEqual([
      { user_id: 'O', role: 'owner' },
      { user_id: 'U', role: 'accountant' },
    ]);
    expect(db.prepare('SELECT status, error_code FROM billing_chunk').all()).toEqual([
      { status: 'ok', error_code: null },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare('SELECT * FROM ledger_consistency').all()).toEqual([]);
    // Every trigger and view of sql/ is back (what `npm run db:verify` asserts on D1).
    const actual = db.prepare(MASTER_QUERY).all() as { type: string; name: string }[];
    expect(compareObjects(actual, expectedObjects())).toEqual({ missing: [], extra: [] });

    // The new enum values are accepted, the rules hold on the rebuilt tables.
    // (Numbered from its series: receipt_payment_shape covers every method since 0013.)
    db.exec(`INSERT INTO receipt_series (series, year, next_no) VALUES ('Q', 2026, 2)`);
    db.exec(`INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, account_id, collector_id, business_date, idempotency_key)
      VALUES ('R3', 'Q-2026-00001', 'payment', 'family', 'F', 5000, 'cheque', 'BANK', 'U', '2026-04-07', 'k3')`);
    expect(() => db.exec(`UPDATE receipt SET amount = 1 WHERE id = 'R1'`)).toThrow(/append-only/);
    db.exec(`UPDATE payslip SET status = 'void' WHERE id = 'P2'`);
    expect(() => db.exec(`UPDATE payslip SET status = 'void' WHERE id = 'P1'`)).toThrow(
      /paid payslip cannot be voided/,
    );
    expect(() => db.exec(`UPDATE payslip SET status = 'draft' WHERE id = 'P2'`)).toThrow(
      /status only moves/,
    );
    expect(() => db.exec(`DELETE FROM role WHERE user_id = 'O'`)).toThrow(/active owner/);
    expect(() => db.exec(`DELETE FROM "user" WHERE id = 'U'`)).toThrow(/FOREIGN KEY/);
  });
});

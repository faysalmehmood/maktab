import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { compareObjects, expectedObjects, MASTER_QUERY } from '../scripts/verify-db';
import { MIGRATIONS_DIR } from '../src/node';

// 0016 (M4 fix pass) adds account opening balances and backfills receipt.account_id for cash
// receipts written before it (they named no account; money_movement looked the drawer up through
// the collector). receipt is append-only: the migration lifts its update guard for that one
// statement and re-creates it. 0017 carries the new rules. Replayed as D1 runs it (one transaction,
// foreign keys ON), on a database with M4 data.

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

describe('migration 0016 (drawer account on cash receipts) on populated data', () => {
  it('backfills each cash receipt’s drawer, keeps receipts append-only, flags an old sessionless transfer', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    apply(
      db,
      files.filter((f) => f < '0016'),
    );
    db.exec(`
      INSERT INTO "user" (id, email, status) VALUES ('U', 'u@x.pk', 'active'), ('H', 'h@x.pk', 'active');
      INSERT INTO role (user_id, role) VALUES ('U', 'owner'), ('H', 'accountant');
      INSERT INTO staff (id, user_id, name) VALUES ('SH', 'H', 'Holder');
      INSERT INTO family (id, name) VALUES ('F', 'Khan');
      INSERT INTO account (id, name, kind) VALUES ('CASH', 'Drawers', 'cash'), ('BANK', 'Bank', 'bank');
      INSERT INTO account (id, name, kind, holder_staff_id) VALUES ('DH', 'H drawer', 'cash', 'SH');
      INSERT INTO cash_session (id, collector_id, business_date) VALUES ('CU', 'U', '2026-10-05'), ('CH', 'H', '2026-10-05');
      INSERT INTO receipt_series (series, year, next_no) VALUES ('R', 2026, 2);
      INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, cash_session_id, business_date, idempotency_key)
        VALUES ('R1', 'R-2026-00001', 'payment', 'family', 'F', 5000, 'cash', 'U', 'CU', '2026-10-05', 'k1');
      UPDATE receipt_series SET next_no = 3 WHERE series = 'R';
      INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, cash_session_id, business_date, idempotency_key)
        VALUES ('R2', 'R-2026-00002', 'payment', 'family', 'F', 7000, 'cash', 'H', 'CH', '2026-10-05', 'k2');
      UPDATE receipt_series SET next_no = 4 WHERE series = 'R';
      INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, account_id, collector_id, business_date, idempotency_key)
        VALUES ('R3', 'R-2026-00003', 'payment', 'family', 'F', 9000, 'bank', 'BANK', 'U', '2026-10-05', 'k3');
      -- Before 0017 a transfer out of a drawer could skip the session.
      INSERT INTO transfer (id, from_account, to_account, amount, date) VALUES ('TR', 'CASH', 'BANK', 1000, '2026-10-05');
    `);
    const before = db
      .prepare(
        'SELECT account_id, sum(amount) AS n FROM money_movement GROUP BY account_id ORDER BY account_id',
      )
      .all();
    apply(
      db,
      files.filter((f) => f >= '0016'),
    );
    expect(db.prepare('SELECT id, account_id FROM receipt ORDER BY id').all()).toEqual([
      { id: 'R1', account_id: 'CASH' },
      { id: 'R2', account_id: 'DH' },
      { id: 'R3', account_id: 'BANK' },
    ]);
    // Balances did not move: the stored account is what the lookup gave.
    expect(
      db
        .prepare(
          'SELECT account_id, sum(amount) AS n FROM money_movement GROUP BY account_id ORDER BY account_id',
        )
        .all(),
    ).toEqual(before);
    expect(
      db.prepare('SELECT opening_balance, opening_as_of FROM account WHERE id = ?').get('BANK'),
    ).toEqual({
      opening_balance: 0,
      opening_as_of: null,
    });
    expect(() => db.exec(`UPDATE receipt SET account_id = 'BANK' WHERE id = 'R1'`)).toThrow(
      /append-only/,
    );
    // DH holds money now: its holder is fixed.
    expect(() => db.exec(`UPDATE account SET holder_staff_id = NULL WHERE id = 'DH'`)).toThrow(
      /holder is fixed/,
    );
    expect(db.prepare('SELECT issue, receipt_id FROM ledger_consistency').all()).toEqual([
      { issue: 'transfer_cash_no_session', receipt_id: 'TR' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const actual = db.prepare(MASTER_QUERY).all() as { type: string; name: string }[];
    expect(compareObjects(actual, expectedObjects())).toEqual({ missing: [], extra: [] });
  });
});

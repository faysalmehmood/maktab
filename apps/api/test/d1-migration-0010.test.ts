import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import {
  compareObjects,
  expectedObjects,
  MASTER_QUERY,
} from '../../../packages/db/scripts/verify-db';

/**
 * Migration 0010 (the last enum pass) rebuilds `receipt`, `payslip` and `role` under D1's always-on
 * foreign keys, applied as `wrangler d1 migrations apply` does (one batch per file) over rows that
 * allocations, a reversal, payslip lines, a salary payment and the owner rule reference.
 */
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();
const apply = async (f: string) => {
  const stmts = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.replace(/^--.*$/gm, '').trim() !== '');
  await proxy.env.DB.batch(stmts.map((s) => proxy.env.DB.prepare(s)));
};

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(import.meta.dirname, '../wrangler.toml'),
    persist: false,
  });
}, 60_000);
afterAll(async () => {
  await proxy?.dispose();
});

describe('migration 0010 on D1 with receipts, payslips and roles present', () => {
  it('keeps every row; the rules and the ledger views are re-created', async () => {
    for (const f of files.filter((f) => f < '0010')) await apply(f);
    await proxy.env.DB.batch(
      [
        `INSERT INTO "user" (id, email, status) VALUES ('U', 'u@x.pk', 'active'), ('O', 'o@x.pk', 'active')`,
        `INSERT INTO role (user_id, role) VALUES ('O', 'owner'), ('U', 'accountant')`,
        `INSERT INTO family (id, name) VALUES ('F', 'Khan')`,
        `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('X', 'F', '1', 'Ali', '2026-04-01')`,
        `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('FH', 'Tuition', 'tuition', 'monthly')`,
        `INSERT INTO account (id, name, kind) VALUES ('BANK', 'Bank', 'bank')`,
        `INSERT INTO cash_session (id, collector_id, business_date) VALUES ('CS', 'U', '2026-04-05')`,
        `INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind) VALUES ('C1', 'X', 'FH', '2026-04', 'family', 'F', 100000, '2026-04-10', 'fee')`,
        `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, cash_session_id, business_date, idempotency_key) VALUES ('R1', 'R-2026-00001', 'payment', 'family', 'F', 100000, 'cash', 'U', 'CS', '2026-04-05', 'k1')`,
        `INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A1', 'R1', 'C1', 100000)`,
        `INSERT INTO receipt (id, receipt_no, kind, reverses_id, payer_type, payer_id, amount, method, collector_id, cash_session_id, business_date, idempotency_key) VALUES ('R2', 'R-2026-00002', 'reversal', 'R1', 'family', 'F', -100000, 'cash', 'U', 'CS', '2026-04-06', 'k2')`,
        // Well-formed numbers and drawer sessions: M4's ledger_consistency flags anything else.
        `INSERT INTO receipt_series (series, year, next_no) VALUES ('R', 2026, 3)`,
        `INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A2', 'R2', 'C1', -100000)`,
        `INSERT INTO staff (id, name) VALUES ('T', 'Teacher')`,
        `INSERT INTO payslip (id, staff_id, period_key) VALUES ('P1', 'T', '2026-04')`,
        `INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('L1', 'P1', 'basic', 3000000)`,
        `UPDATE payslip SET status = 'approved', approved_by = 'O' WHERE id = 'P1'`,
        `INSERT INTO salary_payment (id, payslip_id, amount, account_id, date) VALUES ('SP1', 'P1', 1000000, 'BANK', '2026-05-01')`,
      ].map((q) => proxy.env.DB.prepare(q)),
    );
    for (const f of files.filter((f) => f >= '0010')) await apply(f);
    const q = async (s: string) => (await proxy.env.DB.prepare(s).all()).results;
    expect(await q('SELECT id, reverses_id FROM receipt ORDER BY id')).toEqual([
      { id: 'R1', reverses_id: null },
      { id: 'R2', reverses_id: 'R1' },
    ]);
    expect(await q('SELECT count(*) AS n FROM receipt_allocation')).toEqual([{ n: 2 }]);
    expect(await q('SELECT id, status FROM payslip')).toEqual([{ id: 'P1', status: 'approved' }]);
    expect(await q('SELECT count(*) AS n FROM salary_payment')).toEqual([{ n: 1 }]);
    expect(await q('SELECT count(*) AS n FROM role')).toEqual([{ n: 2 }]);
    expect(await q('SELECT * FROM ledger_consistency')).toEqual([]);
    const actual = (await q(MASTER_QUERY)) as { type: string; name: string }[];
    expect(compareObjects(actual, expectedObjects())).toEqual({ missing: [], extra: [] });
    await expect(
      proxy.env.DB.prepare(`UPDATE receipt SET amount = 1 WHERE id = 'R1'`).run(),
    ).rejects.toThrow(/append-only/);
    await expect(
      proxy.env.DB.prepare(
        `UPDATE payslip SET status = 'void', voided_by = 'O', void_reason = 'x' WHERE id = 'P1'`,
      ).run(),
    ).rejects.toThrow(/paid payslip cannot be voided/);
    await expect(
      proxy.env.DB.prepare(`DELETE FROM role WHERE user_id = 'O'`).run(),
    ).rejects.toThrow(/active owner/);
  });
});

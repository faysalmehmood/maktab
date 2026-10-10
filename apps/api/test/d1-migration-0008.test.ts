import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';

/**
 * Migration 0008 rebuilds `receipt` under D1's always-on foreign keys. Applied as
 * `wrangler d1 migrations apply` does (one batch per file) over receipts that allocations and a
 * reversal reference: the copy-drop-create-copy with defer_foreign_keys must commit cleanly.
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

describe('migration 0008 on D1 with receipts present', () => {
  it('keeps receipts, allocations and the reversal link; rules re-created', async () => {
    for (const f of files.filter((f) => f < '0008')) await apply(f);
    await proxy.env.DB.batch(
      [
        `INSERT INTO "user" (id, email) VALUES ('U', 'u@x.pk')`,
        `INSERT INTO family (id, name) VALUES ('F', 'Khan')`,
        `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('X', 'F', '1', 'Ali', '2026-04-01')`,
        `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('FH', 'Tuition', 'tuition', 'monthly')`,
        `INSERT INTO charge (id, student_id, fee_head_id, period_key, payer_type, payer_id, amount, due_date, kind) VALUES ('C1', 'X', 'FH', '2026-04', 'family', 'F', 100000, '2026-04-10', 'fee')`,
        `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key) VALUES ('R1', 'R-1', 'payment', 'family', 'F', 100000, 'cash', 'U', '2026-04-05', 'k1')`,
        `INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A1', 'R1', 'C1', 100000)`,
        `INSERT INTO receipt (id, receipt_no, kind, reverses_id, payer_type, payer_id, amount, method, collector_id, business_date, idempotency_key) VALUES ('R2', 'R-2', 'reversal', 'R1', 'family', 'F', -100000, 'cash', 'U', '2026-04-06', 'k2')`,
        `INSERT INTO receipt_allocation (id, receipt_id, charge_id, amount) VALUES ('A2', 'R2', 'C1', -100000)`,
      ].map((q) => proxy.env.DB.prepare(q)),
    );
    for (const f of files.filter((f) => f >= '0008')) await apply(f);
    const rows = await proxy.env.DB.prepare(
      'SELECT id, reverses_id FROM receipt ORDER BY id',
    ).all();
    expect(rows.results).toEqual([
      { id: 'R1', reverses_id: null },
      { id: 'R2', reverses_id: 'R1' },
    ]);
    const lc = await proxy.env.DB.prepare('SELECT * FROM ledger_consistency').all();
    expect(lc.results).toEqual([]);
    await expect(
      proxy.env.DB.prepare(`UPDATE receipt SET amount = 1 WHERE id = 'R1'`).run(),
    ).rejects.toThrow(/append-only/);
  });
});

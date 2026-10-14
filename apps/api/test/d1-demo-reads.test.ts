import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AppDb,
  collect,
  DEMO_SEED_READ_CAP,
  DEMO_SEED_READS,
  DEMO_SEED_WRITES,
  DEMO_USERS,
  demoPlan,
  demoStatus,
  getDb,
  reverseReceipt,
  seedDemo,
  startDemoReset,
} from '@maktab/db';
import { MIGRATIONS_DIR } from '@maktab/db/node';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { advanceOnce, demoTick } from '../src/routes/demo';
import { D1Meter, type Stat, table } from './d1-meter';
import { env } from './helpers';

/**
 * The demo's D1 read budget (docs/demo.md "The D1 budget"), measured on workerd's real D1: every
 * query's `meta.rows_read` (what Cloudflare bills against the account's 5,000,000 rows read a day)
 * summed over a full reseed driven the way the cron drives it (advanceOnce, 12 step calls an
 * invocation), an idle tick, a nightly undo and `GET /api/demo`. The log prints the figures per step
 * and the top statement shapes; the test fails past DEMO_SEED_READS.
 */
type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let proxy: Proxy;
const meter = new D1Meter();
let db: AppDb;
// The seed day; DEMO_READS_TODAY=YYYY-MM-DD measures another one by hand.
const TODAY = process.env.DEMO_READS_TODAY ?? '2026-10-14';
const SECRET = 'test-parent-link-secret-at-least-32-characters';
const denv = { ...env, PARENT_LINK_SECRET: SECRET };

/** What one phase cost, with the step and statement breakdown printed. */
let seed: Stat;

const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

const one = async (q: string) => String((await db.all<{ v: string }>(sql.raw(q)))[0]?.v);

/** Runs `fn` with the meter cleared, and returns what it cost. */
async function measure(label: string, fn: () => Promise<unknown>): Promise<Stat> {
  meter.reset();
  meter.label = label;
  await fn();
  return meter.total();
}

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: join(import.meta.dirname, '../wrangler.toml'),
    persist: false,
  });
  for (const f of migrationFiles()) {
    const stmts = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/^--.*$/gm, '').trim() !== '');
    await proxy.env.DB.batch(stmts.map((s) => proxy.env.DB.prepare(s)));
  }
  db = getDb({ DB: meter.wrap(proxy.env.DB) });
  // Label every query with the step that runs it (the runner's own state reads stay "runner").
  for (const s of demoPlan(TODAY)) {
    const run = s.run;
    s.run = async (ctx, sub) => {
      const prev = meter.label;
      meter.label = s.name.replace(/:\d{4}-\d{2}(-\d{2})?/g, ':<date>').replace(/:\d+$/, ':<n>');
      try {
        return await run(ctx, sub);
      } finally {
        meter.label = prev;
      }
    };
  }
  // The first seed (an empty database) is not what the budget is about: every Monday's reseed runs
  // over a seeded demo.
  const first = await measure('first seed', () =>
    seedDemo(db, { parentSecret: SECRET, ownerEmail: env.OWNER_EMAIL, today: TODAY }),
  );
  console.log(
    `demo first seed (empty database): ${first.read} rows read, ${first.written} written`,
  );
  seed = await measure('runner', async () => {
    await startDemoReset(db, { reason: 'measure', daily: false, today: TODAY });
    meter.label = 'runner';
    for (let i = 0; i < 2000 && (await demoStatus(db)).phase === 'running'; i++)
      await advanceOnce(db, denv, 60_000);
  });
  expect((await demoStatus(db)).phase).toBe('done');
  console.log(
    `demo reseed over the demo: ${seed.read} rows read, ${seed.written} rows written, ${seed.queries} queries\n` +
      `per step (top 25):\n${table(meter.top(meter.byLabel, 25))}\n` +
      `per statement (top 15):\n${table(meter.top(meter.byShape, 15))}\n` +
      `per step and statement (top 20):\n${table(meter.top(meter.byLabelShape, 20))}`,
  );
}, 600_000);

afterAll(async () => {
  await proxy?.dispose();
});

describe('the demo on D1: rows read', () => {
  it('a full reseed over the demo stays within DEMO_SEED_READS', () => {
    expect(meter.unmeasured).toBe(0);
    expect(seed.read).toBeLessThanOrEqual(DEMO_SEED_READS);
    // The target (a fifth of the account's 5,000,000 a day) and the hard cap.
    expect(DEMO_SEED_READS).toBeLessThanOrEqual(1_000_000);
    expect(DEMO_SEED_READ_CAP).toBeLessThanOrEqual(1_500_000);
    // Not so far under that the constant stops meaning anything (other seed days read up to ~5% more).
    if (TODAY === '2026-10-14') expect(seed.read).toBeGreaterThan(DEMO_SEED_READS * 0.75);
    expect(seed.written).toBeLessThanOrEqual(DEMO_SEED_WRITES * 1.1);
  });

  it('GET /api/demo and an idle tick read a handful of rows', async () => {
    const status = await measure('GET /api/demo', () => demoStatus(db));
    // A Wednesday afternoon: nothing to do.
    const idle = await measure('idle tick', () =>
      demoTick(db, denv, Date.parse('2026-10-21T10:00:00Z')),
    );
    // 02:00 Karachi with an empty undo log: one look at the log, nothing to undo.
    const clean = await measure('02:00 tick, clean', () =>
      demoTick(db, denv, Date.parse('2026-10-21T21:00:00Z')),
    );
    console.log(
      `GET /api/demo: ${status.read} rows read (${status.queries} q); idle tick: ${idle.read} ` +
        `(${idle.queries} q); 02:00 tick with nothing to undo: ${clean.read} (${clean.queries} q)`,
    );
    expect(status.read).toBeLessThanOrEqual(50);
    expect(idle.read).toBeLessThanOrEqual(50);
    // Was ~500: a look in sqlite_master (~470 rows) for the undo log every 02:00 tick.
    expect(clean.read).toBeLessThanOrEqual(50);
  });

  it('the nightly undo reads in proportion to the log', async () => {
    // A visitor's afternoon: edits, a payment and a reversal (as in demo-seed.test.ts).
    await db.run(
      sql`UPDATE family SET area = 'Johar Town' WHERE id IN (SELECT id FROM family LIMIT 3)`,
    );
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
    const entries = Number(await one('SELECT count(*) v FROM _demo_undo'));
    const at = Date.parse('2026-11-04T21:00:30Z'); // Thursday 02:00 Karachi
    const undo = await measure('undo', async () => {
      await demoTick(db, denv, at);
      for (let i = 0; i < 20 && (await demoStatus(db)).phase === 'undoing'; i++)
        await demoTick(db, denv, at + (i + 1) * 60_000);
    });
    expect((await demoStatus(db)).phase).toBe('done');
    console.log(
      `nightly undo of ${entries} logged changes: ${undo.read} rows read, ${undo.written} written, ${undo.queries} q\n` +
        table(meter.top(meter.byShape, 8)),
    );
    expect(await db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
    // Per chunk of ≤ 100 entries: three reads of sqlite_master (~1,500 rows) and ~470 per trigger
    // dropped and re-made (DROP TRIGGER scans sqlite_master); the restores themselves read little.
    // Was ~22,800 for these 11 changes before only the triggers a restore fires were dropped.
    expect(undo.read).toBeLessThanOrEqual(10_000);
  });
});

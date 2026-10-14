/**
 * The rich demo dataset (docs/demo.md): "Al-Noor Community School, Lahore", ~300 students, April–
 * September 2026, into the local wrangler D1 file (after `npm run db:migrate:local`) or SEED_DB=<path>.
 * Wipes whatever is there first (DROP + re-CREATE from the schema), so it can be re-run; refuses a
 * database that holds another school unless DEMO_FORCE=1. Deterministic (fixed PRNG seed).
 *   SEED_OWNER_EMAIL=<gmail>   also an owner login (Google sign-in) besides the demo buttons
 *   PARENT_LINK_SECRET=<…>     the same value as apps/api/.dev.vars, for the 40 parent links
 *                              (read from apps/api/.dev.vars when unset)
 * Remotely the Worker runs the same steps itself (POST /api/demo/step, the demo cron).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { DEMO_SEED_WRITE_CAP, DEMO_SEED_WRITES, seedDemo } from '../src/demo';
import { getDb } from '../src/node';
import { localD1File } from './seed';

function devVar(name: string): string | undefined {
  const file = fileURLToPath(new URL('../../../apps/api/.dev.vars', import.meta.url));
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('seed-demo is dev-only locally');
  const path = process.env.SEED_DB ?? localD1File();
  const db = getDb({ SQLITE_PATH: path });
  // The budget first (docs/demo.md): what this seed costs on D1, against the account's 100k a day.
  console.log(
    `Planned: ~${DEMO_SEED_WRITES} D1 row writes (cap ${DEMO_SEED_WRITE_CAP}; the free plan allows 100,000 a day, shared with the GSA pilot)`,
  );
  const changes0 = Number(
    (await db.all<{ n: number }>(sql`SELECT total_changes() AS n`))[0]?.n ?? 0,
  );
  const t0 = Date.now();
  const r = await seedDemo(db, {
    parentSecret: process.env.PARENT_LINK_SECRET ?? devVar('PARENT_LINK_SECRET'),
    ownerEmail: process.env.SEED_OWNER_EMAIL,
    force: process.env.DEMO_FORCE === '1',
  });
  console.log(
    `Seeded the demo into ${path}: ${r.calls} step calls in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  for (const t of [
    'family',
    'guardian',
    'student',
    'enrolment',
    'charge',
    'receipt',
    'receipt_allocation',
    'att_mark',
    'message',
    'payslip',
    'expense',
    'cash_session',
    'audit',
  ]) {
    const [row] = await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${t}"`));
    console.log(`  ${String(row?.n ?? 0).padStart(6)} ${t}`);
  }
  const [lc] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM ledger_consistency`);
  console.log(`  ledger_consistency rows: ${lc?.n}`);
  // Measured: rows × (1 + indexes) per table, plus updates and state writes counted twice.
  const tables = await db.all<{ name: string; idx: number }>(sql`SELECT m.name,
      (SELECT count(*) FROM sqlite_master i WHERE i.type = 'index' AND i.tbl_name = m.name) AS idx
    FROM sqlite_master m WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite%' AND m.name NOT LIKE '!_cf!_%' ESCAPE '!'
      AND m.name NOT IN ('d1_migrations', '__drizzle_migrations', '_demo_state', '_demo_undo')`);
  let rows = 0;
  let writes = 0;
  for (const t of tables) {
    const [c] = await db.all<{ n: number }>(sql.raw(`SELECT count(*) AS n FROM "${t.name}"`));
    rows += Number(c?.n ?? 0);
    writes += Number(c?.n ?? 0) * (1 + t.idx);
  }
  const changes =
    Number((await db.all<{ n: number }>(sql`SELECT total_changes() AS n`))[0]?.n ?? 0) - changes0;
  writes += Math.max(0, changes - rows) * 2;
  console.log(`Measured: ${rows} rows, ~${writes} D1 row writes (planned ${DEMO_SEED_WRITES})`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

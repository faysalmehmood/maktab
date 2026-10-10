/**
 * DEV ONLY. Seeds the local wrangler D1 file (after `npm run db:migrate:local`) or SEED_DB=<path>
 * (a sqlite file; D1_PERSIST_TO is NOT read here — point SEED_DB at the .sqlite under that directory).
 * SEED_OWNER_EMAIL=<your gmail> makes you the seeded owner; an address that is already a user (or is
 * the demo teacher's) is reused, not an error. One transaction: a failure leaves nothing behind.
 * Refuses to run twice or with NODE_ENV=production; there is no seed route in the Worker by design.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@maktab/shared';
import { getTableName, sql } from 'drizzle-orm';
import { getDb } from '../src/node';
import * as t from '../src/schema';
import { seedAtomically } from './seed-data';

function localD1File(): string {
  const dir = fileURLToPath(
    new URL('../../../apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject', import.meta.url),
  );
  const file = existsSync(dir)
    ? readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
    : undefined;
  if (!file) throw new Error('No local D1 database. Run `npm run db:migrate:local` first.');
  return join(dir, file);
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('seed is dev-only');
  const path = process.env.SEED_DB ?? localD1File();
  const db = getDb({ SQLITE_PATH: path });
  const existing = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM school`);
  if ((existing[0]?.n ?? 0) > 0) {
    console.log(`${path} already has a school; not seeding again.`);
    return;
  }
  await seedAtomically(db, newId, process.env.SEED_OWNER_EMAIL, (m) => console.log(`  note: ${m}`));
  console.log(`Seeded ${path}`);
  for (const table of [t.user, t.programme, t.grp, t.family, t.student, t.enrolment]) {
    const [row] = await db.select({ n: sql<number>`count(*)` }).from(table);
    console.log(`  ${row?.n ?? 0}`.padEnd(6), getTableName(table));
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

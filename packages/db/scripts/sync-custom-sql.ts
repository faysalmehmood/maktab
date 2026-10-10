/**
 * Copies sql/*.sql (the hand-written source of truth) into the custom Drizzle migration, so that
 * both drizzle's migrator (tests, Node) and `wrangler d1 migrations apply` run the same statements.
 * Usage: tsx scripts/sync-custom-sql.ts [--check]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const CUSTOM_MIGRATION = 'migrations/0001_ledger_rules.sql';

export function buildCustomSql(): string {
  const dir = join(root, 'sql');
  const parts = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => `-- source: sql/${f}\n${readFileSync(join(dir, f), 'utf8').trim()}`);
  const body = parts.join('\n\n');
  // drizzle's migrator runs every chunk; a trailing breakpoint would leave an empty one.
  return `${body.replace(/\s*--> statement-breakpoint\s*$/, '')}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = join(root, CUSTOM_MIGRATION);
  const next = buildCustomSql();
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== next) {
      console.error(`${CUSTOM_MIGRATION} is out of date; run npm run db:generate`);
      process.exit(1);
    }
  } else {
    writeFileSync(target, next);
    console.log(`wrote ${CUSTOM_MIGRATION}`);
  }
}

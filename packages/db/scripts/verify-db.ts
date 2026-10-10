/**
 * `npm run db:verify [-- --remote]`: after `wrangler d1 migrations apply`, assert that the database
 * carries exactly the triggers and views that sql/*.sql defines (the custom-SQL manifest's current
 * files), plus every index those files create. A migration that half-applied, or a rebuilt table whose
 * triggers were not re-created, shows up here as a missing name; a hand-made trigger as an extra one.
 *
 * Usage (from the repo root):
 *   npm run db:verify                                   # local D1 (wrangler dev's state;
 *                                                       #   D1_PERSIST_TO=<dir> as for db:migrate:local)
 *   npm run db:verify -- --remote --env production      # the deployed D1 (wrangler login or
 *                                                       #   CLOUDFLARE_API_TOKEN)
 * Other arguments are passed to `wrangler d1 execute`. Exit 1 on any difference.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCustomSql, createdObjects, currentSqlFiles } from './sync-custom-sql';

export type SchemaObject = { type: string; name: string };

/** What sql/ creates: TRIGGER/VIEW must match exactly; INDEX must be present. */
export function expectedObjects(files = currentSqlFiles()): SchemaObject[] {
  return Object.values(files)
    .flatMap((t) => createdObjects(t))
    .map((o) => ({ type: o.kind.toLowerCase(), name: o.name }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Differences between the expected set and what sqlite_master holds (empty = healthy). */
export function compareObjects(actual: readonly SchemaObject[], expected = expectedObjects()) {
  const has = new Set(actual.map((o) => `${o.type}:${o.name}`));
  const want = new Set(expected.map((o) => `${o.type}:${o.name}`));
  const missing = [...want].filter((k) => !has.has(k));
  const extra = [...has].filter(
    (k) => (k.startsWith('trigger:') || k.startsWith('view:')) && !want.has(k),
  );
  return { missing, extra };
}

export const MASTER_QUERY =
  "SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY type, name";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = checkCustomSql();
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  const apiDir = fileURLToPath(new URL('../../../apps/api', import.meta.url));
  const passed = process.argv.slice(2);
  const where = passed.includes('--remote') ? '--remote' : '--local';
  const args = ['wrangler', 'd1', 'execute', 'DB', ...passed, '--json', '--command', MASTER_QUERY];
  if (where === '--local') {
    if (!passed.includes('--local')) args.splice(4, 0, '--local');
    if (process.env.D1_PERSIST_TO) args.push('--persist-to', process.env.D1_PERSIST_TO);
  }
  const out = execFileSync('npx', args, {
    cwd: apiDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const parsed = JSON.parse(out) as { results: SchemaObject[] }[];
  const actual = parsed.flatMap((r) => r.results);
  const expected = expectedObjects();
  const { missing, extra } = compareObjects(actual, expected);
  const count = (t: string, list: readonly SchemaObject[]) =>
    list.filter((o) => o.type === t).length;
  console.log(
    `${where.slice(2)} D1: ${count('trigger', actual)} triggers (expected ${count('trigger', expected)}), ` +
      `${count('view', actual)} views (expected ${count('view', expected)})`,
  );
  for (const m of missing) console.error(`missing ${m}`);
  for (const e of extra) console.error(`unexpected ${e}`);
  process.exit(missing.length || extra.length ? 1 : 0);
}

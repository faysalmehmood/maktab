/**
 * `npm run db:migrate:local` (root) / `npm run migrate:local -w @maktab/api`: applies the D1
 * migrations to the local (wrangler dev) database.
 *
 * D1_PERSIST_TO=<dir> adds `--persist-to <dir>`, the same variable dev-session.ts reads. An env var
 * because flags do not survive the root script's two npm layers: `npm run db:migrate:local --
 * --persist-to X` reaches wrangler without the flag (it would need `-- -- --persist-to X`).
 * Any other arguments are passed through to wrangler.
 */
import { spawnSync } from 'node:child_process';

const args = ['d1', 'migrations', 'apply', 'DB', '--local', ...process.argv.slice(2)];
const dir = process.env.D1_PERSIST_TO;
if (dir) args.push('--persist-to', dir);
const run = spawnSync('wrangler', args, { stdio: 'inherit' });
if (run.error) console.error(run.error.message);
process.exit(run.status ?? 1);

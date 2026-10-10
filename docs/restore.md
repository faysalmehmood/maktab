# Restore runbook (volunteer edition)

Adapted from experiment 5 (PLAN §12): local restore drill passed; the cloud half is authored but
has not been run yet. Practise this once per term (PLAN §9).

Below, `$DB` is the D1 database name — the `database_name` in `apps/api/wrangler.toml` and the
`D1_DATABASE_NAME` repository variable used by `.github/workflows/nightly-backup.yml` (default
`maktab`). Set it first: `export DB=maktab`.

Decide first: **what went wrong, and when?**
- Bad edit, accidental delete or bad deploy, noticed within **7 days** → Time Travel (section A).
  Fast, no files needed.
- Database deleted, account lost, damage older than 7 days, or you want a copy elsewhere → section B.

You need: a laptop with Node 22+, `age`, `gzip`, the Cloudflare login (`npx wrangler login`), and the
**age private key** (held by two trustees; never leave it on the laptop after use).

## A. Time Travel (7 days on the D1 Free plan; 30 days on Paid)

1. `npx wrangler d1 time-travel info "$DB"` shows the current bookmark.
2. Restore to a UTC time before the problem:
   `npx wrangler d1 time-travel restore "$DB" --timestamp=2026-10-09T08:00:00Z` (or `--bookmark=<id>`).
   It prints the PREVIOUS bookmark — write it down; restoring to it undoes the restore.
3. The restore is in place and replaces ALL data, including anything entered since. Tell staff to
   re-enter that period's receipts from the paper copies.
4. Check the app: latest receipt number, a couple of family balances.

## B. Restore an encrypted backup into a FRESH D1

1. Download the newest good file from R2 (`daily/maktab-<stamp>.sql.gz.age`) or Backblaze B2 (same
   name), plus its `.sha256`; run `shasum -a 256 -c maktab-<stamp>.sql.gz.age.sha256`.
2. Decrypt and decompress (private key file `key.txt`):
   `age -d -i key.txt maktab-<stamp>.sql.gz.age | gunzip > dump.sql`
3. Sanity: `grep -c '^INSERT' dump.sql` is non-zero; `head -1 dump.sql` is `PRAGMA defer_foreign_keys=TRUE;`.
4. Create the new database: `npx wrangler d1 create "$DB-restored"` — copy the printed `database_id`.
5. Import: `npx wrangler d1 execute "$DB-restored" --remote --file=dump.sql`
   - Do NOT run migrations first: the dump contains tables, data, then indexes, triggers and views,
     in that order, so the append-only triggers do not block the load. It should also contain the
     `d1_migrations` table, so future `migrations apply` continues from the right place.
   - At school scale (tens of MB) one file is fine; locally 28 MB / 282k statements took ~2 min.
6. Verify against the last nightly log or yesterday's Sheet:
   `npx wrangler d1 execute "$DB-restored" --remote --command "select count(*), sum(amount) from receipt"`
   and counts for `student` and `charge`. Confirm the triggers and views survived:
   `npm run db:verify -- --remote --env production` (after pointing the binding at the restored
   database, step 7) compares `sqlite_master` with `packages/db/sql/` and exits 1 on any difference;
   by hand, `select count(*) from sqlite_master where type='trigger'` is 72 and `type='view'` is 4
   after migration 0011 (docs/deploy.md §3).
7. Re-point the Worker: in `apps/api/wrangler.toml`, under `[[env.production.d1_databases]]` for binding
   `DB`, set `database_id` (and optionally `database_name`) to the new database, then
   `npx wrangler deploy --env production`. Never rename the binding.
8. Smoke test in the browser (sign in, open a student, today's attendance). Take a fresh export at once:
   `npx wrangler d1 export "$DB-restored" --remote --output after-restore.sql` and keep it.
9. Leave the old database untouched until the school confirms everything is right, then delete it.
   Update the `D1_DATABASE_NAME` repository variable if the name changed, and re-run the nightly workflow.

## Gotchas

- Time Travel is in place and also loses newer good data; a file restore loses everything since the
  backup (up to 24 h).
- `d1 export --remote` locks the database while it runs; queries fail with error 7500. Never run one
  during school hours. The app retries once on 7500, which covers brief overlaps only.
- Never paste the age private key into GitHub, chat or tickets.

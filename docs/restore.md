# Restore runbook (volunteer edition)

Adapted from experiment 5 (PLAN §12). Practise once per term (PLAN §9): the `restore-drill`
workflow does section B against a scratch database automatically (docs/backup.md §7); this page is
the by-hand version and the real thing.

Below, `$DB` is the D1 database name — the `database_name` in `apps/api/wrangler.toml` and the
`D1_DATABASE_NAME` repository variable used by `.github/workflows/nightly-backup.yml` (default
`maktab`). Set it first: `export DB=maktab`.

**Self-hosted (the GSA pilot at gsap.conceptlix.com since 2026-10-17):** the backups are SQLite files
on the homelab, restored by stopping the container and replacing the database file:
docs/self-host.md §7. Sections A and B below are for a Cloudflare D1 installation (the demo, or the
Worker env `gsap` at maktab-gsap.conceptlix.com, which is a fallback only).

Decide first: **what went wrong, and when?**
- Bad edit, accidental delete or bad deploy, noticed within **7 days** → Time Travel (section A).
  Fast, no files needed.
- Database deleted, account lost, damage older than 7 days, or you want a copy elsewhere → section B.

You need: a laptop with Node 22+, `age`, `gzip`, the Cloudflare login (`npx wrangler login`), the
**age private key** (held by two trustees; never leave it on the laptop after use), and the
production **`PARENT_LINK_SECRET`** value (also with the trustees).

Parent links: the database (and so every backup) holds only hashes of link tokens and messages with a
`{link}` placeholder, never a working link. The Worker recomputes a guardian's link from
`PARENT_LINK_SECRET`, so a restore into a Worker with the **same** secret keeps every link working.
With a different or lost secret, links already sent keep opening until revoked but can no longer be
recomputed for new messages: after the restore, run Settings → Messages → "Revoke all parent links"
(`POST /api/parent-links/rotate-all`, owner) and new links are made as messages are opened.

## A. Time Travel (7 days on the D1 Free plan; 30 days on Paid)

1. `npx wrangler d1 time-travel info "$DB"` shows the current bookmark.
2. Restore to a UTC time before the problem:
   `npx wrangler d1 time-travel restore "$DB" --timestamp=2026-10-09T08:00:00Z` (or `--bookmark=<id>`).
   It prints the PREVIOUS bookmark — write it down; restoring to it undoes the restore.
3. The restore is in place and replaces ALL data, including anything entered since. Tell staff to
   re-enter that period's receipts from the paper copies.
4. Check the app: latest receipt number, a couple of family balances.

## B. Restore an encrypted backup into a FRESH D1

1. Download the newest good file from R2 (`daily/<YYYY-MM-DD>.sql.gz.age`, Karachi date; `daily/LATEST`
   names the newest; files before M6 are `daily/maktab-<stamp>.sql.gz.age`) or Backblaze B2 (same
   name), plus its `.sha256`:
   `npx wrangler r2 object get maktab-backups/daily/<day>.sql.gz.age --remote --file <day>.sql.gz.age`
   (and the `.sha256`), then `shasum -a 256 -c <day>.sql.gz.age.sha256`.
2. Decrypt and decompress with the trustees' key file (`maktab-backup-key.txt`, made by
   `npm run backup:keygen`). Needs the `age` CLI on the restore laptop (`brew install age` /
   `apt install age`):
   `age -d -i maktab-backup-key.txt <day>.sql.gz.age | gunzip > dump.sql`
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
   `npm run db:verify -- --remote --env gsap` (after pointing the binding at the restored
   database, step 7) compares `sqlite_master` with `packages/db/sql/` and exits 1 on any difference;
   by hand, compare `select count(*) from sqlite_master where type='trigger'` / `'view'` with the
   numbers in the last entry of docs/deploy-log.md.
7. Re-point the Worker: in `apps/api/wrangler.toml`, under `[[env.gsap.d1_databases]]` for binding
   `DB`, set `database_id` (and optionally `database_name`) to the new database, then
   `npx wrangler deploy --env gsap`. Never rename the binding.
8. If the Worker is new or its secrets were lost, set them first (docs/deploy.md §4):
   `SESSION_SECRET` (staff sign in again), the saved `PARENT_LINK_SECRET` (else revoke all links,
   above) and a new `BACKUP_REPORT_TOKEN` (docs/backup.md §3; update the GitHub secret too).
   Smoke test in the browser (sign in, open a student, today's attendance). Take a fresh export at once:
   `npx wrangler d1 export "$DB-restored" --remote --output after-restore.sql` and keep it.
9. Leave the old database untouched until the school confirms everything is right, then delete it.
   Update the `D1_DATABASE_NAME` repository variable if the name changed, and re-run the nightly workflow.

## Gotchas

- Time Travel is in place and also loses newer good data; a file restore loses everything since the
  backup (up to 24 h).
- `d1 export --remote` locks the database while it runs; queries fail with error 7500. Never run one
  during school hours. The app retries once on 7500, which covers brief overlaps only.
- Never paste the age private key into GitHub, chat or tickets.

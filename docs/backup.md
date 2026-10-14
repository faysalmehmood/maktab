# Backups (PLAN §9)

Five layers, each independent of the others:

| Layer | What | Where | Set up by |
|---|---|---|---|
| 1 | D1 Time Travel: any minute of the last 7 days | Cloudflare | nothing to do |
| 2 | Nightly `wrangler d1 export` → gzip → `age` → R2 `maktab-backups` (+ Backblaze B2) | GitHub Actions | this page |
| 3 | Nightly read-only Google Sheet copy (5 tabs) | the school's Google Drive | this page, optional |
| 4 | Homelab pull of the encrypted files (rclone) | a volunteer's machine | optional |
| 5 | "Download everything" (CSV ZIP + schema.sql) | the owner's device | Settings → Backup |

Settings → Backup (owner) shows the last nightly run, the newest files in the bucket, the alarms,
"Download everything", the Time Travel note and the restore-drill checklist. Restoring: `docs/restore.md`.

## 1. The encryption key (once)

Backups are encrypted to an **age** public key; only the matching private key can read them. The
private key never goes to GitHub (except the protected drill environment below), Cloudflare or chat.

    npm run backup:keygen -w @maktab/db          # or: -- --out /path/to/file

- Writes the private key to `~/Homelab/maktab-backup-key.txt` (mode 0600; refuses to overwrite an
  existing file) and prints the public recipient `age1…`.
- No `age` binary needed: it uses the official `age-encryption` npm package (X25519, readable by the
  `age` CLI). Give the file to the two trustees (password manager + a USB stick in a safe), together
  with the production `PARENT_LINK_SECRET` (docs/restore.md). Losing the key = losing every backup.

## 2. GitHub settings (repository → Settings → Secrets and variables → Actions)

| Name | Kind | Value |
|---|---|---|
| `BACKUP_ENABLED` | variable | `true` (without it the workflow does nothing) |
| `CLOUDFLARE_ACCOUNT_ID` | secret | the account id (not secret, kept with the token) |
| `CLOUDFLARE_API_TOKEN` | secret | a token with **Account › D1 › Edit**, **Account › Workers R2 Storage › Edit**, **Account › Workers Scripts › Read** |
| `AGE_RECIPIENT` | secret | the public `age1…` key from step 1 |
| `BACKUP_REPORT_TOKEN` | secret | the same random value as the Worker secret of that name (step 3) |
| `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_ENDPOINT` | secrets | optional Backblaze B2 copy (S3 endpoint, e.g. `https://s3.us-west-004.backblazeb2.com`) |
| `GOOGLE_SA_JSON`, `SHEET_ID` | secrets | optional Google Sheet copy (section 6) |
| `APP_URL` | variable | optional; default `https://maktab-gsap.conceptlix.com` |
| `BACKUP_R2_BUCKET` | variable | optional; default `maktab-backups` (both workflows) |
| `BACKUP_ALLOW_SHRINK` | variable | optional; `true` accepts a dump less than half the previous size (section 5); remove it again afterwards |

Without the B2 secrets each run is reported **partial** (one provider only) but still succeeds.

Creating the Cloudflare token (dashboard → My Profile → API Tokens → Create Token → Custom token):
permissions *Account / D1 / Edit*, *Account / Workers R2 Storage / Edit*, *Account / Workers Scripts /
Read*; Account resources: *Include / <the school's account>*; no IP filter; TTL as you like. Copy it
and, without pasting it anywhere else:

    pbpaste | gh secret set CLOUDFLARE_API_TOKEN -R faysalmehmood/maktab

## 3. The Worker side

    # one value for both sides, never displayed
    umask 077; openssl rand -hex 32 > /tmp/brt
    npx wrangler secret put BACKUP_REPORT_TOKEN --env gsap < /tmp/brt     # from apps/api
    gh secret set BACKUP_REPORT_TOKEN -R faysalmehmood/maktab < /tmp/brt
    shred -u /tmp/brt 2>/dev/null || rm -P /tmp/brt

The Worker binds the bucket as `BACKUPS` (apps/api/wrangler.toml) only to list the newest files on the
backup page. `POST /api/backup/runs` accepts reports only with `Authorization: Bearer <token>`.

## 4. R2 lifecycle (retention, set once in the dashboard)

R2 → `maktab-backups` → Settings → Object lifecycle rules → Add rule:

- **daily-95d**: prefix `daily/`, *Delete objects* after **95 days**.
- No rule for `monthly/` (kept; prune by hand after 24 months if space ever matters — a month is
  about 1–2 MB at school scale).

The workflow copies the dump of the 1st of each month (Karachi date) to `monthly/`. B2 is pruned by
the workflow itself (90 daily, 24 monthly).

## 5. What the nightly job does (`.github/workflows/nightly-backup.yml`, 02:30 PKT)

1. `wrangler d1 export DB --remote --env gsap` (the database is briefly locked: queries can fail
   with D1 error 7500; the app retries once, and nobody works at 02:30).
2. Sanity: core tables, an owner, `message_template`, `parent_link`, every trigger / view / index of
   `packages/db/sql`.
3. `gzip -9`, `gzip -t`, `age -r $AGE_RECIPIENT`, `sha256sum`.
4. R2: `daily/<YYYY-MM-DD>.sql.gz.age` + `.sha256`, `daily/LATEST` (pointer for the drill), the 1st
   of the month also under `monthly/`. B2 when configured. The Google Sheet when configured.
5. **Size check, after the upload** (a backup is never withheld): the encrypted size is compared with
   `daily/LAST_SIZE`. Less than half of it (`shrank`), under 1,000 bytes (`too_small`) or an unreadable
   `LAST_SIZE` (`unknown`; only wrangler's "the specified key does not exist" counts as "first run, no
   previous size") makes the run **failed** with that detail, although the file is in R2.
   `LAST_SIZE` is updated after every upload that passed the check; a flagged shrink keeps the old
   value, so the run stays red each night until someone looks. If the shrink was deliberate (a big
   clean-up), set the variable `BACKUP_ALLOW_SHRINK=true`, let one run pass, then delete the variable.
6. The plain-text dump is shredded; the run (status `ok` / `partial` / `failed`, size, sha256,
   targets, `details.backup_enabled`, `details.size_check`) is POSTed to Maktab (`POST
   /api/backup/runs`: strict schema, ISO date-times, bodies over 8 KB refused with 400, never cut).
7. A failure opens **one** GitHub issue labelled `backup-failed` (watchers get an e-mail); while it is
   open, later failures comment on it instead of opening another. The next successful run comments
   "Recovered" and closes it.
8. On the 1st of each month (Karachi) the run commits `docs/backup-status.md` (last run date, size,
   sha256 prefix, targets) to `main` as `github-actions[bot]` — see "The 60-day rule" below.

### The 60-day rule

GitHub **disables scheduled workflows in a public repository after 60 days without repository
activity** (no commits, issues, etc.), silently: the backups simply stop. The monthly status commit is
the keep-alive, so a quiet school repository still has activity at least every ~31 days. It needs
`contents: write` (set in the workflow) and a `main` that `github-actions[bot]` may push to; if branch
protection refuses it, the step warns and the run still succeeds — then either allow the bot or make
any commit/issue at least every 60 days. If the schedule was disabled anyway: Actions →
nightly-backup → **Enable workflow**. The app notices too: the `backup_stale` alarm (section 8).

What is inside: every table, including `message_template` (staff-edited texts), `message` (texts carry
a `{link}` placeholder, never a working link) and `parent_link` (token **hashes** only; links are
recomputed from `PARENT_LINK_SECRET`). CI never decrypts a backup.

## 6. Google Sheet copy (optional; school side)

1. Google Cloud console (any project the school owns) → IAM & Admin → Service accounts → Create
   (no roles) → Keys → Add key → JSON. Enable the **Google Sheets API** for the project.
2. In the school's Google Drive create an empty spreadsheet "Maktab copy"; Share → add the service
   account's e-mail (`…@….iam.gserviceaccount.com`) as **Editor**. Share with staff as **Viewer** only.
3. `SHEET_ID` = the long id in the sheet's URL; `GOOGLE_SA_JSON` = the whole key file:
   `gh secret set GOOGLE_SA_JSON -R faysalmehmood/maktab < key.json` then delete key.json.

Every night the tabs `students`, `guardians` (no CNIC), `dues_summary`, `receipts_month`,
`attendance_month` are cleared and rewritten (values written RAW: nothing is ever run as a formula).
Amounts are in rupees. Edits made in the sheet are overwritten; D1 stays the system of record. Test
locally without Google: `node --experimental-strip-types packages/db/scripts/sheet-export.ts --dump dump.sql --dry-run`.

## 7. Restore drill (once a term)

GitHub → Actions → **restore-drill** → Run workflow. It downloads the newest dump (or a key you
give), checks the sha256, decrypts it, imports it into a scratch D1 `maktab-drill`, runs `db:verify`
(triggers, views, indexes), counts and `ledger_consistency`, reports to Maktab and deletes the scratch
database. It needs the private key as **`AGE_SECRET_KEY` in the protected environment
`backup-drill`** (Settings → Environments → New environment → required reviewer: the owner;
deployment branches: `main` only → add the secret there, never as a repository secret):

    gh api -X PUT repos/faysalmehmood/maktab/environments/backup-drill   # then add reviewers in the UI
    gh secret set AGE_SECRET_KEY -R faysalmehmood/maktab --env backup-drill < ~/Homelab/maktab-backup-key.txt

If you prefer the key never to reach GitHub at all, skip that and do the drill by hand
(docs/restore.md section B against a scratch database). Either way, then tick the checklist in
Settings → Backup and record "drill done on <date>".

## 8. Alarms

A daily pass in the Worker cron (after 03:00 PKT) and the panel on the backup page check: rows in
`ledger_consistency` (including receipt-number/series mismatches and cash receipts outside a drawer
session), messages queued for more than 3 days, failed messages (7 days), parent-page gate lockouts
(24 h), fee generation needing attention, and **backup_stale**: no nightly backup finished `ok` or
`partial` within 36 hours, or the latest nightly report is `failed` ("Backups have not run since …;
check GitHub Actions and the Cloudflare API token"). backup_stale stays silent until backups are set
up: it needs a successful nightly run to exist and the latest report to carry `backup_enabled: true`
(every run sends it), so a school that never enabled backups never sees it. Anything found shows a
banner on the owner's dashboard until dismissed. The same pass applies data retention (Settings →
Recycle bin & data): parent-page access log older than the chosen number of days (default 90, at least
7, at most 3650), export jobs older than 30 days; it deletes in batches of 200 (at most 8 batches per
table, within a 10-second budget) and leaves any remainder for the next day.

## 9. Homelab pull (optional)

    rclone copy r2:maktab-backups/daily ~/backups/maktab/daily --max-age 3d

with an R2 API token limited to *Object Read* on `maktab-backups`. The files stay encrypted.

## 10. "Download everything" ZIP layout

`tables/<table>.csv` — one CSV per database table, named exactly after the table (`tables/student.csv`,
`tables/receipt.csv`, …; UTF-8 with BOM, CRLF), plus `schema.sql` and `README.txt`. Not included:
sign-in sessions, the parent-page access log and D1's own migration bookkeeping (`d1_migrations`).
Formula guard: a cell that starts with `=`, `+`, `-` or `@` is written with a leading apostrophe
(`'=SUM(…)`), so a spreadsheet shows it as text and never runs it; strip the apostrophe if you load the
CSV into a database. Parts are retried up to 3 times (1 s, 2 s, 4 s) and the ZIP is streamed (fflate
`Zip`), so a big school does not need the whole export in memory twice.

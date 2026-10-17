# Deploy log: first production deploy (2026-10-10)

Account: Faysalmehmood@hotmail.com's Account (`c2cb545de480a9e59b9e0d75d555c56f`), wrangler 4.149.0.
Host: https://maktab.conceptlix.com (custom domain, zone conceptlix.com on this account; NS koa/sarah.ns.cloudflare.com).

## Resources
- D1 `maktab`, id `440d652e-46bc-4389-88cc-b9a9fccffc44` (region EEUR). Migrations 0000-0018 applied.
  `db:verify --remote`: 89 triggers (expected 89), 8 views (expected 8).
- Worker `maktab` (env production), version `bf80587e-68e9-4c96-bf5d-943da17f1088`, cron `*/30 * * * *`.
- Secret `SESSION_SECRET` set (random, never displayed). Var `OWNER_EMAIL` = faysalfuturistic@gmail.com.
- R2 `maktab-files`: NOT created. API error 10042 "Please enable R2 through the Cloudflare Dashboard".
  Production `FILES` binding is commented out; photo upload returns 501 until enabled.

## Commands (from apps/api unless noted; CI=1 WRANGLER_SEND_METRICS=false)
    npx wrangler whoami
    npm ci --ignore-scripts && npm run build          # repo root
    npx wrangler d1 create maktab
    npx wrangler r2 bucket create maktab-files        # failed, see above
    npx wrangler d1 migrations apply DB --remote --env production
    npm run db:verify -- --remote --env production    # repo root
    openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --env production
    npx wrangler deploy --env production

## Checks
/api/health 200 {"status":"ok"}; /api/me 401; /api/auth/google/start 500 misconfigured (expected);
/ serves CSP + nosniff + frame headers; /manifest.webmanifest is application/manifest+json.
Tail of 20 health requests: cpuTime 0-1 ms, wallTime 1-2 ms.

## Pending (user)
1. Enable R2 (dashboard, card on file), then `npx wrangler r2 bucket create maktab-files`, uncomment the
   `[[env.production.r2_buckets]]` block in apps/api/wrangler.toml, redeploy.
2. Google OAuth client: Google Cloud console -> APIs & Services -> OAuth consent screen (External,
   publish it; scopes openid/email/profile only) -> Credentials -> OAuth client ID (Web) ->
   Authorised JavaScript origin `https://maktab.conceptlix.com`, redirect URI
   `https://maktab.conceptlix.com/api/auth/google/callback`. Then from apps/api:
       npx wrangler secret put GOOGLE_CLIENT_ID --env production
       npx wrangler secret put GOOGLE_CLIENT_SECRET --env production
   (paste when prompted), then sign in at https://maktab.conceptlix.com with faysalfuturistic@gmail.com
   (first sign-in becomes owner).
3. Backups (GitHub repo): secrets CLOUDFLARE_API_TOKEN (D1 Edit + R2 Edit), CLOUDFLARE_ACCOUNT_ID
   (`c2cb545de480a9e59b9e0d75d555c56f`), AGE_RECIPIENT, B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT;
   repo variable BACKUP_ENABLED=true. The backup R2 bucket `maktab-backups` also needs R2 enabled.

# Deploy log: M5 + M5 fix pass (2026-10-11)

Commits `b9d4349`, `aa0ca61`, `daf52bd` (pushed to main). From apps/api, CI=1 WRANGLER_SEND_METRICS=false.

    npx wrangler d1 migrations apply maktab --remote --env production   # 0019, 0020, 0021 ✅
    npm run db:verify -- --remote --env production                      # repo root
    openssl rand -base64 48 | npx wrangler secret put PARENT_LINK_SECRET --env production   # never displayed
    npm run build && npx wrangler deploy --env production

- `db:verify --remote`: 94 triggers (expected 94), 8 views (expected 8).
- After 0021: `school.parent_gate` = `birth_year` for the existing school row (the column default stays `none`; the API sets `birth_year` for new schools and the dev seed sets it explicitly); notice templates carry `{body}` and `{link}`.
- Secrets now: SESSION_SECRET, PARENT_LINK_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
  Give the trustees a copy of PARENT_LINK_SECRET (docs/restore.md needs the same value).
- Worker version `127573bb-40cb-434a-b4e4-377a0b3a0203`, cron `*/30 * * * *`.

Checks (curl --resolve with the IP from `dig @1.1.1.1`):
- `/api/health` 200 `{"status":"ok"}`.
- `/api/p` without a token: 404 `application/json` `{"error":{"code":"not_found",…}}`,
  `x-robots-tag: noindex, nofollow`, `cache-control: no-store`, `referrer-policy: no-referrer`;
  a malformed `X-Parent-Token`: the same 404.
- `/p`: 200 `text/html` (the SPA shell) with `x-robots-tag: noindex, nofollow`, `cache-control: no-store`,
  the CSP (`frame-ancestors 'none'`), `permissions-policy: camera=(self), microphone=(), geolocation=()`,
  `referrer-policy: no-referrer`, `x-content-type-options: nosniff`, `x-frame-options: DENY`.

# Deploy log: M6 settings & backup (2026-10-13)

Commits `718b354` … `a95af43` (pushed to main). From apps/api, CI=1 WRANGLER_SEND_METRICS=false.

    npx wrangler d1 migrations apply maktab --remote --env production   # 0022_m6_settings_backup ✅
    npm run db:verify -- --remote --env production                      # repo root
    (umask 077; openssl rand -hex 32 > <tmp>)                            # one value, never displayed
    npx wrangler secret put BACKUP_REPORT_TOKEN --env production < <tmp>
    gh secret set BACKUP_REPORT_TOKEN -R faysalmehmood/maktab < <tmp>; rm -P <tmp>
    npm run build && npx wrangler deploy --env production

- `db:verify --remote`: 94 triggers (expected 94), 8 views (expected 8). 0022 adds tables
  `export_job`, `backup_run`, `alarm_event` and columns `grp.archived_at`, `school.access_log_days`
  (ADD COLUMN only, no rebuild).
- Bindings now: DB, FILES (`maktab-files`), **BACKUPS (`maktab-backups`)**, ASSETS. R2 is enabled;
  both buckets exist.
- Secrets now: SESSION_SECRET, PARENT_LINK_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  **BACKUP_REPORT_TOKEN**.
- Worker version `12c72192-08a0-4adc-b856-f8045c85e1b5`, cron `*/30 * * * *` (the M6 daily alarm /
  retention pass rides on it: once per Karachi day after 03:00).
- age key pair: `npm run backup:keygen -w @maktab/db` → private key in
  `~/Homelab/maktab-backup-key.txt` (0600, on the maintainer's machine only), public recipient
  `age1pce8e4ckmpn2ynpawgqeljjutarprdufvlzq4k5c4m9lyywhdqasu4vslz`.

Checks (curl --resolve with the IP from `dig @1.1.1.1`):
- `/api/health` 200 `{"status":"ok"}`.
- `/api/alarms`, `/api/alarms/latest`, `/api/backup/status`, `/api/recycle-bin`, `POST /api/backup/export`
  without a session: 401 `unauthenticated`.
- `POST /api/backup/runs` without a token and with a wrong token: 401 (not 503: the secret is set).

GitHub (set from this machine, names only): secrets `AGE_RECIPIENT`, `CLOUDFLARE_ACCOUNT_ID`,
`BACKUP_REPORT_TOKEN`; variable `BACKUP_ENABLED=true`.

## Pending (user) — the nightly job fails (and opens an issue) until 1 is done

1. **Cloudflare API token** (the value must never pass through an agent): dashboard → My Profile →
   API Tokens → Create Token → *Create Custom Token*. Permissions: *Account · D1 · Edit*,
   *Account · Workers R2 Storage · Edit*, *Account · Workers Scripts · Read*. Account resources:
   *Include · Faysalmehmood@hotmail.com's Account*. Create, copy, then
   `pbpaste | gh secret set CLOUDFLARE_API_TOKEN -R faysalmehmood/maktab` and clear the clipboard.
   Then Actions → nightly-backup → Run workflow once; Settings → Backup should show the run.
2. **R2 lifecycle rule** on `maktab-backups`: prefix `daily/`, delete after 95 days (docs/backup.md §4).
3. Give the trustees `~/Homelab/maktab-backup-key.txt` and `PARENT_LINK_SECRET`; keep one escrow copy.
4. Optional: Backblaze B2 (`B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET`, `B2_ENDPOINT`; until then runs are
   "partial"), Google Sheet (`GOOGLE_SA_JSON`, `SHEET_ID`; docs/backup.md §6).
5. Restore drill: create the protected environment `backup-drill` (required reviewer = owner, branch
   `main`), add `AGE_SECRET_KEY` there only
   (`gh secret set AGE_SECRET_KEY -R faysalmehmood/maktab --env backup-drill < ~/Homelab/maktab-backup-key.txt`),
   run Actions → restore-drill after the first nightly run, then record the drill in Settings → Backup.

# Deploy log: M6 fix pass (2026-10-13)

Commits `eb6d3f3`, `179e4e1` (pushed to main). From apps/api:

    npx wrangler d1 migrations apply maktab --remote --env production   # 0023_m6_fix_archived_groups ✅
    npm run db:verify -- --remote --env production                      # repo root
    npm run build && npx wrangler deploy --env production

- `db:verify --remote`: 97 triggers (expected 97), 8 views (expected 8). 0023 adds the triggers
  `enrolment_grp_archived`, `enrolment_grp_archived_move`, `grp_archive_in_use` (no table change).
- Worker version `c3d51a00-b43d-44a6-b791-ebae3e29e8b4`.
- Checks (curl --resolve, 172.67.187.153): `/api/health` 200 `{"status":"ok"}`; `/api/alarms` without
  a session 401; `POST /api/backup/runs` without a token 401; `/` 200.
- GitHub variable `BACKUP_ENABLED` left untouched (currently `false` until the API token exists). The
  new `backup_stale` alarm stays silent until a successful nightly run reports `backup_enabled: true`.

# Deploy log: M7a hardening, code side (2026-10-13)

Commits `b33048d`…`0a30f93` (pushed to main). No migration in this milestone. From apps/api:

    npx wrangler d1 migrations list DB --remote --env production   # ✅ No migrations to apply
    npm run db:verify -- --remote --env production                 # repo root
    npm run build && npx wrangler deploy --env production

- `db:verify --remote`: 97 triggers (expected 97), 8 views (expected 8).
- Worker version `21929e52-8d81-4ab0-9bae-61bfe2cec2aa`. No new binding or secret; Turnstile is
  **off** (no `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` yet — docs/deploy.md §8).
- Checks (curl --resolve, 172.67.187.153): `/api/health` 200; `GET /api/auth/google/start` 302 to
  Google with `ratelimit-limit: 20`, `ratelimit-remaining: 19`; `/api/p` and `/api/p/logo` without a
  token 404; `POST /api/receipts/x/parent-link` without a session 401; `/p` 200 with the SPA CSP (no
  Turnstile origin while off); `/diag` 200 (SPA; the page itself is owner-only);
  `manifest.webmanifest` has `id`, `start_url: /`, `display: standalone`.

## Pending (user) — dashboard items for M7

1. WAF rate-limiting rules (docs/deploy.md §7).
2. Turnstile widget → `TURNSTILE_SITE_KEY` in wrangler.toml + `TURNSTILE_SECRET` secret, deploy (§8).
3. The M6 items above (API token → first nightly run → restore drill, R2 lifecycle rule, key escrow,
   B2), now tracked in docs/pilot-checklist.md.

# M7b (UI/UX polish), part 1: NOT deployed yet (branch `m7b-ui`)

Recorded ahead of the deploy so it is not missed. Migration **0024_m7b_school_identity** adds three
nullable columns to `school`: `short_name`, `city`, `brand_color` (plain `ALTER TABLE … ADD COLUMN`,
no table rebuild, no CHECK, no trigger change; `db:verify` still expects 97 triggers, 8 views). Safe
during school hours. When the branch is merged and deployed, from apps/api:

    npx wrangler d1 migrations list DB --remote --env production   # expect 0024_m7b_school_identity
    npx wrangler d1 migrations apply DB --remote --env production
    npm run db:verify -- --remote --env production                 # repo root
    npm run build && npx wrangler deploy --env production

Then: set the short name, city and colour in Settings → School (GSA: `GSA`, Pakpattan, blue), and add
`/api/identity*` to the WAF parent rule (docs/deploy.md §7) if the rule predates M7b.
No other schema change: `GET /api/dashboard/month` gains a `previous` object (last month's income,
spending, net) for the home strip's comparison, computed from the same five report queries.

# 2026-10-13: two installations (GSA pilot + public demo)

Decision (user): `maktab.conceptlix.com` becomes the public demo; the GSA pilot moves to its own
installation, **starting empty** (no data copied from the old production database).

## GSA pilot: `--env gsap`
- D1 `maktab-gsap` (`3e0f42ab-c488-475b-8aea-28e85b5e4549`, WEUR): migrations 0000–0024 applied;
  `db:verify --remote --env gsap`: 97 triggers (expected 97), 8 views (expected 8). Only the
  migration-seeded rows (8 expense categories, 12 message templates).
  (A first D1 of the same name, made while the plan was still "copy production", got a failed
  import that rolled back and was deleted; the production export file was destroyed with `rm -P`.)
- R2 `maktab-gsap-files` (new, empty). `BACKUPS` = `maktab-backups`.
- Worker `maktab-gsap`, custom domain `maktab-gsap.conceptlix.com`, cron `*/30 * * * *`.
- Vars: `APP_ORIGIN=https://maktab-gsap.conceptlix.com`, `OWNER_EMAIL=shahid.ics.pu@gmail.com`
  (Shahid Iqbal, GSA's owner: his first Google sign-in claims the empty installation and starts the
  setup wizard). No `DEMO_MODE`.
- Secrets (each `openssl rand`, piped, never printed): `SESSION_SECRET`, `PARENT_LINK_SECRET`,
  `BACKUP_REPORT_TOKEN` (one value, from a 0600 temp file into both the Worker and the GitHub
  secret, then `rm -P`).
- GitHub: variables `D1_DATABASE_NAME=maktab-gsap`, `APP_URL=https://maktab-gsap.conceptlix.com`;
  secret `BACKUP_REPORT_TOKEN` replaced. `nightly-backup.yml` / `restore-drill.yml` export
  `--env gsap` (`BACKUP_ENABLED` is still `false`).
- Checks: `/api/health` 200 ok; `/api/identity` `{"school":null}`; `/` 200 HTML;
  `/api/auth/google/start` 500 `misconfigured` (Google client secrets not set yet; see below).

## Public demo: `--env demo` (Worker `maktab`, D1 `maktab`, R2 `maktab-files`)
- `[env.production]` renamed `[env.demo]`: same Worker name, route and D1; `DEMO_MODE=1`,
  `OWNER_EMAIL=thefaysalmehmood@gmail.com`, cron `* * * * *`, no `BACKUPS` binding. Secrets kept
  (`SESSION_SECRET`, `PARENT_LINK_SECRET`, Google client); the old `BACKUP_REPORT_TOKEN` was
  deleted from it (the GitHub secret now matches gsap's).
- The old production rows (GSA's setup: school, 17 programmes, 10 subjects, 3 users) were wiped by
  the demo reset (`force` flag, docs/demo.md); D1 Time Travel can still return them until
  2026-10-20 if ever needed. The old logo object stays in `maktab-files` (unreferenced).
- Seeded remotely by the Worker itself (POST /api/demo/step loop); numbers in the M8/demo report.

## 2026-10-14: D1 daily write limit reached (account-wide)
- The 2026-10-13 seed (300 students, older plan) finished at 17:24 UTC. A reseed with the current
  plan started at 02:49 UTC on the 14th (force flag, step loop + cron). Fee generation for May hit
  error 1102 repeatedly (12 chunks an invocation); fixed by counting a generation chunk as 4 step
  calls. At step 113 of 191 Cloudflare alerted that the account's free D1 limit (100k rows written
  a day, shared with gsap) was reached.
- Stopped: the step loop killed; env demo redeployed with `crons = []` (version b6b65da7), so
  nothing advances the half-done reset. The demo shows a partial dataset until the next reseed.
  gsap untouched (its D1 still empty).
- Redesign (docs/demo.md "The D1 budget"): dataset cut to 135 students / 84 families, one week of
  registers, ~33k row writes for a full seed; the nightly reset plays back an undo log (cost ≈ what
  visitors wrote, cap 20k); one reset a UTC day; D1 quota errors stop the demo until 00:00 UTC; the
  demo runs no fee cron or daily pass.
- `BACKUP_REPORT_TOKEN`: set on env demo (random, unused there) and regenerated for env gsap and the
  GitHub secret together (one value, never printed).

## 2026-10-15: read limit too; both instances redeployed from `main` (`1aa5d58`)

- 2026-10-14 evening: the account's D1 daily **read** limit (5M rows) was also exhausted. Cause: the
  first demo seed's wipe (`DROP TABLE charge` after its indexes were dropped) scanned the table once
  per implicit row delete, n²/2 reads; the rest of the seed loop read whole views per receipt. The
  demo DB showed 11M rows read / 25k queries in 24 h; the gsap DB 713 rows. Fixed on `main`
  (docs/demo.md "The D1 budget": a full reseed ≈ 345k reads, an idle tick 23, the nightly undo
  ≈ 6k; migration 0025 adds two indexes; the quota guard recognises the read-limit error).
- 05:00 PKT reset. Steps run: migration 0025 applied to demo and gsap; `_demo_state.force = 1`
  on demo; `wrangler deploy --env gsap` (version f988c5c2 then the merged main); `wrangler deploy
  --env demo` (version 4831eb98, cron `* * * * *` restored; the first upload hung for 16 min on the
  Mac and was retried). The demo's old 300-student half-seed (plan 191 steps) is wiped and reseeded
  by the cron with today's anchor (158 steps). Expected D1 cost: ≈ 32k writes, ≈ 350k reads.
- The reseed stalled at step 84 (`generate:2026-08`): `wrangler tail` showed every cron tick ending
  in "Exceeded CPU Limit" (three 200-row generation chunks per invocation; the lease was left to
  expire, no `last_error`). Fix: the demo's generate step runs one 60-row chunk per invocation
  (`cost: 12`, `maxRows: 60`); redeployed, reseed resumed by the cron. Note for M7c: the pilot's fee
  cron runs the same generator with 200-row chunks, 3 a tick; watch `billing_chunk` failures there.
- Reseed finished at 05:29 UTC (version 7b08ec28; the last 70 steps driven through the public
  step route): 112 students, 70 families, 14 staff, 1,058 charges, 345 receipts, 520 marks, 201
  messages, 70 payslips, `ledger_consistency` empty, anchor 2026-10-15, 178 undo objects. D1 for
  the day so far: 340,017 rows read, 27,193 written (the budget held). The three demo sign-ins and
  `/api/me` work; the home screen shows 12 of 19 registers taken.
- **Security incident, same morning (not Maktab code):** between 03:53 and 03:56 UTC a stolen
  GitHub token pushed three unsigned commits to the default branch of all 35 of the owner's
  repositories, including this one (`21721c5`, `b82963b`, `6e73018`, `3e43230`): a workflow that
  posts repository secrets to an external server, a VS Code task that runs on folder open, and a
  JavaScript credential stealer disguised as `public/fonts/fa-solid-400.woff2`. Reverted here in
  `ed9b097`–`e2224f2`; the workflow never ran (every run needed approval); the files were removed
  from every other repository the same morning. If you cloned between 03:53 and 05:45 UTC on
  2026-10-15, delete the clone, do not open it in VS Code, and check `crontab -l` for `#ghc2`.
- Walkthrough fixes (A–K + review), anchored dataset (112 students, reseed Mondays and the 1st at
  02:00 PKT) and the README product page are live on both instances.

## 2026-10-15 evening → 2026-10-17: demo cron off; manual reseed with the idempotency fix

- 2026-10-15 evening (owner's decision, PR #5 `1bdd7bd`): the demo runs **no cron at all**
  (`[env.demo.triggers] crons = []`). Every D1 limit hit raises a Cloudflare alert to the owner, so
  the nightly undo, the Monday/1st reseed and the idle tick are all off until further notice. The
  demo keeps whatever visitors change; a reseed is a deliberate manual act (docs/demo.md "Re-deploy
  and re-seed"). gsap keeps its 30-minute fee cron (~1k reads a day). The 10-15 note above about
  reseeds "Mondays and the 1st" describes the code path, which is now never scheduled.
- Found in production 2026-10-17: the demo had 100 messages (absence + notice only), no fee
  reminders or payment messages. The 10-15 reseed had been cut twice mid-step (CPU limit, then the
  cron removal) and the `messages` step's "any message exists" check skipped the remaining
  sub-steps on resume. Fixed in PR #7 `2649bac` (every sub-step idempotent on its own rows; PLAN
  §15 row 2026-10-17).
- 2026-10-17 07:39–08:46 UTC: PR #7 merged (`3bcff55`), `wrangler deploy --env demo` (version
  be403947), `_demo_state.force = 1`, the reseed driven to `done` through `POST /api/demo/step`
  (160 steps, 67 minutes; the public route answers one step per call). Result: 112 students, 1,058
  charges, 346 receipts, 524 marks, **184 messages**, 40 parent links, 12 concessions,
  `ledger_consistency` empty, anchor 2026-10-17, no leftover `force` row. `wrangler d1 info` for the
  demo DB over the trailing 24 h: 591,189 rows read, 42,221 written; that window also contains the
  earlier partial drive of the same morning, so the reseed itself stayed inside the ~345k / ~29k
  budget. Both figures are well under the account's 5M / 100k daily limits; no alert.
- gsap unchanged (`main` `6975cdb` build of 2026-10-15, migration 0025 applied). Its Google sign-in
  still answers 500 `misconfigured`: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are not set on env
  gsap (`wrangler secret list --env gsap` shows three secrets).

## 2026-10-17 (later): carried-gaps pass deployed; WAF rule and R2 lifecycle set

- PR #9 (`5a9ad33`): student header "Message family" + avatar as "Change photo"; fee register opens
  on a class (PLAN §15 row 2026-10-17, carried-gaps pass). Blind review + fix pass; 1,212 tests.
  `wrangler deploy --env demo` version 880d8581, `--env gsap` version 4d072ab2 (both from `main`
  `5a9ad33`; no migration). Demo sign-ins 200, `/api/identity` 200 on both hosts. (An earlier
  deploy the same evening, versions 369febb8 / 0a9f15cc, was built from `main` `1bbc809` because
  the PR merge had been refused while a second CI run was still in progress; superseded.)
- **WAF rate-limit rule** (docs/deploy.md §7, free-plan single rule) deployed by the owner from the
  form Fable filled in: "maktab public surfaces", hosts `maktab.conceptlix.com` and
  `maktab-gsap.conceptlix.com`, paths `/p`, `/p/*`, `/api/p`, `/api/p/*`, `/api/identity*`,
  `/api/auth*`, 10 requests / 10 s per IP, Block 10 s. Verified on the demo host: 16 requests to
  `/api/identity` → 10 × 200, 6 × 429; 16 to `/api/payroll` → never 429.
- **R2 lifecycle** on `maktab-backups`: rule `daily-95d` (prefix `daily/`, expire after 95 days) added
  with `wrangler r2 bucket lifecycle add`; `monthly/` has no rule (docs/backup.md §4).
- Turnstile is still off on both hosts (the owner creates the widget; the secret must not pass
  through chat or an agent).

## 2026-10-17: self-host build (M8a; built and smoke-tested, NOT deployed yet)

Owner decision: the GSA pilot runs on the owner's homelab in Docker at **https://gsap.conceptlix.com**
through the existing Cloudflare Tunnel; the demo stays on Cloudflare; the Worker env `gsap`
(maktab-gsap.conceptlix.com) stays as a cold fallback only. Branch `selfhost` (docs/self-host.md):

- `apps/api/src/node.ts`: the same `createApp` on `@hono/node-server`, better-sqlite3 (one connection,
  WAL, busy_timeout, foreign keys), wrangler-compatible migrations on start (`d1_migrations`), the
  `db:verify` trigger/view check (refuses to start on a difference), Workers-Static-Assets behaviour
  for `apps/web/dist` (`_headers` parsed, SPA fallback, immutable hashed assets), `/healthz`,
  `/__scheduled` 404, client IP from CF-Connecting-IP / X-Forwarded-For only for rate limits and logs,
  refuses `DEMO_MODE` or a missing `SESSION_SECRET`.
- Local file store standing in for R2 (`FILES` = `data/files`, `BACKUPS` = `data/backups`); in-process
  cron (every 30 min, `runScheduled` + `runDailyOps`) and a nightly 02:30 PKT age-encrypted SQLite
  backup recorded like `POST /api/backup/runs`.
- `Dockerfile` (node:24-bookworm-slim, non-root, tini, HEALTHCHECK), `deploy/selfhost/`
  (instance-parameterised compose for `/srv/homelab/maktab/`, `install.sh`, `.env.example`),
  `scripts/selfhost-smoke.sh` (passed on the Mac, native arm64 build).
- Not done yet (owner, on the homelab): clone to `/srv/homelab/maktab/src`, `install.sh gsap`, fill
  `gsap/.env`, add the tunnel public hostname `gsap.conceptlix.com -> http://maktab-gsap:8787`, the
  Google redirect URI, `gsap.conceptlix.com` in the WAF rule; an off-site copy of `data/backups/`.

## Pending (user)
1. Self-hosted pilot (docs/self-host.md): on the homelab clone the repo to `/srv/homelab/maktab/src`,
   `sudo src/deploy/selfhost/install.sh gsap`, fill `gsap/.env` (`APP_ORIGIN=https://gsap.conceptlix.com`,
   Google client, `AGE_RECIPIENT`), tunnel public hostname `gsap.conceptlix.com -> http://maktab-gsap:8787`,
   Google Cloud console redirect URI `https://gsap.conceptlix.com/api/auth/google/callback`, and add
   `gsap.conceptlix.com` to the WAF rule "maktab public surfaces". Verify: `/api/auth/google/start`
   redirects to Google. (The Worker env `gsap` at maktab-gsap.conceptlix.com is a fallback only; it
   needs its own Google secrets only if it is ever used again.)
2. Tell Shahid Iqbal to sign in at gsap.conceptlix.com with shahid.ics.pu@gmail.com (he
   becomes owner and runs the setup wizard); then invite thefaysalmehmood@gmail.com if you need
   access to the pilot.
3. Turnstile widget (docs/deploy.md §8), optional: hostnames include `gsap.conceptlix.com`; for the
   self-hosted pilot both keys go in `gsap/.env` (docs/self-host.md §5). (The
   WAF rule and the R2 lifecycle rule are done, see above.)
4. M7c pilot gate items now apply to the self-hosted gsap (first nightly backup in Settings →
   Backup, restore drill per docs/self-host.md §7, an off-site copy); docs/pilot-checklist.md is
   the tick list.
5. GitHub account follow-up (not Maktab): the 91 disabled malicious workflow files in the other
   repositories are still present; deleting them needs a token with the `workflow` scope
   (`gh auth refresh -h github.com -s workflow`).

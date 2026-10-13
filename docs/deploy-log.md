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

# Deploy runbook

Production deploys are a human decision (PLAN §15: ask first). This is the order, every time.

## Two installations (since 2026-10-13; the pilot self-hosted since 2026-10-17)

| | GSA pilot (the real school) | Public demo |
|---|---|---|
| URL | https://gsap.conceptlix.com | https://maktab.conceptlix.com |
| Runs on | the owner's homelab in Docker, via the Cloudflare Tunnel (**docs/self-host.md**) | Cloudflare Workers, `--env demo` |
| Database | SQLite file `/srv/homelab/maktab/gsap/data/maktab.sqlite` | D1 `maktab` (`440d652e-…`) |
| Files | `/srv/homelab/maktab/gsap/data/files/` | R2 `maktab-files` |
| Backups | built-in nightly job on the homelab (docs/self-host.md §7) | never |
| `OWNER_EMAIL` | shahid.ics.pu@gmail.com (GSA's owner) | thefaysalmehmood@gmail.com |
| `DEMO_MODE` | never (the server refuses to start with it) | `1` (docs/demo.md) |
| Cron | in-process, every 30 min | none since 2026-10-15 (docs/demo.md) |

**Fallback only:** the Cloudflare Worker env `gsap` (Worker `maktab-gsap`, D1 `maktab-gsap`
`3e0f42ab-…`, R2 `maktab-gsap-files`, https://maktab-gsap.conceptlix.com) stays deployed as a cold
fallback. It is not the pilot's system of record, and once the homelab is live it is no longer what
the GitHub backup workflows protect (they still export that D1; the workflows are unchanged). The
sections below describe a Workers deploy and apply to the demo and to that fallback; the pilot is
upgraded with docs/self-host.md §6.

Each installation has its own `SESSION_SECRET`, `PARENT_LINK_SECRET` and Google client secrets.
Later (M8), GSA may move to its own free Cloudflare account if that stays zero-cost.

**Google OAuth (user, by hand).** Add the authorised redirect URI
`https://gsap.conceptlix.com/api/auth/google/callback` to the OAuth client and put the client's
values in `/srv/homelab/maktab/gsap/.env` (docs/self-host.md §4). The fallback Worker would need
`https://maktab-gsap.conceptlix.com/api/auth/google/callback` and
`npx wrangler secret put GOOGLE_CLIENT_ID --env gsap` (and `GOOGLE_CLIENT_SECRET`). The demo keeps
the `maktab.conceptlix.com` redirect URI it already has, and its demo buttons need no Google.

## 1. Before

- `main` is green: `npm run typecheck && npm run lint && npm test && npm run build`, and
  `npx tsx packages/db/scripts/sync-custom-sql.ts --check` (no unrecorded `packages/db/sql` change,
  no edited migration).
- Take a backup you can restore (docs/restore.md §B). Migrations are forward-only; the way back is
  Time Travel or the backup, never a down-migration.
- Migration 0024 (M7b: `school.short_name`, `city`, `brand_color`) only adds nullable columns; no
  rebuild, no trigger change (docs/deploy-log.md, M7b part 1).
- Never deploy during school hours: a migration that rebuilds a table (0004, 0008, 0010) holds the
  database for its duration.

## 2. Migrate

```sh
cd apps/api
npx wrangler d1 migrations list DB --remote --env gsap    # what will run
npx wrangler d1 migrations apply DB --remote --env gsap
```

Migrations that rebuild a money table (0008, 0010) drop the ledger views and the triggers that read
that table, and the custom migration right after them (0009, 0011) re-creates them. Both are applied
by the same `apply`; if it stops between the two, run `apply` again before anything else.

## 3. Verify the rules are all there

```sh
npm run db:verify -- --remote --env gsap    # from the repo root
```

It reads `sqlite_master` and compares it with what `packages/db/sql/*.sql` creates (the files the
custom-SQL manifest records): every trigger and view must be present and nothing extra, and every
index those files create must exist. It prints the counts, e.g.

```
remote D1: 72 triggers (expected 72), 4 views (expected 4)
```

and exits 1 on any difference (`missing trigger:…` / `unexpected trigger:…`). By hand, the same check
is `SELECT count(*) FROM sqlite_master WHERE type = 'trigger'` (72 after migration 0011) and
`… WHERE type = 'view'` (4). Locally: `npm run db:migrate:local && npm run db:verify`
(`D1_PERSIST_TO=<dir>` for both if wrangler runs with `--persist-to`).

A missing trigger means a money rule is off: do not deploy the Worker; re-run `migrations apply`, then
`db:verify` again.

## 4. Secrets

Set once per environment, each its own random value (never echo it, never reuse one for another):

```sh
cd apps/api
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --env gsap
openssl rand -base64 48 | npx wrangler secret put PARENT_LINK_SECRET --env gsap
```

`PARENT_LINK_SECRET` (M5) keys everything about parent links: the link tokens (HMAC of a per-link
salt), the gate tokens, PIN hashes and the access log's IP hashes. Without it (or shorter than 32
characters) the Worker logs a config warning and every parent-link route answers 503 `misconfigured`.
Keep a copy with the backup trustees: a restore needs the **same** value (docs/restore.md).

Rotating it is how every parent link is revoked at once (a leak, a departing admin): put a new value,
then, signed in as the owner, `POST /api/parent-links/rotate-all` (Settings → Messages → "Revoke all
parent links"). Old links stop being recomputable, so the next "Open WhatsApp" for a guardian makes a
fresh one; guardians need the new message. Rotation does not touch staff sessions.

`BACKUP_REPORT_TOKEN` (M6) lets the GitHub Actions backup and restore-drill workflows report runs to
`POST /api/backup/runs`; the GitHub secret of the same name must hold the same value. Generate it once
into a 0600 temp file, feed both sides from the file, shred it (docs/backup.md §3). Without it the
route answers 503 and Settings → Backup says reporting is off. The Worker also binds the R2 bucket
`maktab-backups` as `BACKUPS` (read-only use: listing the newest dumps).

## 5. Deploy the Worker

```sh
npm run build
cd apps/api && npx wrangler deploy --env gsap
```

## 6. After

- Sign in, open the fee counter for one family, the cash sessions list, `GET /api/fees/runs?period=<this month>`
  (`failing` must be empty; a failing group is retried by the cron every 30 minutes and shows its
  error code here).
- `SELECT * FROM ledger_consistency` is empty.
- Parent page: `curl -sI https://<host>/p` is 200 HTML with `x-robots-tag: noindex`,
  `cache-control: no-store`, the CSP and `permissions-policy`; `curl -s https://<host>/api/p` is a JSON
  404 with `x-robots-tag: noindex` (no token). Links are `https://<host>/p#<token>`: the token is a
  URL fragment and never reaches a server log.

## 7. Rate limiting (Cloudflare WAF rules — set by hand in the dashboard)

The Worker has an in-memory per-IP limiter on `/api/p` + `/api/p/…` (60/min) and `/api/auth/…`
(20/min), which answers `429 rate_limited` with `Retry-After` and `RateLimit-Limit/Remaining/Reset`
headers. Its path match is exact (`rateClass` in `apps/api/src/lib/ratelimit.ts`): `/api/payroll`,
`/api/payslips`, `/api/parent-links`, `/api/programmes` are **not** parent routes. It is per isolate,
so it is defence in depth only; **the real limits are the WAF rules below**. Dashboard → the
`conceptlix.com` zone → Security → WAF → **Rate limiting rules** → Create rule.

Match paths precisely, never with a bare `starts_with(path, "/p")` (that would also count `/payroll`,
`/api/payslips`, `/api/programmes` … against the parent limit):

| # | Rule name | If incoming requests match (expression) | Characteristics | Rate | Action | Duration |
|---|---|---|---|---|---|---|
| 1 | maktab parent page | `(http.host in {"maktab.conceptlix.com" "maktab-gsap.conceptlix.com" "gsap.conceptlix.com"} and ((http.request.uri.path eq "/p") or starts_with(http.request.uri.path, "/p/") or (http.request.uri.path eq "/api/p") or starts_with(http.request.uri.path, "/api/p/") or (http.request.uri.path eq "/api/identity") or starts_with(http.request.uri.path, "/api/identity/")))` | IP | 60 requests / 1 minute | Block (429) | 1 minute |
| 2 | maktab sign-in | `(http.host in {"maktab.conceptlix.com" "maktab-gsap.conceptlix.com" "gsap.conceptlix.com"} and ((http.request.uri.path eq "/api/auth") or starts_with(http.request.uri.path, "/api/auth/")))` | IP | 20 requests / 1 minute | Block (429) | 1 minute |
| 3 | maktab API writes | `(http.host in {"maktab.conceptlix.com" "maktab-gsap.conceptlix.com" "gsap.conceptlix.com"} and http.request.method eq "POST" and starts_with(http.request.uri.path, "/api/"))` | IP | 300 requests / 1 minute | Block (429) | 1 minute |

**Hosts:** every expression covers all three Maktab hosts (the demo, the Cloudflare fallback and,
since 2026-10-17, the self-hosted pilot `gsap.conceptlix.com`, whose tunnel traffic passes the
zone's WAF like any other). That is the set deployed in the merged rule below.

**Free plan: one rule only** (and a 10 s period, so "60 / 1 minute" becomes "10 / 10 seconds", and
"20 / 1 minute" becomes "4 / 10 seconds" — Cloudflare counts per period). Rules 1 and 2 cannot keep
their own rates in one rule, so on the free plan create this **single merged rule** at the stricter
sign-in rate and record it in docs/deploy-log.md:

| Rule name | Expression | Characteristics | Rate | Action | Duration |
|---|---|---|---|---|---|
| maktab public surfaces | `(http.host in {"maktab.conceptlix.com" "maktab-gsap.conceptlix.com" "gsap.conceptlix.com"} and ((http.request.uri.path eq "/p") or starts_with(http.request.uri.path, "/p/") or (http.request.uri.path eq "/api/p") or starts_with(http.request.uri.path, "/api/p/") or (http.request.uri.path eq "/api/identity") or starts_with(http.request.uri.path, "/api/identity/") or (http.request.uri.path eq "/api/auth") or starts_with(http.request.uri.path, "/api/auth/")))` | IP | 10 requests / 10 seconds | Block (429) | 10 seconds |

A parent page load is about 3–4 requests (shell, `/api/p`, the logo, a gate attempt) and a sign-in
is 2–3, so 10 per 10 s per IP leaves room for a whole office on one NAT IP; the Worker's own per-IP
limits (60/min parent, 20/min sign-in) and the 5-attempt D1 gate lockout still apply underneath.
Rule 3 is then not available; the D1 budget and the Worker limiter are what stand in front of
`POST /api/*` until the zone moves to Pro.

Notes: rule 1 matches `/p` and `/p#…` (the fragment never reaches the server) and every `/api/p/…`
call, including the public school badge `GET /api/p/badge` and logo `GET /api/p/logo` (M7b). It
also covers the sign-in page's public identity routes added in M7b, `GET /api/identity` (name,
city, short name, colour, office phone, logo version) and `GET /api/identity/logo`: no session, no
personal data, cacheable, but unauthenticated, so they sit under the same per-IP limit. (The
Worker's own in-isolate limiter does not cover `/api/identity*`; the WAF rule is the limit there.) Rule 3 also covers `POST /api/backup/runs` (token-only; no Turnstile needed there). A school
behind one NAT IP (all office phones on one Wi-Fi) stays far below 300 POSTs a minute; if a busy
counter ever hits it, raise rule 3, never remove it. Check: `for i in $(seq 70); do curl -s -o
/dev/null -w '%{http_code}\n' https://maktab-gsap.conceptlix.com/api/p; done | sort | uniq -c` shows 429s,
and the same loop on `/api/payroll` (a 401, signed out) never does.

## 8. Turnstile (optional; set by hand)

Off until both values exist; with either missing everything behaves as before. On: the parent gate
(`POST /api/p/gate`, birth year / PIN) needs a Turnstile token before an attempt is counted, and
`GET /api/auth/google/start` first shows a one-click check page, then goes on to Google.

1. Dashboard → **Turnstile** → Add widget. Name `maktab`; Hostnames `maktab-gsap.conceptlix.com`
   (add `localhost` only on a separate test widget); Widget mode **Managed**; pre-clearance off.
   Create. Copy the **Site key** (public) and the **Secret key**.
2. Site key: in `apps/api/wrangler.toml` under `[env.gsap.vars]` set
   `TURNSTILE_SITE_KEY = "<site key>"` (public, fine in git) and commit.
3. Secret (never in git or chat): `cd apps/api && npx wrangler secret put TURNSTILE_SECRET --env gsap`
   and paste it at the prompt.
4. `npm run build && cd apps/api && npx wrangler deploy --env gsap`.
5. Check: `curl -s https://maktab-gsap.conceptlix.com/api/auth/google/start | grep cf-turnstile` finds the
   widget; `curl -sI https://maktab-gsap.conceptlix.com/p | grep -i content-security` lists
   `https://challenges.cloudflare.com`; open a parent link with a gate on a phone: the widget shows
   under the birth-year box and "Open" waits for it.

Failure policy (`apps/api/src/lib/turnstile.ts`): Cloudflare's answer is checked for
`success: true` **and** a `hostname` equal to the host of `APP_ORIGIN` (a token solved on another
site is refused); the client IP goes along as `remoteip`. If siteverify itself cannot be reached
(network error, timeout, 5xx), **sign-in fails open** — staff can still reach Google, which is the
real authentication, and the sign-in rate limits still apply — while the **parent gate fails
closed** ("try again"): the gate's real limiter is the atomic 5-attempt lockout in D1, so a short
Turnstile outage only delays a parent, it never opens extra guesses. An explicit `success: false`
fails closed on both.

To turn it off again: `npx wrangler secret delete TURNSTILE_SECRET --env gsap` (or remove the
var) and deploy. Testing keys for a local check (`apps/api/.dev.vars`): site key
`1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` always pass (they answer with hostname
`example.com`, so the hostname check is skipped only while `APP_ORIGIN` is `http://localhost…`).

## First deploy notes (2026-10-10, see docs/deploy-log.md; that host is now the demo)

- Production host is `maktab.conceptlix.com`. wrangler created the DNS record and certificate itself
  (custom domain), as the zone is on the same Cloudflare account; the local resolver may lag a few
  minutes (`curl --resolve` or `dig @1.1.1.1` works sooner).
- R2 must be enabled in the dashboard (card on file) before `wrangler r2 bucket create`; until then
  the production `FILES` binding stays commented out in `apps/api/wrangler.toml` and photo upload
  answers 501. `db:verify` prints a harmless "add r2_buckets to env.gsap" warning meanwhile.
- `GET /api/auth/google/start` returns 500 `misconfigured` until GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
  are set; that is expected.
- `wrangler tail` needs several seconds to attach; wait ~15 s before generating traffic.

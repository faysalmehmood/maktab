# Self-hosting Maktab (Docker, SQLite on disk)

PLAN §8's portability requirement, built in M8a (2026-10-17): the same app as the Cloudflare Worker
(`createApp` in `apps/api/src/app.ts`), run by Node in one container, with the database in one
SQLite file and photos and backups in plain folders. One container is one school.

The GSA pilot runs this way on the owner's homelab at **https://gsap.conceptlix.com**, reached through
the existing Cloudflare Tunnel; the public demo stays on Cloudflare Workers (docs/demo.md). The
Cloudflare Worker env `gsap` (https://maktab-gsap.conceptlix.com) is kept as a cold fallback only.

Quickstart: `deploy/selfhost/README.md`. This page is the full version.

## 1. What runs

| Piece | Self-hosted | On Cloudflare (for comparison) |
|---|---|---|
| HTTP | `@hono/node-server`, port 8787 (`apps/api/src/node.ts`) | Worker |
| Database | `DATA_DIR/maktab.sqlite`, better-sqlite3, one connection, WAL, `synchronous=FULL` (a commit survives a power cut), `busy_timeout` 5 s, foreign keys on | D1 |
| Migrations | applied on every start from `packages/db/migrations`, recorded in `d1_migrations` exactly as `wrangler d1 migrations apply` does; an upgrade first saves the database to `backups/pre-migrate/`; then the `db:verify` trigger/view check, and the server **refuses to start** on any difference | `wrangler d1 migrations apply` by hand |
| Files (photos, logo, expense proofs) | `DATA_DIR/files/` | R2 `FILES` |
| Backups | built-in nightly job at 02:30 Karachi → `DATA_DIR/backups/`, plus the host's off-site copy (§7) | GitHub Actions → R2 + B2 |
| Cron (fees, fines, daily alarms) | in-process every 30 min (first run 60 s after start) | Workers cron `*/30` |
| Web app | `apps/web/dist`, served with the same rules as Workers Static Assets (below) | `[assets]` |

Static files behave as the live Workers deploy does: `/api/*`, `/p`, `/p/*` go to the app first
(`run_worker_first`, a test keeps the list equal to `wrangler.toml`); an existing file in
`apps/web/dist` is served with the rules of `apps/web/public/_headers` applied (the file is parsed at
start, never copied); `/index` and `/index.html` redirect (307) to `/`; **every other path answers
`index.html` with 200** (single-page-application fallback, whatever the request's Sec-Fetch-Mode or
Accept header, so `/students`, `/assets/missing.js`, `/_headers` and `/.env` all get the app shell;
there is no `/x` → `x.html` mapping). Content-hashed files under `/assets/` are cached for a year
(`immutable`), everything else revalidates against an ETag that is a hash of the file's content. No
directory listing, no dot-files. `/__scheduled` answers 404 (there is no HTTP cron trigger).
`GET /healthz` (self-hosted only) answers `{"status":"ok","db":"ok"}`, or 503 when the database
cannot answer; the `version` is added only for a caller inside the container (the HEALTHCHECK,
`docker exec`).

Client IP: cloudflared sets `CF-Connecting-IP`. The server believes that header **only when the TCP
peer is inside `TRUST_PROXY_FROM`** (the `homelab` network's subnet), and only if it is exactly one
valid IP; otherwise the client IP is the socket peer. X-Forwarded-For is never read. The app then
sees exactly one value, used for the per-IP rate limits, the parent-page access log and Turnstile's
`remoteip`, never for anything else: cookies, CSRF and redirects all follow `APP_ORIGIN`.

## 2. Prerequisites

- Linux x86_64 (or arm64), Docker 24+ with Compose v2+ (the homelab: Ubuntu 24.04, Docker 29,
  Compose v5), about 1 GB of disk for the image build plus the school's data.
- **The homelab user is uid 1000 and in the `docker` group** (`id` shows `uid=1000` and `docker`;
  if not: `sudo usermod -aG docker $USER`, then log in again). uid 1000 is also the container's
  user, so the data folder is readable by both without sudo. Everything below runs as that user.
- `/srv/homelab/maktab` exists and belongs to that user. If `/srv/homelab` itself is root's, once:
  `sudo install -d -o 1000 -g 1000 /srv/homelab/maktab` (the only sudo in this guide, with the
  chown fallback in §3).
- The external Docker network `homelab` (`docker network create homelab` if it does not exist) with
  the remote-managed `cloudflared` container on it; `openssl` and `git` on the host.
- Outbound internet from the container: Google sign-in (token exchange, JWKS) and, if enabled,
  Turnstile's siteverify.
- The backup public key (`age1…`, docs/backup.md §1) and, for a restore, the private key with the
  trustees.
- For the off-site copy (§7, required): `rclone` on the host and a bucket off this machine (R2 or B2).

## 3. Install (first run)

Layout on the server (one stack folder, one sub-folder per school, all owned by the homelab user):

    /srv/homelab/maktab/
      docker-compose.yml        from deploy/selfhost/ (install.sh copies it)
      src/                      the repository checkout the image is built from
      gsap/.env                 the school's settings and secrets (0600)
      gsap/data/                maktab.sqlite (+ -wal, -shm), files/, backups/, tmp/   (0700)

Steps (as the homelab user, no sudo):

    git clone https://github.com/faysalmehmood/maktab.git /srv/homelab/maktab/src
    /srv/homelab/maktab/src/deploy/selfhost/install.sh gsap     # 1st run: creates gsap/.env, stops
    nano /srv/homelab/maktab/gsap/.env       # APP_ORIGIN, OWNER_EMAIL, GOOGLE_*, AGE_RECIPIENT, BACKUP_RCLONE_REMOTE
    /srv/homelab/maktab/src/deploy/selfhost/install.sh gsap     # 2nd run: builds, starts, prints /healthz
    docker logs maktab-gsap                  # "database ok: … 97 triggers (expected 97) …"

`install.sh` is idempotent and needs no sudo. It refuses to run as a user other than uid 1000 (or
root), checks `docker` and `openssl`, copies the compose file (keeping a `.bak` of a changed one),
creates `gsap/` and `gsap/data/` (0700). On the first run it creates `gsap/.env` (0600) from
`deploy/selfhost/.env.example` with fresh random `SESSION_SECRET` and `PARENT_LINK_SECRET` (checked
for length, written with the shell's `printf`, never printed or passed as a command argument) and
`TRUST_PROXY_FROM` set to the `homelab` network's subnet, then stops so you fill in the rest. An
existing `.env` is never touched. Later runs refuse to start the container until `AGE_RECIPIENT` is
set, tag the current image `maktab-gsap:previous` (§6), build, start and print `/healthz`.

If the data folder was ever created by root (e.g. by an older script), give it back once:
`sudo chown -R 1000:1000 /srv/homelab/maktab` (the chown fallback; install.sh prints it when needed).

The compose project and container are `maktab-${INSTANCE}` (default `gsap`), the image
`maktab-${INSTANCE}:local`; limits 1 GB memory, 256 processes. Another school is another folder:
`install.sh <name>`, then `INSTANCE=<name> docker compose …` for that school. The container
publishes **no host port**; it is reachable only on the `homelab` network.

By hand instead of `install.sh` (any machine with Docker):

    docker build -t maktab-gsap:local --build-arg MAKTAB_VERSION=$(git describe --always) .
    docker run -d --name maktab-gsap --network homelab --env-file gsap/.env \
      -v "$PWD/gsap/data:/data" --user 1000:1000 --cap-drop ALL \
      --security-opt no-new-privileges --read-only --tmpfs /tmp \
      --restart unless-stopped maktab-gsap:local

## 4. Cloudflare Tunnel and Google

1. Zero Trust → Networks → Tunnels → the homelab tunnel → **Public hostnames** → Add:
   subdomain `gsap`, domain `conceptlix.com` (so **gsap.conceptlix.com**), service
   **`http://maktab-gsap:8787`**. `gsap.conceptlix.com` is a new name, so no Worker custom domain
   needs releasing; the Worker env `gsap` keeps `maktab-gsap.conceptlix.com` as its fallback.
2. Google Cloud console → the OAuth client → Authorised redirect URIs → add
   **`https://gsap.conceptlix.com/api/auth/google/callback`** (keep the old ones). Put the same
   client's `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `gsap/.env`.
3. WAF: the rate-limit rule "maktab public surfaces" (docs/deploy.md §7) lists
   `gsap.conceptlix.com` in its `http.host in {…}` set (tunnel traffic passes the zone's WAF like any
   other). If Turnstile is used, add `gsap.conceptlix.com` to the widget's hostnames and set
   `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` in `gsap/.env`.
4. Check from outside: `curl -s https://gsap.conceptlix.com/api/identity` answers `{"school":null}`
   on an empty installation; `curl -sI https://gsap.conceptlix.com/ | grep -i content-security`
   shows the CSP; `curl -s https://gsap.conceptlix.com/healthz` shows no version. The owner
   (`OWNER_EMAIL`) signs in once and the setup wizard starts.
5. Check the client IP is right: `docker logs maktab-gsap` must not show the warning
   "TRUST_PROXY_FROM is empty", and `docker network inspect homelab -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}'`
   must lie inside `TRUST_PROXY_FROM` (or use `172.16.0.0/12`, which covers Docker's default
   networks). Otherwise every visitor counts as cloudflared's one address and the sign-in limit
   (20 a minute) applies to the whole school at once.

## 5. Environment (`/srv/homelab/maktab/<instance>/.env`)

The server checks these at start and **refuses to start** (one line in `docker logs`, exit 1) on a
problem marked "refuses".

| Variable | Required | Meaning |
|---|---|---|
| `APP_ORIGIN` | yes, refuses | public origin, `https://gsap.conceptlix.com` (https only; http only for localhost) |
| `SESSION_SECRET` | yes, refuses | ≥ 32 random chars. Changing it signs everyone out |
| `PARENT_LINK_SECRET` | yes in practice | if set, ≥ 32 chars (refuses otherwise); missing = a loud warning and no parent links. A restore needs the same value (docs/restore.md) |
| `AGE_RECIPIENT` | yes, refuses | the public `age1…` key for the backups (same as the GitHub secret); checked by encrypting one byte at start |
| `ALLOW_UNENCRYPTED_BACKUPS` | no | `1` = allow an empty `AGE_RECIPIENT` (test installs only: backups are then plain `.sqlite.gz`) |
| `TRUST_PROXY_FROM` | yes in practice | IPs/CIDRs (comma or space separated) whose `CF-Connecting-IP` is believed: the `homelab` subnet (install.sh fills it) or `172.16.0.0/12`. Empty = trust nobody (a warning: every visitor then shares cloudflared's rate-limit bucket). A malformed entry refuses |
| `OWNER_EMAIL` | first run | the only Google account that may claim the empty installation |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for sign-in | the OAuth client (step 4.2) |
| `BACKUP_RCLONE_REMOTE` | yes in practice | the off-site target the host copies to (§7), e.g. `r2:maktab-backups/homelab-gsap`; shown in Settings → Backup |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | no | both or neither (docs/deploy.md §8) |
| `BACKUP_REPORT_TOKEN` | no | ≥ 32 chars; only for an external job posting to `POST /api/backup/runs`. The built-in backup records itself |
| `DEMO_MODE` | never, refuses | the server refuses to start if it is set to anything |
| `TRUST_PROXY` | removed, refuses | replaced by `TRUST_PROXY_FROM` |
| `DATA_DIR`, `PORT`, `HOST` | no | set by the image/compose: `/data`, `8787`, `0.0.0.0` |
| `MAKTAB_SCHEDULER` | no | `0` turns the cron and the nightly backup off (tests only) |

Secrets are never logged; the start-up log names only missing settings. Unexpected errors are logged
as one line (name, message, code), never with a query's parameters.

## 6. Upgrade and rollback

    cd /srv/homelab/maktab
    git -C src pull
    src/deploy/selfhost/install.sh gsap     # tags :previous, rebuilds, recreates, prints /healthz

On start, when the database already has migrations and the new release brings more, the server
first writes a full encrypted copy to `data/backups/pre-migrate/<UTC time>-<last applied migration>.sqlite.gz.age`
(the same snapshot + gzip + age path as the nightly backup); **if that copy fails, nothing is
migrated** and the server stops with the reason. Then only the new migrations run, each in one
transaction (a failing one is rolled back whole and the server stops; the database is as before).
`pre-migrate/` is never pruned (one file per upgrade).

**Rollback** (the new release misbehaves after its migrations ran):

    cd /srv/homelab/maktab
    docker compose stop
    ls gsap/data/backups/pre-migrate/                       # the newest file is from this upgrade
    age -d -i maktab-backup-key.txt gsap/data/backups/pre-migrate/<file>.sqlite.gz.age | gunzip > before.sqlite
    mv gsap/data/maktab.sqlite gsap/data/maktab.sqlite.failed-upgrade
    rm -f gsap/data/maktab.sqlite-wal gsap/data/maktab.sqlite-shm
    install -m 0600 before.sqlite gsap/data/maktab.sqlite && shred -u before.sqlite
    MAKTAB_IMAGE=maktab-gsap:previous docker compose up -d --no-build
    docker logs maktab-gsap                                 # "0 migration(s) applied now"

Anything entered between the upgrade and the rollback is lost (it is in `maktab.sqlite.failed-upgrade`).
To go forward again later: `docker compose up -d` (the `:local` image) re-applies the migrations.
When CI publishes images (later), set `MAKTAB_IMAGE=ghcr.io/faysalmehmood/maktab:<tag>` in
`/srv/homelab/maktab/.env` and use `docker compose pull && docker compose up -d` instead.

## 7. Backups and restore

Nightly at 02:30 Asia/Karachi (and on the first cron tick after a missed 02:30; one attempt a day,
the 02:30 timer skips a day already attempted):

1. SQLite's online backup copies the live database to `data/tmp/` (consistent; the app keeps serving);
2. gzip, then age-encrypted to `AGE_RECIPIENT`;
3. written atomically to `data/backups/daily/<YYYY-MM-DD>.sqlite.gz.age` with a `.sha256`
   (`sha256sum` format); the month's first backup is also copied to `data/backups/monthly/` (so a
   server that was down on the 1st still keeps one per month);
4. `daily/` older than 95 days is deleted; `monthly/` and `pre-migrate/` are kept;
5. the run is recorded like a GitHub report, so Settings → Backup shows **Last nightly backup** and
   lists the newest files, and the alarms see it. Status **OK** only when the host's off-site copy
   (step 7.2) confirmed itself in the last 48 hours; otherwise **partial** with the note "no off-site
   copy". The plain snapshot is deleted in every case.

### 7.1 Alarms

- `backup_stale`: no good nightly run in 36 hours, or the latest failed (as on Cloudflare).
- `backup_offsite`: shown on Settings → Backup and the dashboard when the last run with an off-site
  copy is more than 7 days old, or when the installation is 7+ days old and no run ever had one.

### 7.2 The off-site copy (required)

The backups above sit on the same disk as the database: a fire, a theft or a dead disk takes both.
The host copies them off every night and tells the server it did.

1. Install rclone (`sudo apt install rclone` is fine, or the user-local binary) and make a remote as
   the homelab user: `rclone config` → `r2` (type `s3`, provider `Cloudflare`, an R2 API token with
   **Object Read & Write on `maktab-backups` only**, endpoint `https://<account id>.r2.cloudflarestorage.com`),
   or a Backblaze B2 bucket. The files are already encrypted; the remote never sees the key.
2. Save `/srv/homelab/maktab/offsite-gsap.sh` (mode 0700):

       #!/usr/bin/env bash
       set -euo pipefail
       SRC=/srv/homelab/maktab/gsap/data/backups
       DST=r2:maktab-backups/homelab-gsap
       rclone copy "$SRC" "$DST" --exclude '.*' --exclude OFFSITE_OK
       rclone check "$SRC" "$DST" --one-way --exclude '.*' --exclude OFFSITE_OK
       date -u +%Y-%m-%dT%H:%M:%SZ > "$SRC/OFFSITE_OK"

3. `crontab -e` (homelab user): `15 3 * * * /srv/homelab/maktab/offsite-gsap.sh >> /srv/homelab/maktab/offsite-gsap.log 2>&1`
   (03:15 Karachi if the host's clock is on PKT; after the 02:30 backup).
4. Set `BACKUP_RCLONE_REMOTE=r2:maktab-backups/homelab-gsap` in `gsap/.env` and recreate.
5. **Verify** (run it once by hand now, then the next morning):

       /srv/homelab/maktab/offsite-gsap.sh && cat /srv/homelab/maktab/gsap/data/backups/OFFSITE_OK
       rclone lsl r2:maktab-backups/homelab-gsap/daily | sort -k2,3 | tail -3

   The newest remote file is today's; the next nightly run shows **OK** in Settings → Backup and
   the `backup_offsite` alarm clears.

The GitHub nightly-backup workflow exports the Cloudflare D1 only; it does not see the homelab.

### 7.3 Backup now and restore

Backup now (e.g. by hand before something risky; an upgrade does it by itself): an unencrypted,
consistent copy with SQLite's online backup, while the app runs (move it somewhere safe or delete
it afterwards; it is the whole school):

    docker exec maktab-gsap node -e "const D=require('/app/node_modules/better-sqlite3');new D('/data/maktab.sqlite').backup('/data/tmp/manual.sqlite').then(()=>console.log('ok'))"

**Restore** (the school's data goes back to the backup's night; needs `age` and `sqlite3` on the
host and the trustees' key file; the backup files belong to the homelab user, so no sudo):

    cd /srv/homelab/maktab
    age -d -i maktab-backup-key.txt gsap/data/backups/daily/<day>.sqlite.gz.age | gunzip > restored.sqlite
    sqlite3 restored.sqlite 'PRAGMA integrity_check; SELECT count(*) FROM receipt;'
    docker compose stop
    mv gsap/data/maktab.sqlite gsap/data/maktab.sqlite.before-restore
    rm -f gsap/data/maktab.sqlite-wal gsap/data/maktab.sqlite-shm
    install -m 0600 restored.sqlite gsap/data/maktab.sqlite && shred -u restored.sqlite
    docker compose up -d && docker logs maktab-gsap   # migrations newer than the backup re-apply; db:verify passes

(From the off-site copy: `rclone copy r2:maktab-backups/homelab-gsap/daily/<day>.sqlite.gz.age .` first.)
Keep the same `PARENT_LINK_SECRET` (else run "Revoke all parent links" afterwards, docs/restore.md).
Photos are not in the database backup: copy `data/files/` alongside (they are content, not secrets,
but private). Practise once a term like docs/restore.md section B: restore the newest file into a
scratch folder, start a second instance on it (`INSTANCE=restoretest`, no tunnel route), compare
receipt counts and sums, record the drill in Settings → Backup, then remove it.

Moving to D1 and back: the database carries `d1_migrations` exactly as wrangler writes it, so
`sqlite3 maktab.sqlite .dump > dump.sql` imports into a fresh D1 with `wrangler d1 execute … --file`
(docs/restore.md B), and a `wrangler d1 export` dump loads into a fresh SQLite file with
`sqlite3 maktab.sqlite < dump.sql`; later migrations continue from the recorded names either way.

## 8. Logs and health

- `docker logs -f maktab-gsap`: start-up (migrations, trigger/view counts, missing settings), one
  JSON line per cron tick (`{"cron":…}`, `{"daily":…}`), one per backup (`{"backup":…}`), errors as
  one line each. Rotated by Docker: 5 × 10 MB.
- `docker inspect -f '{{.State.Health.Status}}' maktab-gsap`: the image's `HEALTHCHECK` calls
  `/healthz` every 30 s; `docker ps` shows `(healthy)`.
- `docker stop` sends SIGTERM through `tini`: the server stops accepting connections, lets requests
  in flight and the running job finish, checkpoints the WAL and closes the database (grace 30 s).
- The image has no npm, npx, corepack or yarn; base images are pinned by digest (Dockerfile).
- Smoke test of an image (any machine with Docker): `scripts/selfhost-smoke.sh` builds it, runs it
  with no network and a temp data folder, checks `/healthz`, `/api/identity`, `/`, `/__scheduled`,
  a clean stop, an idempotent restart, the DEMO_MODE and missing-AGE_RECIPIENT refusals and that no
  package manager is left in the image.

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
| Database | `DATA_DIR/maktab.sqlite`, better-sqlite3, one connection, WAL, `busy_timeout` 5 s, foreign keys on | D1 |
| Migrations | applied on every start from `packages/db/migrations`, recorded in `d1_migrations` exactly as `wrangler d1 migrations apply` does; then the `db:verify` trigger/view check, and the server **refuses to start** on any difference | `wrangler d1 migrations apply` by hand |
| Files (photos, logo, expense proofs) | `DATA_DIR/files/` | R2 `FILES` |
| Backups | built-in nightly job at 02:30 Karachi → `DATA_DIR/backups/` | GitHub Actions → R2 + B2 |
| Cron (fees, fines, daily alarms) | in-process every 30 min (first run 60 s after start) | Workers cron `*/30` |
| Web app | `apps/web/dist`, served with the same rules as Workers Static Assets (below) | `[assets]` |

Static files behave as on Workers: `/api/*`, `/p`, `/p/*` go to the app first (`run_worker_first`,
a test keeps the list equal to `wrangler.toml`); every other path is a file from `apps/web/dist` with
the rules of `apps/web/public/_headers` applied (the file is parsed at start, never copied); content-
hashed files under `/assets/` are cached for a year (`immutable`), everything else revalidates; an
unknown path answers `index.html` to a browser navigation and a JSON 404 to anything else; no
directory listing, no dot-files, `_headers` itself is never served. `/__scheduled` answers 404 (there
is no HTTP cron trigger). `GET /healthz` (self-hosted only) answers
`{"status":"ok","version":"…","db":"ok"}`, or 503 when the database cannot answer.

Client IP: the tunnel sets `CF-Connecting-IP`. With `TRUST_PROXY=1` (default) the server takes the
client IP from `CF-Connecting-IP`, else the first `X-Forwarded-For` entry, else the socket, and
passes the app exactly one value. It is used for the per-IP rate limits, the parent-page access log
and Turnstile's `remoteip`, never for anything else: cookies, CSRF and redirects all follow
`APP_ORIGIN`. Set `TRUST_PROXY=0` if anything other than cloudflared can reach the container.

## 2. Prerequisites

- Linux x86_64 (or arm64), Docker 24+ with Compose v2+ (the homelab: Ubuntu 24.04, Docker 29,
  Compose v5), about 1 GB of disk for the image build plus the school's data.
- The external Docker network `homelab` (`docker network create homelab` if it does not exist) with
  the remote-managed `cloudflared` container on it.
- Outbound internet from the container: Google sign-in (token exchange, JWKS) and, if enabled,
  Turnstile's siteverify.
- The backup public key (`age1…`, docs/backup.md §1) and, for a restore, the private key with the
  trustees.

## 3. Install (first run)

Layout on the server (one stack folder, one sub-folder per school):

    /srv/homelab/maktab/
      docker-compose.yml        from deploy/selfhost/ (install.sh copies it)
      src/                      the repository checkout the image is built from
      gsap/.env                 the school's settings and secrets (0600)
      gsap/data/                maktab.sqlite (+ -wal, -shm), files/, backups/, tmp/

Steps:

    sudo git clone https://github.com/faysalmehmood/maktab.git /srv/homelab/maktab/src
    sudo /srv/homelab/maktab/src/deploy/selfhost/install.sh gsap

`install.sh` is idempotent: it copies the compose file (keeping a `.bak` of a changed one), creates
`gsap/` (0700) and `gsap/data/` (owned by uid 1000, the image's `node` user), creates `gsap/.env`
from `deploy/selfhost/.env.example` **only if it does not exist** (with fresh random
`SESSION_SECRET` and `PARENT_LINK_SECRET`, never printed), builds the image, starts it, and prints
`/healthz` from inside the container. Then fill the rest of the settings and recreate:

    sudo nano /srv/homelab/maktab/gsap/.env      # APP_ORIGIN, OWNER_EMAIL, GOOGLE_*, AGE_RECIPIENT
    cd /srv/homelab/maktab && sudo docker compose up -d --force-recreate
    sudo docker logs maktab-gsap                 # "database ok: … 97 triggers (expected 97) …"

The compose project and container are `maktab-${INSTANCE}` (default `gsap`). Another school is
another folder: `sudo …/install.sh <name>`, then `INSTANCE=<name> docker compose …` for that school.
The container publishes **no host port**; it is reachable only on the `homelab` network.

By hand instead of `install.sh` (any machine with Docker):

    docker build -t maktab:local --build-arg MAKTAB_VERSION=$(git describe --always) .
    docker run -d --name maktab-gsap --network homelab --env-file gsap/.env \
      -v "$PWD/gsap/data:/data" --read-only --tmpfs /tmp --restart unless-stopped maktab:local

## 4. Cloudflare Tunnel and Google

1. Zero Trust → Networks → Tunnels → the homelab tunnel → **Public hostnames** → Add:
   subdomain `gsap`, domain `conceptlix.com` (so **gsap.conceptlix.com**), service
   **`http://maktab-gsap:8787`**. `gsap.conceptlix.com` is a new name, so no Worker custom domain
   needs releasing; the Worker env `gsap` keeps `maktab-gsap.conceptlix.com` as its fallback.
2. Google Cloud console → the OAuth client → Authorised redirect URIs → add
   **`https://gsap.conceptlix.com/api/auth/google/callback`** (keep the old ones). Put the same
   client's `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `gsap/.env`.
3. WAF: the rate-limit rule "maktab public surfaces" (docs/deploy.md §7) must list
   `gsap.conceptlix.com` in its host expression (tunnel traffic passes the zone's WAF like any other).
   If Turnstile is used, add `gsap.conceptlix.com` to the widget's hostnames and set
   `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` in `gsap/.env`.
4. Check from outside: `curl -s https://gsap.conceptlix.com/api/identity` answers `{"school":null}`
   on an empty installation; `curl -sI https://gsap.conceptlix.com/ | grep -i content-security`
   shows the CSP. The owner (`OWNER_EMAIL`) signs in once and the setup wizard starts.

## 5. Environment (`/srv/homelab/maktab/<instance>/.env`)

| Variable | Required | Meaning |
|---|---|---|
| `APP_ORIGIN` | yes | public origin, `https://gsap.conceptlix.com` (https only; http only for localhost) |
| `SESSION_SECRET` | yes | ≥ 32 random chars; the server refuses to start without it. Changing it signs everyone out |
| `PARENT_LINK_SECRET` | yes in practice | ≥ 32 chars; parent links stop working without it. A restore needs the same value (docs/restore.md) |
| `OWNER_EMAIL` | first run | the only Google account that may claim the empty installation |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for sign-in | the OAuth client (step 4.2) |
| `AGE_RECIPIENT` | strongly | the public `age1…` key for the nightly backup (same as the GitHub secret). Empty = backups stored **unencrypted**, with a warning in the log |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | no | both or neither (docs/deploy.md §8) |
| `BACKUP_REPORT_TOKEN` | no | ≥ 32 chars; only for an external job posting to `POST /api/backup/runs`. The built-in backup records itself |
| `BACKUP_RCLONE_REMOTE` | later | reserved for the off-site copy (not implemented yet; see §7) |
| `TRUST_PROXY` | no | `1` (default) behind the tunnel; `0` = socket address only |
| `DEMO_MODE` | never | the server refuses to start if it is set to anything |
| `DATA_DIR`, `PORT`, `HOST` | no | set by the image/compose: `/data`, `8787`, `0.0.0.0` |
| `MAKTAB_SCHEDULER` | no | `0` turns the cron and the nightly backup off (tests only) |

Secrets are never logged; the start-up log names only missing settings.

## 6. Upgrade

    cd /srv/homelab/maktab
    sudo git -C src pull
    sudo src/deploy/selfhost/install.sh gsap      # rebuilds, recreates, prints /healthz

Migrations run on start (only the new ones; a failing migration is rolled back whole and the server
stops with the error, the old database untouched). Before a release with new migrations, take a
backup first (§7, "Backup now"). `docker compose up -d` without a rebuild keeps the old image. When
CI publishes images (later), set `MAKTAB_IMAGE=ghcr.io/faysalmehmood/maktab:<tag>` in
`/srv/homelab/maktab/.env` and use `docker compose pull && docker compose up -d` instead.

## 7. Backups and restore

Nightly at 02:30 Asia/Karachi (and on the first cron tick after a missed 02:30, at most once a day):

1. SQLite's online backup copies the live database to `data/tmp/` (consistent; the app keeps serving);
2. gzip, then age-encrypted to `AGE_RECIPIENT`;
3. written atomically to `data/backups/daily/<YYYY-MM-DD>.sqlite.gz.age` with a `.sha256`
   (`sha256sum` format); on the 1st also `data/backups/monthly/`;
4. `daily/` older than 95 days is deleted; `monthly/` is kept;
5. the run is recorded like a GitHub report, so Settings → Backup shows **Last nightly backup** and
   lists the newest files, and the backup_stale alarm works. Status is **partial**: the only copy is
   on the same machine. The plain snapshot is deleted in every case. (Without `AGE_RECIPIENT` the
   files are `….sqlite.gz`, and Settings → Backup, which lists only `.age` files, does not show them.)

**Off-site copy: not built yet.** Until it is, copy `data/backups/` off the machine (another disk,
or `rclone copy /srv/homelab/maktab/gsap/data/backups remote:maktab-gsap-backups`) from the host's
cron. `BACKUP_RCLONE_REMOTE` is reserved for doing this from the container later. The GitHub
nightly-backup workflow exports the Cloudflare D1 only; it does not see the homelab.

Backup now (e.g. before an upgrade): an unencrypted, consistent copy with SQLite's online backup,
while the app runs (move it somewhere safe or delete it afterwards; it is the whole school):

    docker exec maktab-gsap node -e "const D=require('/app/node_modules/better-sqlite3');new D('/data/maktab.sqlite').backup('/data/tmp/manual.sqlite').then(()=>console.log('ok'))"

**Restore** (the school's data goes back to the backup's night; needs `apt install age sqlite3` and
the trustees' key file):

    cd /srv/homelab/maktab
    sudo age -d -i maktab-backup-key.txt gsap/data/backups/daily/<day>.sqlite.gz.age | gunzip > restored.sqlite
    sqlite3 restored.sqlite 'PRAGMA integrity_check; SELECT count(*) FROM receipt;'
    docker compose stop
    sudo mv gsap/data/maktab.sqlite gsap/data/maktab.sqlite.before-restore
    sudo rm -f gsap/data/maktab.sqlite-wal gsap/data/maktab.sqlite-shm
    sudo install -o 1000 -g 1000 -m 0600 restored.sqlite gsap/data/maktab.sqlite
    docker compose up -d && docker logs maktab-gsap   # migrations newer than the backup re-apply; db:verify passes
    shred -u restored.sqlite

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
  JSON line per cron tick (`{"cron":…}`, `{"daily":…}`), one per backup (`{"backup":…}`), errors.
  Rotated by Docker: 5 × 10 MB.
- `docker inspect -f '{{.State.Health.Status}}' maktab-gsap`: the image's `HEALTHCHECK` calls
  `/healthz` every 30 s; `docker ps` shows `(healthy)`.
- `docker stop` sends SIGTERM through `tini`: the server stops accepting requests, lets the running
  job finish, checkpoints the WAL and closes the database (grace 30 s).
- Smoke test of an image (any machine with Docker): `scripts/selfhost-smoke.sh` builds it, runs it
  with no network and a temp data folder, checks `/healthz`, `/api/identity`, `/`, `/__scheduled`,
  a clean stop, an idempotent restart and the DEMO_MODE refusal.

# Deploy runbook

Production deploys are a human decision (PLAN §15: ask first). This is the order, every time.

## 1. Before

- `main` is green: `npm run typecheck && npm run lint && npm test && npm run build`, and
  `npx tsx packages/db/scripts/sync-custom-sql.ts --check` (no unrecorded `packages/db/sql` change,
  no edited migration).
- Take a backup you can restore (docs/restore.md §B). Migrations are forward-only; the way back is
  Time Travel or the backup, never a down-migration.
- Never deploy during school hours: a migration that rebuilds a table (0004, 0008, 0010) holds the
  database for its duration.

## 2. Migrate

```sh
cd apps/api
npx wrangler d1 migrations list DB --remote --env production    # what will run
npx wrangler d1 migrations apply DB --remote --env production
```

Migrations that rebuild a money table (0008, 0010) drop the ledger views and the triggers that read
that table, and the custom migration right after them (0009, 0011) re-creates them. Both are applied
by the same `apply`; if it stops between the two, run `apply` again before anything else.

## 3. Verify the rules are all there

```sh
npm run db:verify -- --remote --env production    # from the repo root
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
openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET --env production
openssl rand -base64 48 | npx wrangler secret put PARENT_LINK_SECRET --env production
```

`PARENT_LINK_SECRET` (M5) keys everything about parent links: the link tokens (HMAC of a per-link
salt), the gate tokens, PIN hashes and the access log's IP hashes. Without it (or shorter than 32
characters) the Worker logs a config warning and every parent-link route answers 503 `misconfigured`.
Keep a copy with the backup trustees: a restore needs the **same** value (docs/restore.md).

Rotating it is how every parent link is revoked at once (a leak, a departing admin): put a new value,
then, signed in as the owner, `POST /api/parent-links/rotate-all` (Settings → Messages → "Revoke all
parent links"). Old links stop being recomputable, so the next "Open WhatsApp" for a guardian makes a
fresh one; guardians need the new message. Rotation does not touch staff sessions.

## 5. Deploy the Worker

```sh
npm run build
cd apps/api && npx wrangler deploy --env production
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

## First deploy notes (2026-10-10, see docs/deploy-log.md)

- Production host is `maktab.conceptlix.com`. wrangler created the DNS record and certificate itself
  (custom domain), as the zone is on the same Cloudflare account; the local resolver may lag a few
  minutes (`curl --resolve` or `dig @1.1.1.1` works sooner).
- R2 must be enabled in the dashboard (card on file) before `wrangler r2 bucket create`; until then
  the production `FILES` binding stays commented out in `apps/api/wrangler.toml` and photo upload
  answers 501. `db:verify` prints a harmless "add r2_buckets to env.production" warning meanwhile.
- `GET /api/auth/google/start` returns 500 `misconfigured` until GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
  are set; that is expected.
- `wrangler tail` needs several seconds to attach; wait ~15 s before generating traffic.

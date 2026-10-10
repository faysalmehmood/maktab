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

## 4. Deploy the Worker

```sh
npm run build
cd apps/api && npx wrangler deploy --env production
```

## 5. After

- Sign in, open the fee counter for one family, the cash sessions list, `GET /api/fees/runs?period=<this month>`
  (`failing` must be empty; a failing group is retried by the cron every 30 minutes and shows its
  error code here).
- `SELECT * FROM ledger_consistency` is empty.

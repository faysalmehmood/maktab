# Contributing

Thanks for helping. Maktab is small on purpose; please keep it that way.

## Setup

- Node 22+ (see `.nvmrc`).
- `npm ci --ignore-scripts` (what CI uses) or `npm install`.
- `cp apps/api/.dev.vars.example apps/api/.dev.vars`
- `npm run db:migrate:local`
- `npm run db:seed` (optional sample data)
- `npm run dev` starts web (:5173) and API (:8787); `npm run dev -w @maktab/api` starts the API only.

wrangler reads `.dev.vars` only at start: restart it after editing the file.

curl `POST`/`PUT` to `/api/*` must send `Origin: http://localhost:5173`, or the CSRF check against
`APP_ORIGIN` refuses them:

```sh
curl -X POST localhost:8787/api/<route> -H "Origin: http://localhost:5173" \
  -H "Content-Type: application/json" -H "Cookie: $(npm run -s dev:session -w @maktab/api -- owner@example.com)" \
  -d '{}'
```

- Read [docs/PLAN.md](docs/PLAN.md) first. Larger changes start as an issue or an ADR in `docs/ADR/`.
- Before a pull request: `npm run typecheck && npm run lint && npm test && npm run build`.
- Every new API route goes through `defineRoute(... requires(resource, action) ...)` and gets a row in
  the snapshot in `apps/api/test/permissions.test.ts`. Undeclared routes are refused at runtime.
- Money is integer paisa, money rows are never updated or deleted, and balances are derived.
- Schema changes: edit `packages/db/src/schema`, run `npm run db:generate`, commit the migration.
  Triggers, views and partial indexes live in `packages/db/sql/`; editing one emits a new numbered
  migration (never edit a committed migration; CI checks `migrations/custom_sql.json`, ADR 0002).
- Every user-facing string needs both `en` and `ur` (`packages/shared/src/i18n.ts`; the type
  checker enforces matching keys). Numbers stay in Latin digits.
- Comments explain why, not what. No `any`.
- Multi-row writes are one `atomic()` batch (`apps/api/src/lib/tx.ts`), with ids minted before the
  call and an `audit` row in the same batch. Request bodies are validated with the shared Zod
  schemas in `packages/shared/src/academic.ts`.

## Driving the API locally without Google

There is no dev-login route in the Worker, by design. Instead, mint a session cookie straight into
the local D1 (dev only; it refuses when `NODE_ENV=production`, and unless `SESSION_SECRET` in
`apps/api/.dev.vars` is the example value or `ALLOW_DEV_SESSION=1`):

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars              # once; the example secret enables dev sessions
npm run db:migrate:local
npm run dev -w @maktab/api                                    # wrangler dev --local on :8787
npm run -s dev:session -w @maktab/api -- owner@example.com    # prints maktab_sid=…
curl -H "Cookie: $(npm run -s dev:session -w @maktab/api -- owner@example.com)" localhost:8787/api/me
npm run smoke:m1 -w @maktab/api                               # milestone 1 end-to-end, PASS/FAIL per step
```

wrangler reads `.dev.vars` only at start: restart `npm run dev` after editing it.

On an empty database the email is bootstrapped as the owner (what `OWNER_EMAIL` + a first Google
sign-in would do); otherwise it must be an existing **active** user. Someone invited from the
wizard or Settings stays `invited` until their first Google sign-in; to drive the API as them
locally, add `--activate` (dev only, same guards; disabled users are never re-enabled):

```sh
npm run -s dev:session -w @maktab/api -- teacher@example.com --activate
```

Ports: `PORT` (web, default 5173) and `API_PORT` (API, default 8787) move the Vite server, its
`/api` proxy, the Worker's `APP_ORIGIN` and the smoke script together, e.g.
`PORT=5180 API_PORT=8790 npm run dev`, then `PORT=5180 API_PORT=8790 npm run smoke:m1 -w @maktab/api`. The cookie is named `maktab_sid`
on `http://localhost` (`__Host-maktab_sid` needs an https origin). If wrangler runs with
`--persist-to <dir>`, pass the same dir as `D1_PERSIST_TO=<dir>` to both scripts.

By contributing you agree your work is licensed under AGPL-3.0. This project follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

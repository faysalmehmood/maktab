# Contributing

Thanks for helping. Maktab is small on purpose; please keep it that way.

## Setup

- Node 22+ (see `.nvmrc`).
- `npm ci --ignore-scripts` (what CI uses) or `npm install`.
- `cp apps/api/.dev.vars.example apps/api/.dev.vars`
- `npm run db:migrate:local`
- `npm run db:seed` (optional sample data; one transaction, so a failure leaves nothing behind).
  Running it again is a no-op ("… already has a school; not seeding again"): it never reuses or
  tops up an existing database — start from a fresh file to re-seed.
  `SEED_OWNER_EMAIL=you@gmail.com` makes you the owner; an address that is already a user (you signed
  in first) or is the demo teacher's is reused, not an error. `SEED_DB=<path to a .sqlite file>`
  seeds another file: the seed does **not** read `D1_PERSIST_TO`, so with `--persist-to <dir>` point
  `SEED_DB` at the `.sqlite` under `<dir>/v3/d1/miniflare-D1DatabaseObject/`.
- Poking the database with the `sqlite3` CLI: run `PRAGMA foreign_keys = ON;` first (D1 always
  enforces them; the CLI does not), or a delete can leave orphans that `PRAGMA foreign_key_check`
  then reports.
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
npm run smoke:m2 -w @maktab/api                               # milestone 2 (attendance sync, correction, queue)
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
`--persist-to <dir>`, set `D1_PERSIST_TO=<dir>` instead: `npm run dev -w @maktab/api`,
`npm run db:migrate:local` and the dev-session script all read it and pass `--persist-to <dir>`
themselves, e.g. `D1_PERSIST_TO=.wrangler/alt npm run db:migrate:local` then
`D1_PERSIST_TO=.wrangler/alt npm run dev -w @maktab/api`. (A flag does not work for the migration:
`npm run db:migrate:local -- --persist-to <dir>` loses it in the root script's second npm layer.)

Driving the API by hand:

- Every id is a ULID (26 Crockford base-32 characters, e.g. `01JABCDEFGHJKMNPQRSTVWXYZ0`) and
  bodies are validated against it, so made-up ids such as `G1` are refused with 400 `invalid`.
  Clients mint ids for anything they create offline (`client_id` of a register).
- A sibling's admission (`POST /api/admissions`) sends `family_id` of the existing family instead
  of a `family` object and `guardians` (see `setup()` in `apps/api/test/attendance.test.ts`).
- `POST /api/attendance/sync` takes at most 3 registers and 200 marks per request, and refuses a
  `taken_at` more than 5 minutes ahead of the server (`clock_skew`).
- `POST /api/admissions` with a new `family` needs at least one entry in `guardians` (400
  `guardian_required`). `fees: { charge: false }` admits without billing the first period
  (`pro_rata`, `sibling_concession` are the other two options; see `admissionFeesSchema`).
- Business date at the fee counter: today (Asia/Karachi). Only an owner/admin may send yesterday,
  with `backdate_reason` (audited); anything else is 400 `bad_business_date`. Cash always lands in
  today's drawer session; non-cash (`bank`, `jazzcash`, `easypaisa`, `cheque`, `other`) needs an
  account (named, or the first matching one; else 400 `account_required`) and opens no session.
- Counter search (`GET /api/fees/search?q=`) matches student, family and guardian names (substring),
  an exact admission number, or 6+ digits of a guardian phone/WhatsApp (a leading 0 or +92 is
  normalised); at most 20 families.
- A closed drawer: once a collector's session for today is closed, a cash receipt is 409
  `session_closed` (the counter explains it; nothing is written and the attempt is not retried).
  An owner/admin reopens it with a reason (`POST /api/cash/sessions/:id/reopen`); non-cash is not
  affected.
- The counter's idempotency key is minted once per attempt and kept, with the exact request body,
  until success, `stale_dues`, `idempotency_conflict`, a definite 4xx refusal or "Start over"
  (session storage, so a reload keeps it). On reconnect the pending attempt is replayed first.
- Concessions take effect from the first month that starts on or after `valid_from` (a mid-month
  date starts next month). Months already billed are not changed until regenerated: the dialog
  offers "Regenerate billed months from …" (one `POST /api/fees/regenerate` per month).
- `GET /api/fees/unbilled?period=` lists active enrolments with no monthly fee root that month (in
  groups with a monthly rate); the billing screen bills each with `POST /api/fees/regenerate`.

## The fee cron locally

The Worker's `scheduled` handler (monthly generation, then late fines) runs every 30 minutes in
production. Locally, start the API with `--test-scheduled` and trigger it by hand:

```sh
npm run dev -w @maktab/api -- --test-scheduled     # wrangler dev --local, plus /__scheduled
curl "localhost:8787/__scheduled?cron=*/30+*+*+*+*"   # one tick; the report is in the wrangler log
npm run smoke:m3 -w @maktab/api                        # milestone 3 end-to-end, cron step included
```

Each tick bills at most a few group chunks, resuming from `billing_chunk`. It only picks up groups
that have **no finished chunk** for the month: a student enrolled in a group after its chunk
completed is not billed by the cron (or by "Generate", which skips finished groups) — bill them with
`POST /api/fees/regenerate {student_id, period}` (admission does this itself unless
`fees.charge` is false). A group whose chunk fails is logged (`billing_chunk.status = 'failed'`,
`error_code`) and skipped for that tick. Healthy groups always go first and failing groups last, and
a failure does not use the tick's chunk budget (failed attempts are capped separately). A failing
group backs off: after its n-th failure in a row it waits 2^n ticks (1 h, 2 h, 4 h, … at most 24 h,
`billing_chunk.fail_streak` / `retry_after`); "Generate" ignores the backoff. `GET
/api/fees/runs?period=YYYY-MM` lists it under `failing`; after three failures in a row it is
`attention_required` and counted in the dashboard's `billing_alerts`.

Fines run every tick for everyone else: each overdue tuition root of **any** period (its due date —
the fine rule's grace day — has passed, money still due), oldest first, 200 per chunk, one fine per
root (`charge_fine_once`), filed under the root's own period. A month the cron missed is still
fined. `POST /api/fees/fines/apply` without `period` does the same; with `period` it fines that
month only.

By contributing you agree your work is licensed under AGPL-3.0. This project follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

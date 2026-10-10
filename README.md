# Maktab · مکتب

Free, open-source school and academy management for Pakistani community schools: students and
families, attendance that works offline, batch-style fees with an append-only ledger, WhatsApp send
queue, Urdu + English (RTL), and **$0/month** hosting on Cloudflare's free tier.

**Status: milestone 0** — a runnable, tested skeleton. Schema, ledger triggers, Google sign-in,
permission matrix, bilingual PWA shell and the backup workflow exist; no business screens yet.
The full design lives in [docs/PLAN.md](docs/PLAN.md).

Licence: [AGPL-3.0](LICENSE).

## Quick start

Requires Node ≥ 22 (`nvm use`). No Cloudflare account is needed for local development.

```sh
npm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then fill GOOGLE_CLIENT_ID / SECRET
npm run build                                       # the Worker serves apps/web/dist
npm run db:migrate:local                            # local D1 (SQLite) via wrangler
SEED_OWNER_EMAIL=you@gmail.com npm run db:seed      # optional demo data; you become owner
npm run dev                                         # web on :5173, API on :8787 (proxied)
```

Open http://localhost:5173. Sign-in needs a Google OAuth client (type "Web application") with the
redirect URI `http://localhost:5173/api/auth/google/callback`. On an empty database the first
person to sign in becomes the owner; after that, only invited emails can sign in.

Checks: `npm run typecheck && npm run lint && npm test && npm run build`.

## Architecture

```
 phone / laptop browser (PWA, React, Urdu RTL)
   │  IndexedDB outbox (attendance, offline)
   ▼
 Cloudflare Worker  ── static assets (apps/web/dist)
   │  Hono  /api/*  → CSRF + default-deny route table → requires(resource, action)
   │                → row scope (scopeToGroups) → Drizzle
   ▼
 D1 (SQLite)  append-only money tables, RAISE(ABORT) triggers, derived balances (views)
 R2           photos / payment proofs (later)
   ▲
 GitHub Actions nightly: d1 export → gzip → age → R2 + Backblaze B2   (docs/restore.md)
```

Same code runs on Node with a SQLite file (`better-sqlite3`), which is the escape hatch if the free
tier changes (PLAN §8).

| Path | What |
|---|---|
| `apps/api` | Hono Worker: auth (Google OAuth code flow, HMAC session), permission matrix, routes |
| `apps/web` | Vite + React 19 + Tailwind 4 + shadcn/ui PWA; i18next `en`/`ur` |
| `packages/db` | Drizzle schema (all PLAN §5 tables), `sql/` triggers/views/partial indexes, migrations, seed |
| `packages/shared` | Zod schemas, roles, permission types, money (`formatPKR`), i18n dictionaries |
| `docs/` | PLAN, ADRs, restore runbook |

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Vite dev server + `wrangler dev --local`, together |
| `npm run build` | Builds the web app, then bundles the Worker (`wrangler deploy --dry-run`) |
| `npm test` | Vitest in every workspace |
| `npm run lint` / `format` | Biome check / fix |
| `npm run typecheck` | `tsc` in every workspace |
| `npm run db:generate` | Drizzle migration from schema changes + rebuilds the custom SQL migration from `packages/db/sql` |
| `npm run db:migrate:local` | Applies migrations to the local D1 database |
| `npm run db:seed` | Dev-only demo data into the local D1 database |

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

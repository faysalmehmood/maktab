# ADR 0001 — Stack

Date: 2026-10-10 · Status: accepted · Source: PLAN §2 (decision log) and §8

## Context

Pakistani community schools: 100–500 students (design for 1,000), staff on low-end Android phones,
patchy internet, Urdu + English, **$0/month**, and data that survives any one machine dying. One
school per installation. Built and maintained by volunteers.

## Decision

TypeScript end to end.

| Layer | Choice |
|---|---|
| Frontend | Vite + React + Tailwind + shadcn/ui, installable PWA, i18next with Urdu RTL |
| API | Hono on Cloudflare Workers; Zod schemas shared with the frontend |
| Data | Cloudflare D1 (SQLite) via Drizzle ORM; better-sqlite3 for local/tests and self-hosting |
| Files | R2 (photos, payment proofs); PDFs rendered on demand by the browser |
| Auth | Google OAuth code flow verified with WebCrypto, HMAC session cookie, invite-only |
| Backups | D1 Time Travel + nightly GitHub Actions export → age → R2 and Backblaze B2 |

## Why

- **Cloudflare is the only "nothing expires" free stack** found (Supabase pauses, Render deletes
  free Postgres, Fly/PlanetScale have no free tier). D1 batches are transactions and triggers work
  on D1 — verified on the real account (PLAN §12 exp1).
- **Portability is a requirement.** Hono runs on Node/Bun as well as Workers, and Drizzle targets
  both D1 and a SQLite file, so a `docker compose` homelab deployment remains a small step.
- **One language** for UI, API and shared validation keeps a volunteer project approachable.
- Auth fits the 10 ms CPU budget: RS256 verify ≈ 0–1 ms CPU measured remotely (exp2).

## Alternatives considered

- **Go** — would be the first choice for an always-on self-hosted server, but Go cannot target
  Cloudflare Workers, which is where the $0 hosting is.
- **Rust (WASM on Workers)** — possible, but adds a second toolchain and slower iteration for no
  measurable gain at this scale; the CPU-heavy parts (crypto) are already native WebCrypto.
- Keeping the API layer thin preserves the option of a Go port later if the hosting model changes.

## Consequences

- No interactive transactions (D1): every user action is one `batch()`; invariants live in
  `RAISE(ABORT)` triggers; client-generated ids make retries safe.
- Heavy jobs (exports, Sheets copy) run in GitHub Actions, not Worker cron (10 ms CPU).
- Transient D1 error 7500 during exports must be tolerated (one retry).

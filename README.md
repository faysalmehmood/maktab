<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/maktab-logo-dark.png">
    <img src="brand/maktab-logo.png" alt="Maktab · مکتب" width="480">
  </picture>
</p>

**Try the demo:** https://maktab.conceptlix.com (made-up school, no account needed; docs/demo.md)

<p align="center"><b>Free, open-source school and academy management for Pakistani community schools.</b><br>
Maktab · مکتب</p>

<p align="center">
  <img alt="Status: pre-pilot" src="https://img.shields.io/badge/status-pre--pilot-orange">
  <img alt="Milestones 0–4 done" src="https://img.shields.io/badge/milestones-0%E2%80%934%20done-0f766e">
  <a href="https://github.com/faysalmehmood/maktab/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/faysalmehmood/maktab/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
</p>

> **Not ready for production yet.** Maktab has not yet run in a real school. Do not use it for
> real students' records or money until the pilot milestone (M7) is done.

## What Maktab does

| Module | What it does |
|---|---|
| Students & families | Admit students, keep guardians and siblings together as one family, import from CSV. |
| Attendance | Teachers mark absentees on a phone in seconds; it works without internet and syncs later. |
| Fees | Monthly fees, concessions, sponsors, late fines and numbered receipts at a family fee counter. |
| Money out & reports | Expenses, salaries and advances, cash closing, income vs expense, printable and CSV reports. |
| Messaging *(planned, M5)* | Urdu/English reminders sent from the school's own WhatsApp through a send-queue; a private page per parent. |
| Settings & backup *(planned, M6)* | Templates, audit log viewer, "download everything", and nightly backups to three places. |

**Built for** community schools and coaching academies in Pakistan with 100–1,000 students: staff
on low-end Android phones, patchy internet, an Urdu and English interface (right-to-left Urdu,
English digits), and no budget for software or hosting. One installation runs one school.

## Why it's different

- **Money you can trust.** The fee ledger is append-only: nothing is edited or deleted, mistakes are
  reversed with a new entry, receipts are numbered without gaps, and balances are always computed.
- **Attendance works offline.** Registers are saved on the phone and sync when the connection returns.
- **One model for schools and academies.** Classes, sections, batches and short courses are all
  "groups", so a student can be in Class 5-B and an evening English course at the same time.
- **Free to run.** It fits Cloudflare's free tier ($0/month), with three independent backups:
  Cloudflare's 7-day point-in-time restore, an encrypted nightly copy in two clouds, and a Google
  Sheet the school owns.
- **Open source under AGPL-3.0.** It stays free; anyone may host it for their own school.

## Screenshots

Not yet published; see [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md) for the planned list.

## Roadmap

| Milestone | Scope | Status |
|---|---|---|
| M0 Scaffold | Schema and ledger triggers, sign-in and permissions, bilingual app shell, CI, backup workflow | Done |
| M1 Foundation | Setup wizard, staff invites and roles, students/families, admissions, CSV import | Done |
| M2 Attendance | Daily register, offline sync, corrections with reason, absentee list | Done |
| M3 Fees | Fee counter, receipts, concessions, sponsors, fines, defaulters, cash closing | Done |
| M4 Money out & reports | Expenses, payslips and advances, income vs expense, dashboard, report pack | Done |
| M5 Messaging | Send-queue with Urdu/English templates, parent page | Next |
| M6 Settings & backup | Audit viewer, recycle bin, "download everything", nightly backups live | Planned |
| M7 Hardening & pilot | Security pass, Urdu review, Android checks, first real school month | Planned |

Full plan, decisions and review findings: [docs/PLAN.md](docs/PLAN.md) (§15).

## Quick start (developers)

Requires Node 22+ (`nvm use`). No Cloudflare account is needed for local development.

```sh
npm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # fill GOOGLE_CLIENT_ID / SECRET and OWNER_EMAIL
npm run db:migrate:local                            # local D1 (SQLite) via wrangler
SEED_OWNER_EMAIL=you@example.com npm run db:seed    # optional demo data; that address becomes owner
npm run dev                                         # web on :5173, API on :8787 (proxied)
```

Open http://localhost:5173. Sign-in needs a Google OAuth client (type "Web application") with the
redirect URI `http://localhost:5173/api/auth/google/callback`. On an empty database only
`OWNER_EMAIL` can sign in; after that, only invited emails. To use other ports, set both:
`PORT=5180 API_PORT=8790 npm run dev`. To drive the API without Google, see
[CONTRIBUTING.md](CONTRIBUTING.md#driving-the-api-locally-without-google).

Checks before a pull request:

```sh
npm run typecheck && npm run lint && npm test && npm run build
npx tsx packages/db/scripts/sync-custom-sql.ts --check
```

More: [CONTRIBUTING.md](CONTRIBUTING.md) (setup, rules, local cron) ·
[docs/deploy.md](docs/deploy.md) (deploying to Cloudflare) · [docs/restore.md](docs/restore.md)
(restoring a backup).

## Architecture

A TypeScript monorepo. The browser app is an installable PWA (React, Tailwind, Urdu RTL); the API is
Hono on a Cloudflare Worker, which also serves the app; data is in D1 (SQLite), where database
triggers enforce the money rules. The same code runs on Node with a SQLite file, as the escape hatch
if the free tier changes ([ADR 0001](docs/ADR/0001-stack.md)).

```
 phone / laptop browser ── PWA (React, en/ur) ── IndexedDB outbox (offline attendance)
          │ HTTPS
          ▼
 Cloudflare Worker ── Hono /api/* (sign-in, permission check on every route) + static app
          │
          ├── D1 (SQLite): append-only ledger, triggers, derived balances
          └── R2: photos, payment proofs

 GitHub Actions, nightly ── D1 export → encrypted ──► R2 + Backblaze B2 + Google Sheet
```

| Path | What |
|---|---|
| `apps/api` | Worker: Google sign-in, sessions, permission matrix, routes, fee cron |
| `apps/web` | PWA: Vite + React 19 + Tailwind 4 + shadcn/ui, i18next `en`/`ur` |
| `packages/db` | Drizzle schema, SQL triggers and views, migrations, seed |
| `packages/shared` | Zod schemas, roles and permissions, money formatting, translations |
| `docs/` | Plan, ADRs, deploy and restore runbooks |

## How it was built

Planned first, with the research and evidence behind each decision recorded in
[docs/PLAN.md](docs/PLAN.md). Built milestone by milestone in a loop of AI agents directed by a
human (an implementer, a blind reviewer that did not see the implementer's reasoning, and a
verifier working from a clean clone), with every review finding and its fix recorded in the plan.

## Security

Please report vulnerabilities privately through GitHub's private vulnerability reporting; see
[SECURITY.md](SECURITY.md). Do not open public issues for security problems.

## License

[AGPL-3.0](LICENSE). If you run a modified Maktab for others, you must share your changes under the
same licence. Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Acknowledgements

- [Noto Nastaliq Urdu](https://fonts.google.com/noto/specimen/Noto+Nastaliq+Urdu), SIL Open Font
  License 1.1 (subset in `apps/web/public/fonts/`).
- Ideas borrowed from [OpenMasjidStudents](https://github.com/OpenMasjid-Solutions/OpenMasjidStudents)
  (AGPL; fee ledger), [CoachSync](https://github.com/rakibul-islam-raju/CoachSync) (reversals, cash
  snapshots), [Gibbon](https://gibbonedu.org) (families, messenger) and
  [Frappe Education](https://github.com/frappe/education) (student groups). See
  [docs/PLAN.md](docs/PLAN.md) §16.

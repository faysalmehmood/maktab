# The public demo

**https://maktab.conceptlix.com**: a made-up school anyone can open, with no account. The real
pilot (Global Science Academy) runs on its own installation, **https://maktab-gsap.conceptlix.com**
(docs/deploy.md). The two share no database, files, secrets or backups.

## What it is

- **Al-Noor Community School, Lahore** (badge AN, maroon, النور کمیونٹی اسکول), school and academy
  mode, session 2026-27, with six months of history (April–September 2026). Everything is invented:
  names are common Pakistani names, phone numbers are in the fake `03XX 555 NNNN` and
  `042 3555 NNNN` blocks, and CNICs use the 555 block too.
- 300 students in 190 families (57 with siblings). Classes run from Nursery to Class 10, with A/B
  sections for Classes 4–8, plus an FSc Pre-Medical morning batch and a Matric evening batch. There
  are 14 staff, with class and subject teachers assigned.
- Fees: tuition by programme, academy tuition, admission fee (mid-session joiners only), exam fee
  (Classes 5–10, second term) and an activity fund (Nursery–Class 3). There are 20 concessions, 3
  sponsors and 10 opening balances.
- Six monthly billing runs. About 950 receipts (cash, bank, JazzCash, one cheque), about 87%
  collected and roughly 80 families with dues. Some payments are partial and some in advance. There
  are four reversals (a typo re-entered, a JazzCash transfer reversed, an entry typed twice, a
  bounced cheque) and one refund.
- Late fines and waivers. The accountant's drawer is closed every office day, some days with small
  variances, and cash is deposited at the bank every Saturday.
- Expenses by category, including one voided. 84 payslips approved and paid, and two salary
  advances recovered through payslips.
- Registers for every school day of **September**, with 5–8% absence. Messages: absence rows
  (sent, skipped and queued), fee-due and overdue reminders, a notice to every family and payment
  receipts. 40 guardians have parent links.

Registers cover September only. A full six months of registers would be about 27,000 more rows,
and every reseed counts against the Cloudflare account's free D1 limit of 100,000 rows written a
day. That limit is shared with the GSA pilot.

**Sign-in.** The sign-in page has three buttons: **Try as principal** (owner), **Try as
accountant** and **Try as teacher** (Ayesha Siddiqa, class teacher of Class 5 A, who also teaches
English in several classes). Each calls `POST /api/auth/demo`, which is rate limited per IP. The
installation owner (`OWNER_EMAIL`, thefaysalmehmood@gmail.com) can also sign in with Google.
`maktab.conceptlix.com/api/auth/google/callback` is already an authorised redirect URI, because
this was the first production host. A banner on every screen says the data is made up and reset
nightly.

**Locked in the demo** (403 `demo_locked`): staff invites, user roles and enabling or disabling
users, backups ("download everything", drills) and "Revoke all parent links". Uploads (logo, student
photos, bill photos) are capped at 200 KB and 10 an hour per IP. Everything else works.

## Reset schedule

- Any successful write by a visitor marks the demo **dirty**. Sign-in and the parent page do not
  count.
- The demo's cron runs **every minute**. At **02:00 Asia/Karachi**, if the demo is dirty, it starts
  a reset. Each tick then advances it by about 40 database calls, and the fee cron and daily pass
  wait until the reset is done. A night nobody touched the demo costs nothing.
- The owner (`OWNER_EMAIL` only, not the demo principal) can reset by hand:
  `POST /api/demo/reset`, rate limited to 2 an hour. This signs everyone out.
- Progress: `GET /api/demo` returns `{phase, step, total, step_name, started_at, finished_at, dirty,
  last_error}`.

How a reset works (`packages/db/src/demo/runner.ts`):

1. A snapshot of `sqlite_master` is saved in `_demo_state`.
2. Every table, index, view and trigger is **dropped and re-created** from that snapshot.
   `d1_migrations` and `_demo_state` are kept. This is not `DELETE`: D1 counts every deleted row
   and index entry as a row written, while a `DROP TABLE` costs a handful. Measured on 2026-10-13:
   `DELETE` of 1,000 indexed rows counted more than 1,000; `DROP TABLE` counted 4.
3. The dataset is rebuilt in about 160 resumable, idempotent steps
   (`packages/db/src/demo/steps.ts`). Ids are deterministic, receipts use idempotency keys, and
   every step checks whether its work is already done, so a call cut short by the CPU limit or a
   lost response is simply run again. A lease stops the cron and the step route from running the
   same step at once. Money is written only through the ledger helpers.

A full reseed writes on the order of 70k D1 rows. At most one runs a night, and only when the demo
is dirty. Do not reset by hand more than once a day.

## Re-deploy and re-seed

```sh
npm run build
cd apps/api && npx wrangler deploy --env demo          # Worker `maktab`, D1 `maktab`, R2 maktab-files
npx wrangler d1 migrations apply DB --remote --env demo
npm run db:verify -- --remote --env demo               # from the repo root
```

To re-seed now, either:

- sign in as the owner and `POST /api/demo/reset`, or
- drive it from a terminal (the cron does the same, about 40 calls a minute):

  ```sh
  until curl -s -X POST https://maktab.conceptlix.com/api/demo/step \
      -H 'origin: https://maktab.conceptlix.com' -H 'content-type: application/json' -d '{}' \
      | grep -q '"phase":"done"'; do :; done
  ```

`POST /api/demo/step` is public and rate limited (60 a minute per IP). It only advances a reset that
is already running, or seeds an empty database. It never starts a wipe of a seeded demo.

A reset refuses a database whose school is not "Al-Noor Community School". To take over a database
that still holds another school (as on 2026-10-13, when the first production database became the
demo), set the flag by hand. The next tick or step then wipes it:

```sh
npx wrangler d1 execute DB --remote --env demo --command \
  "CREATE TABLE IF NOT EXISTS _demo_state (key TEXT PRIMARY KEY, value TEXT);
   INSERT INTO _demo_state VALUES ('force', '1') ON CONFLICT (key) DO UPDATE SET value = '1';"
```

Locally: `npm run db:migrate:local && npm run seed:demo -w @maktab/db` takes about 3 s. It wipes the
local database first. Use `SEED_OWNER_EMAIL=<gmail>` to add your Google account as an owner. Parent
links use `PARENT_LINK_SECRET` from `apps/api/.dev.vars`. To see the demo UI locally, add
`DEMO_MODE=1` to `.dev.vars`.

## Google sign-in

- **Demo** (maktab.conceptlix.com): nothing to do. The redirect URI
  `https://maktab.conceptlix.com/api/auth/google/callback` is already on the OAuth client, and the
  demo buttons need no Google at all.
- **GSA pilot** (maktab-gsap.conceptlix.com): two steps the owner must do by hand.
  1. In Google Cloud console, open APIs & Services → Credentials → the OAuth client and add the
     authorised redirect URI `https://maktab-gsap.conceptlix.com/api/auth/google/callback`.
  2. Set that Worker's client secrets:
     `cd apps/api && npx wrangler secret put GOOGLE_CLIENT_ID --env gsap` and the same for
     `GOOGLE_CLIENT_SECRET`. Use the same OAuth client's values.

  Until both are done, `GET /api/auth/google/start` on gsap answers 500 `misconfigured`.

## Guarantees (tests)

- `packages/db/test/demo-seed.test.ts`: the dataset's shape, about 85% collection,
  `ledger_consistency` empty, the P&L reconciliation ties, every family has a guardian with a
  number and all numbers are fake. A reset reproduces the same school, a seed cut into one-call
  slices ends identical, and a reset refuses another school's database.
- `apps/api/test/demo.test.ts`: `DEMO_MODE` is set only on `[env.demo]` (never on `env.gsap` or
  the top level). Without it every demo route is 404. With it, the buttons give each fixed user its
  roles, the locked routes answer `demo_locked` (even for the demo principal), uploads are capped,
  writes mark the demo dirty, only `OWNER_EMAIL` may reset, and the 02:00 tick reseeds once a day.

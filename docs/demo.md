# The public demo

**https://maktab.conceptlix.com**: a made-up school anyone can open, with no account. The real
pilot (Global Science Academy) runs on its own installation, **https://maktab-gsap.conceptlix.com**
(docs/deploy.md). The two share no database, files, secrets or backups.

## What it is

- **Al-Noor Community School, Lahore** (badge AN, maroon, النور کمیونٹی اسکول), school and academy
  mode, session 2026-27, with six months of history **ending on the seed day**. Every date is laid
  out relative to the day the dataset was seeded (today in Asia/Karachi; `DemoCalendar` in
  `packages/db/src/demo/world.ts`), so the demo always opens on a school in the middle of its
  current month. Everything is invented:
  names are common Pakistani names, phone numbers are in the fake `03XX 555 NNNN` and
  `042 3555 NNNN` blocks, and CNICs use the 555 block too.
- 112 students in 70 families (21 with siblings). Classes run from Nursery to Class 10, with A/B
  sections for Classes 4–8, plus an FSc Pre-Medical morning batch and a Matric evening batch. There
  are 14 staff, with class and subject teachers assigned.
- Fees: tuition by programme, academy tuition, admission fee (mid-session joiners only), exam fee
  (Classes 5–10) and an activity fund (Nursery–Class 3), both billed with the second term
  (1 September). There are 12 concessions, 3 sponsors (the trust pays every month, the other two
  once a quarter, so all three owe something) and 10 opening balances carried from the paper
  register.
- Six monthly billing runs, the current month included (about 1,000 charges). About 350 receipts
  (cash, bank, JazzCash, one cheque). The completed months are about 95% collected; the current
  month only as far as today (most families pay by the due date, the 10th; late payers trickle in),
  so there are about 35 families with dues. Some payments are partial and some in advance. There are
  four reversals (a typo re-entered, a JazzCash transfer reversed, an entry typed twice, a bounced
  cheque) and one refund, all in the completed months.
- **Today** (when the seed day is an office day): five families paid cash at the counter, and the
  accountant's drawer is open with those receipts. Every earlier office day's drawer is closed, some
  with small variances, and cash is deposited at the bank every Saturday. Late fines and waivers.
  The seed day's drawer is never closed by the seed: until the next reseed, the Cash page shows
  that day's session as still open (on Tuesday to Sunday, Monday's), as a counter left open
  overnight would. A visitor can close it; the nightly undo opens it again.
- Expenses by category in every month, today's month included, one of them voided. 70 payslips
  approved and paid (14 staff, through last month; this month's are not prepared yet), and two
  salary advances recovered through payslips.
- Registers for the **last 5 school days up to and including today**, about 5% absence (today the
  habitually absent children are away, so there is always someone to message about). Today's are
  partly taken: 12 of 19 groups, with Class 5 A (the demo teacher's), the evening batch and five
  others still to do. Messages (about 180): absence rows (today's queued, earlier days sent or
  skipped), fee-due and overdue reminders for the current month (last month's before the 14th), a
  notice to every family a week ago and payment receipts. 40 guardians have parent links.
- The session stays 2026-27 (1 April 2026 – 31 March 2027); a seed day past its end stretches it to
  the end of that month. The calendar knows the gazetted holidays and the summer vacation (1 June –
  13 August) through spring 2028; Islamic holidays after 2026 are estimates. The demo runs no fee cron, late fines or daily pass, so nothing writes rows
  on its own; the dataset ages until the next reseed (below).
- Seeding locally as of another day: `DEMO_TODAY=2026-11-02 npm run seed:demo -w @maktab/db`.

## The D1 budget

The Cloudflare account's free D1 plan allows **100,000 rows written and 5,000,000 rows read a day**,
reset at 00:00 UTC (05:00 PKT), for **all its databases together**: the demo and the GSA pilot share
it. On 2026-10-14 a full reseed of the first, larger dataset (300 students, ~86k writes) on top of
the previous day's run used it up, and D1 refused writes for the rest of the UTC day. So:

- **A row write is the row plus one per index on its table.** That makes some tables dear:
  `charge` has 9 indexes (10 writes a row), `receipt` 7, `message` 5, `receipt_allocation` 3,
  `att_mark` and `audit` 2. Updates count too.
- **A full reseed is budgeted at 33,000 row writes** (`DEMO_SEED_WRITES`; the cap is 35,000).
  Every reseed but the first runs over a seeded demo, and that is what counts: the wipe empties the
  six self-referencing tables row by row (about 3,000 writes, see the wipe below) before the new
  dataset is written. The cost depends a little on the seed day. Measured over the previous demo
  (`packages/db/test/demo-seed.test.ts`, which fails past the budget): ~31,900 writes for
  2026-10-14 (~28,800 on a fresh database), ~500 more than before migration 0025's two indexes
  (see Reads below). Before them, a sweep of every seed day from 2026-10-14 to 2028-04-30, each
  reseeded over the day before, ranged from ~27,500 (summer vacation) to ~31,400 at worst
  (2027-02-28): **~31,900 at worst** now (31,889 for 2026-10-14 over an existing demo), only
  ~1,100 under the budget. The next addition to the dataset must trim something else first. D1's own count for the same
  reseed (`meta.rows_written`, apps/api/test/d1-demo-reads.test.ts) is lower: 29,193. Charges are the largest part
  (~10,000), then receipts and allocations, audit, registers and messages. That is why the school
  has 112 students: a reseed over the demo costs about 260 writes a student. `npm run seed:demo`
  prints the plan before it starts and the same measurement after.
- Why not more attendance: a register day costs about 3 writes a student (mark + 2 indexes) plus
  the register rows, ~420 writes a day here. Three months of registers would be ~25,000 writes on
  their own, so the demo keeps one week. Six months of money history is kept, because that is
  what the reports show.
- **Nightly reset = undo, not reseed** (below): it costs about what visitors wrote that day
  (a visitor's afternoon of edits, a payment and a reversal: ~135 writes). It is skipped, with an
  alarm in the logs (`demo_alarm: undo_over_budget`), if it would cost more than **20,000**.
- **Weekly full reseed**: every Monday, and on the 1st of every month, the 02:00 run is a full
  reseed (~33,000 writes) instead of the undo, so the dates move forward. That is at most about six
  reseeds a month, one on any day, a third of the daily 100,000.
- **At most one reset a UTC day** (full or undo), whoever asks.
- **Quota guard:** if D1 refuses a query for a daily limit ("Exceeded maximum rows written per
  day", "exceeded D1's free tier daily row read limit", `quota`, a full database), the demo logs
  `demo_alarm: d1_quota` and runs nothing until the next 00:00 UTC (`backoff_until` in
  `GET /api/demo`). At the read limit even `_demo_state` cannot be read, so the isolate also
  remembers the backoff: later ticks touch nothing, and `POST /api/demo/step` and `GET /api/demo`
  answer 503 `demo_not_ready` (`apps/api/test/demo-quota.test.ts`). Only the limit wording counts:
  code 7500 alone is also D1's generic internal error, and a storage timeout is transient; neither
  pauses the demo.

**Reads.** The same account allows **5,000,000 rows read a day**. D1 counts every row a query
visits, not the rows it returns: a scan of a table, of a view's whole aggregate, or of
`sqlite_master` (~470 rows: every DDL statement scans it) counts in full, and so do the reads a
trigger makes. On 2026-10-14 the demo used up the read limit too (`wrangler d1 info`: ~11,000,000
rows read in 24,826 queries). Measured on workerd's D1 (`apps/api/test/d1-demo-reads.test.ts`,
which sums `meta.rows_read` per step and per statement and fails past the budget), seed day
2026-10-14:

| | before | after (2026-10-15) |
|---|---|---|
| Full reseed over the demo | 1,236,530 | **345,425** (2027-02-28: 351,528; 2026-11-02: 326,904) |
| First seed (empty database) | | 272,241 |
| Idle tick (every minute) | 23 | 23 |
| 02:00 tick, nothing to undo | 502 | 35 |
| Nightly undo of a visitor's afternoon (11 changes, 5 tables) | 22,836 | 6,009 |
| `GET /api/demo` | 11 | 11 |

- **A full reseed is budgeted at 400,000 rows read** (`DEMO_SEED_READS`; the target is 1,000,000,
  the cap 1,500,000). Half of the old cost was one statement: dropping `charge` (a table that
  references itself) deletes it row by row, and each delete looked for children by scanning every
  remaining charge (n²/2, ~563,000 rows for ~1,000 charges). The wipe now keeps the index on the
  self-referencing column (`charge_parent`, `receipt_reverses_id_unique`) until the drop: ~3,000.
- What a reseed reads now: the day-by-day ops ~130,000 (the family's dues before each receipt, the
  allocation triggers), the wipe ~100,000 (each of ~400 DROP statements scans `sqlite_master`; not
  reducible short of fewer schema objects) and the six billing runs ~97,000.
- Fixed on the way, and good for every school, not only the demo: `receipt(cash_session_id)` and
  `payslip_line(payslip_id)` are indexed (migration 0025; a drawer's expected cash and every payslip
  read scanned the whole table), the generation cursor no longer joins groups × chunks in SQL, and
  credit lookups bind their families (`IN (?, …)`) so SQLite reads `payer_credit` by index.
- The nightly undo costs ~1,500 rows a chunk (three looks at `sqlite_master`) plus ~470 for each
  trigger it drops and re-makes; it now drops only the triggers its restores fire.
- **A day's budget.** A normal day: 1,440 idle ticks (~33,000) + the undo (a few thousand to a few
  tens of thousands) + what visitors read. A reseed day (Mondays, the 1st): about 380,000 + visitors.
  Both are well under a tenth of 5,000,000, with the GSA pilot's ~1,000 a day beside it.
- To check a seeded demo remotely, run one count query per table, once.

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

> **Paused since 2026-10-15.** The demo Worker is deployed with no cron (`[env.demo.triggers]
> crons = []` in `apps/api/wrangler.toml`), at the owner's request: the account's D1 daily limits
> were hit twice on 10-14 (writes, then reads) and each one raises a Cloudflare alert. Nothing
> below runs until the cron is put back: no nightly undo, no Monday/1st reseed, no idle tick. The
> demo keeps whatever visitors change. A reseed by hand costs about 27k row writes and 340k row
> reads: set `_demo_state.force = 1` and drive `POST /api/demo/step` (see "Re-deploy and re-seed").

- Any successful write by a visitor marks the demo **dirty**, and every change to school data is
  logged in `_demo_undo` (`packages/db/src/demo/undo.ts`): after the seed, each data table has
  three `_demo_undo_<table>_{i,u,d}` triggers that record the key of an inserted row or the old
  values of an updated or deleted one. Sign-in sessions (`user_session`) are not logged.
- The demo's cron runs **every minute**. At **02:00 Asia/Karachi**, if the log has entries and no
  reset ran this UTC day, it estimates the cost (one grouped read of the log), and if that is under
  20,000 it **plays the log back**, newest first, 100 entries per D1 batch: each batch drops the
  touched tables' guard and undo triggers that its restores fire (insert, update or delete),
  restores the rows, re-creates the triggers and deletes the log rows, in one transaction, so the money guards are never off between batches. Changes made
  while it runs wait for the next night. A night nobody touched the demo costs a few reads.
- **Every Monday and on the 1st of the month**, the 02:00 run is a **full reseed** instead
  (`demoReseedDue` in `apps/api/src/routes/demo.ts`), dated from that day: the undo only ever
  returns the demo to its seed day, so without it "today" would drift into the past (no registers
  or receipts today, a new month unbilled). It starts only if no reset ran this UTC day and D1 is
  not in a quota backoff, costs ~33,000 writes and signs everyone out. If 02:00 could not start it
  (a reset already ran that UTC day, a quota backoff until 05:00 PKT, a deploy), any later tick
  that day starts it, until the data is dated today (`anchor` in `GET /api/demo`). Monday rather than Sunday:
  Sunday is the school's weekly off, so a Sunday seed day has no counter and no registers to show.
  The 1st catches the new month's billing. Between reseeds the dataset ages: by Saturday "today"
  shows nothing collected or taken yet, as on a quiet morning.
- The owner (`OWNER_EMAIL` only, not the demo principal) can start a **full reseed** by hand:
  `POST /api/demo/reset` (2 an hour, and refused if a reset already ran this UTC day). It costs
  ~33,000 writes and signs everyone out. Use it only on a quiet day, for example when an undo was
  skipped for its size.
- Progress: `GET /api/demo` returns `{phase, step, total, step_name, started_at, finished_at, dirty,
  last_error, backoff_until, anchor}`. `phase` is `running` (full reseed), `undoing` (nightly undo) or
  `done`.

How a full reseed works (`packages/db/src/demo/runner.ts`):

1. The seed day (`anchor`, today in Asia/Karachi) and a snapshot of `sqlite_master` (without the
   demo's own `_demo_*` objects) are saved in `_demo_state`. A reset that runs past midnight keeps
   building the dataset of the day it started.
2. Every table, index, view and trigger is **dropped and re-created** from that snapshot, and the
   undo log is dropped. `d1_migrations` and `_demo_state` are kept. This is not `DELETE`: D1 counts
   every deleted row and index entry as a row written, while a `DROP TABLE` costs a handful.
   Measured on 2026-10-13: `DELETE` of 1,000 indexed rows counted more than 1,000; `DROP TABLE`
   counted 4. With foreign keys on (always, on D1) SQLite deletes a table's rows before dropping
   it while another table still references it, so tables are dropped children first, in
   `pragma_foreign_key_list` order. The six tables that reference themselves (`charge`, `receipt`,
   `enrolment`, `grp`, `programme`, `user`) are still emptied row by row; their indexes are dropped
   first so that costs one write a row plus the primary key (~3,000 writes, in the budget below),
   all but the one on the self-referencing column (`charge_parent`, `receipt_reverses_id_unique`):
   without it each row's delete scans the whole table for children (~563,000 rows read for
   `charge`; see Reads).
3. The dataset is rebuilt in about 140 resumable, idempotent steps
   (`packages/db/src/demo/steps.ts`). Ids are deterministic, receipts use idempotency keys, and
   every step checks whether its work is already done, so a call cut short by the CPU limit or a
   lost response is simply run again. A day's ops that decide from live balances ("nothing due",
   "the first fine left") never run again once anything is dated after that day, or (cash ops)
   once that day's drawer is closed; a test re-runs every step over a finished seed and finds
   nothing changed. A lease stops the cron and the step route from running the
   same step at once. Money is written only through the ledger helpers. Each invocation runs up to
   12 step calls; a fee-generation chunk counts as 4, because 12 of them in one invocation exceeded
   the free plan's CPU limit (error 1102).
4. The last step installs the undo-log triggers (about 180 schema writes).

`db:verify` ignores the `_demo_*` triggers.

## Re-deploy and re-seed

```sh
npm run build
cd apps/api && npx wrangler deploy --env demo          # Worker `maktab`, D1 `maktab`, R2 maktab-files
npx wrangler d1 migrations apply DB --remote --env demo
npm run db:verify -- --remote --env demo               # from the repo root
```

To re-seed now, either:

- sign in as the owner and `POST /api/demo/reset`, or
- drive it from a terminal (the cron does the same, once a minute). Check the budget first: a
  full reseed is ~33,000 of the account's 100,000 daily writes, shared with the GSA pilot:

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

Locally: `npm run db:migrate:local && npm run seed:demo -w @maktab/db` takes about 2 s. It wipes the
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

- `packages/db/test/demo-seed.test.ts` (seed day pinned to 2026-10-14): the dataset's shape, past
  months mostly collected and the current one partly, `ledger_consistency` empty, the P&L
  reconciliation ties, every family has a guardian with a number and all numbers are fake. Nothing
  is dated after the seed day; the current month is billed, payslips stop at last month, today has
  cash receipts in an open drawer, 12 of 19 registers and queued absence messages. Other seed days
  (a month end, a Sunday, a day past the session) seed cleanly within budget. The seed fits
  `DEMO_SEED_WRITES` (≤ 35,000). A reset for the same seed day reproduces the same school, a seed
  cut into one-call slices ends identical, running every step again over a finished seed changes
  nothing, a reseed over the demo stays within budget (also for a month end, two Sundays and a day
  past the session), and a reset refuses another school's database. The undo puts back exactly what a visitor changed (edits, a delete, a payment,
  a reversal) with every trigger restored, runs once a UTC day, and is skipped over 20,000 writes;
  quota errors are recognised.
- `apps/api/test/d1-demo-reads.test.ts` (workerd's D1 through wrangler's `getPlatformProxy`): a
  full reseed over the demo, driven as the cron drives it, reads at most `DEMO_SEED_READS`; an idle
  tick and `GET /api/demo` read ≤ 50 rows, the 02:00 tick with nothing to undo ≤ 50, and a small
  nightly undo ≤ 10,000. Its log prints the rows read per step and the top statements;
  `DEMO_READS_TODAY=YYYY-MM-DD` measures another seed day. `demo-quota.test.ts`: the read-limit
  error backs the demo off until 00:00 UTC without another query.
- `apps/api/test/demo.test.ts`: `DEMO_MODE` is set only on `[env.demo]` (never on `env.gsap` or
  the top level). Without it every demo route is 404. With it, the buttons give each fixed user its
  roles, the locked routes answer `demo_locked` (even for the demo principal), uploads are capped,
  writes mark the demo dirty, only `OWNER_EMAIL` may reseed, the 02:00 tick undoes a visitor's
  change once a UTC day, and on a Monday (or the 1st) it reseeds in full, dated from that day,
  once; a reseed refused at 02:00 starts on a later tick that day.

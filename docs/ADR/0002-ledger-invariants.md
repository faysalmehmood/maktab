# ADR 0002 — Ledger invariants and migration policy

Date: 2026-10-10 · Status: accepted · Source: M0 review and closing review; PLAN §5.2, §14.4–14.8

## Decision

The database, not the app, refuses impossible money states (`packages/db/sql/`, `RAISE(ABORT)`
rolls back the whole D1 batch; row-local rules are CHECKs in the Drizzle schema).

- **Charge tree and kind signs.** Only `fee` rows are roots. `concession`, `fine`, `reversal` hang off
  a fee; `fine_waiver` (and a reversal of a fine) hang off the fine; same student and payer as the
  parent. `fee`/`fine` > 0; `concession`/`fine_waiver`/`reversal` < 0; `reversal`/`fine_waiver` need a
  reason. Net = sum of the tree (≤ 2 levels). A negative line may not take its parent below 0.
- **Allocation and release.** Allocations target roots and match the receipt's payer. Several rows
  per (receipt, charge) pair are allowed; the pair's running sum is what counts. Payment: pair sum
  ≥ 0, Σ per receipt ≤ amount; a negative row is a *release*. Σ per charge ≤ root net, and after a
  negative child line root net ≥ Σ allocations — so a concession on a paid fee must insert the
  release first, in the same batch; the released money becomes payer credit (`payer_credit` view).
- **Reversal shape.** `reverses_id` → a `payment` only, `amount = −original`, same payer and method,
  at most once. Its pair sums are ≤ 0 and never exceed the original's pair sum on that charge. A
  reversed payment takes no further allocations. The only writer is
  `packages/db/src/ledger` `reverseReceipt`: reversal receipt, then one unwind per charge computed
  in the same batch from the payment's live pair sums, then an optional re-entry payment with its
  allocations, then an `audit` row with the reason — one D1 batch.
- **Payer credit ≥ 0, always.** credit(payer) = Σ receipts (payment + reversal + refund, signed) −
  Σ allocations (signed). A positive allocation and a refund each abort if they would take it below
  0. A reversal is inserted before its unwinds (they reference it), so its trigger **assumes the
  unwinds follow in the same batch** and aborts if credit_now − |payment| + Σ payment allocations
  < 0 (e.g. "refund, then reverse the payment"). A reversal written without its unwinds is not
  caught by a trigger; it shows up in the `ledger_consistency` view (payers with credit < 0;
  receipts whose allocation sum ≠ expected), which must stay empty (nightly alarm: M6).
- **Allocation ids** are caller-minted ULIDs (`receipt_allocation.id`), inserted with
  `WHERE NOT EXISTS`, so a retried "apply credit" is a no-op. Unwind ids are derived
  (`<reversal id>:<charge id>`) because SQL cannot mint ULIDs.
- **Refund** = negative receipt with no allocations, within payer credit.
- **Integer money:** `typeof(x) = 'integer'` CHECK on every money column.
- **Cash session is close-only.** Once `closed_at` is set the row is frozen except a reopen
  (`closed_at` → NULL with `reopened_by/at` and a non-empty `reopen_reason` different from the
  previous one); a closed session takes no receipt, expense or transfer. While open, the reopen
  record is fixed; the closing update must clear `reopened_by/at` (`reopen_reason` stays as the last
  reason so the next reopen needs a new one; the reopen route (M3) writes each reopen to `audit`). A new session has no
  reopen record. `variance` is a generated column.
- **Payroll:** payslip `draft → approved → paid` only; lines freeze at approval; salary needs
  approval; line amounts are > 0 and the kind gives the sign (basic, allowance add; deduction,
  advance_recovery subtract); Σ `salary_payment` per slip ≤ that net.
- **History:** `audit`, `att_register`, `att_mark` are append-only; `current_register` moves only to a
  later `taken_at`; `receipt_series.next_no` only advances by one.

## Migration policy

`0000_init` and `0001_ledger_rules` were edited in place twice before any deploy (M0 review, then
the M0 closing review, regenerated with drizzle-kit and `sync-custom-sql.ts`). That was the last
time: from the next commit on the policy is absolute. A committed migration is immutable: changing
`sql/*.sql` and running `npm run db:generate` emits a new numbered custom migration that drops
(`IF EXISTS`) every object the file's previous and new versions create, then re-creates the file.
`migrations/custom_sql.json` (outside `meta/`, which drizzle-kit parses as snapshots) records each
migration's hash and the hashes of the sql files it carries; CI (`sync-custom-sql.ts --check`)
fails on an unrecorded sql change or an edited migration. If a Drizzle migration rebuilds a table
(dropping its triggers), touch the matching sql file so the next migration re-creates them; the
schema-presence test (`packages/db/test/flows.test.ts`) fails if any object named in `sql/` is
missing after all migrations, and the nightly backup greps the dump for the same names.

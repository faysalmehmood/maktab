# ADR 0002 — Ledger invariants and migration policy

Date: 2026-10-10 · Status: accepted · Source: M0 review; PLAN §5.2, §14.4–14.8

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
  reversed payment takes no further allocations.
- **Refund** = negative receipt with no allocations; payer credit (Σ receipts − Σ allocations) ≥ 0.
- **Integer money:** `typeof(x) = 'integer'` CHECK on every money column.
- **Cash session is close-only.** Once `closed_at` is set the row is frozen except a reopen
  (`closed_at` → NULL with `reopened_by/at/reason`); a closed session takes no receipt, expense or
  transfer. `variance` is a generated column.
- **Payroll:** payslip `draft → approved → paid` only; lines freeze at approval; salary needs approval.
- **History:** `audit`, `att_register`, `att_mark` are append-only; `current_register` moves only to a
  later `taken_at`; `receipt_series.next_no` only advances by one.

## Migration policy

`0000_init` and `0001_ledger_rules` were edited in place once (never deployed). From now on a
committed migration is immutable: changing `sql/*.sql` and running `npm run db:generate` emits a new
numbered custom migration that drops (`IF EXISTS`) every object the file's previous and new
versions create, then re-creates the file. `migrations/meta/custom_sql.json` records each migration's
hash and the hashes of the sql files it carries; CI (`sync-custom-sql.ts --check`) fails on an
unrecorded sql change or an edited migration. If a Drizzle migration rebuilds a table (dropping its
triggers), touch the matching sql file so the next migration re-creates them.

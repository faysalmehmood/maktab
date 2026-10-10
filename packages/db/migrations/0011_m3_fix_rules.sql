-- source: sql/20_append_only.sql
DROP TRIGGER IF EXISTS current_register_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS current_register_forward;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_mark_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_mark_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_register_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS att_register_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_series_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_series_monotonic;
--> statement-breakpoint
DROP TRIGGER IF EXISTS salary_payment_within_net;
--> statement-breakpoint
DROP TRIGGER IF EXISTS salary_payment_needs_approval;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_line_delete_draft;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_line_update_draft;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_line_insert_draft;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_approver_frozen;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_frozen;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_void_unpaid;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_status_forward;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_starts_draft;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transfer_session_open;
--> statement-breakpoint
DROP TRIGGER IF EXISTS expense_session_open;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_session_open;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_session_close_only;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_session_open_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_session_frozen;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_session_born_open;
--> statement-breakpoint
DROP TRIGGER IF EXISTS cash_session_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS expense_void_once;
--> statement-breakpoint
DROP TRIGGER IF EXISTS expense_frozen;
--> statement-breakpoint
DROP TRIGGER IF EXISTS expense_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS concession_end_once;
--> statement-breakpoint
DROP TRIGGER IF EXISTS concession_frozen;
--> statement-breakpoint
DROP TRIGGER IF EXISTS concession_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS salary_payment_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS salary_payment_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS staff_advance_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS staff_advance_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transfer_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transfer_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_run_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_run_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fee_rate_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS fee_rate_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS opening_balance_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS opening_balance_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_no_update;
--> statement-breakpoint
-- Money is append-only (PLAN §5.2). Corrections are new rows (reversal, concession end + new row, void).
-- RAISE(ABORT) inside a D1 batch rolls back the whole batch; app code matches on the message text.
-- Re-emitted by migration 0009 (0008 rebuilt `receipt`) and again by 0011 (0010 rebuilt `receipt`
-- and `payslip` for the final enums), each rebuild dropping the triggers on the rebuilt table.

CREATE TRIGGER charge_no_update BEFORE UPDATE ON charge BEGIN SELECT RAISE(ABORT, 'charge is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER charge_no_delete BEFORE DELETE ON charge BEGIN SELECT RAISE(ABORT, 'charge is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER receipt_no_update BEFORE UPDATE ON receipt BEGIN SELECT RAISE(ABORT, 'receipt is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER receipt_no_delete BEFORE DELETE ON receipt BEGIN SELECT RAISE(ABORT, 'receipt is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER alloc_no_update BEFORE UPDATE ON receipt_allocation BEGIN SELECT RAISE(ABORT, 'allocation is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER alloc_no_delete BEFORE DELETE ON receipt_allocation BEGIN SELECT RAISE(ABORT, 'allocation is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER opening_balance_no_update BEFORE UPDATE ON opening_balance BEGIN SELECT RAISE(ABORT, 'opening_balance is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER opening_balance_no_delete BEFORE DELETE ON opening_balance BEGIN SELECT RAISE(ABORT, 'opening_balance is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER fee_rate_no_update BEFORE UPDATE ON fee_rate BEGIN SELECT RAISE(ABORT, 'fee_rate is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER fee_rate_no_delete BEFORE DELETE ON fee_rate BEGIN SELECT RAISE(ABORT, 'fee_rate is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER billing_run_no_update BEFORE UPDATE ON billing_run BEGIN SELECT RAISE(ABORT, 'billing_run is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER billing_run_no_delete BEFORE DELETE ON billing_run BEGIN SELECT RAISE(ABORT, 'billing_run is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER transfer_no_update BEFORE UPDATE ON transfer BEGIN SELECT RAISE(ABORT, 'transfer is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER transfer_no_delete BEFORE DELETE ON transfer BEGIN SELECT RAISE(ABORT, 'transfer is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER staff_advance_no_update BEFORE UPDATE ON staff_advance BEGIN SELECT RAISE(ABORT, 'staff_advance is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER staff_advance_no_delete BEFORE DELETE ON staff_advance BEGIN SELECT RAISE(ABORT, 'staff_advance is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER salary_payment_no_update BEFORE UPDATE ON salary_payment BEGIN SELECT RAISE(ABORT, 'salary_payment is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER salary_payment_no_delete BEFORE DELETE ON salary_payment BEGIN SELECT RAISE(ABORT, 'salary_payment is append-only'); END;
--> statement-breakpoint

-- Rows that change state exactly once: no delete, identity columns frozen, terminal state frozen.

CREATE TRIGGER concession_no_delete BEFORE DELETE ON concession BEGIN SELECT RAISE(ABORT, 'concession cannot be deleted; end it'); END;
--> statement-breakpoint
CREATE TRIGGER concession_frozen BEFORE UPDATE OF id, student_id, fee_head_id, type, value, reason, note, approved_by, valid_from, valid_to, created_at, created_by ON concession
BEGIN SELECT RAISE(ABORT, 'concession is never edited; end it and add a new row'); END;
--> statement-breakpoint
CREATE TRIGGER concession_end_once BEFORE UPDATE ON concession WHEN OLD.ended_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'concession already ended'); END;
--> statement-breakpoint

CREATE TRIGGER expense_no_delete BEFORE DELETE ON expense BEGIN SELECT RAISE(ABORT, 'expense cannot be deleted; void it'); END;
--> statement-breakpoint
CREATE TRIGGER expense_frozen BEFORE UPDATE OF id, expense_no, category_id, account_id, cash_session_id, amount, vendor, date, note, created_at, created_by ON expense
BEGIN SELECT RAISE(ABORT, 'expense is never edited; void it'); END;
--> statement-breakpoint
CREATE TRIGGER expense_void_once BEFORE UPDATE ON expense WHEN OLD.voided_by IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'expense already voided'); END;
--> statement-breakpoint

-- Cash session: close-only (PLAN §14.6). While open, the drawer fields may change; once closed the row
-- is frozen, and the only permitted change is an owner/admin reopen: closed_at back to NULL together
-- with reopened_by/at and a non-empty reopen_reason that differs from the previous reopen's, every
-- other column unchanged. variance is a generated column.
-- Reopen record: reopened_by/at describe the *current* reopen only. They are fixed while the session is
-- open, and the closing update must clear them (a trigger cannot rewrite NEW, so the app sets them to
-- NULL in the same statement); reopen_reason is kept as the last reason so the next reopen must give a
-- new one. The full history of reopens is in `audit`.
CREATE TRIGGER cash_session_no_delete BEFORE DELETE ON cash_session BEGIN SELECT RAISE(ABORT, 'cash_session cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER cash_session_born_open BEFORE INSERT ON cash_session
WHEN NEW.reopened_by IS NOT NULL OR NEW.reopened_at IS NOT NULL OR NEW.reopen_reason IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a new cash_session has no reopen record'); END;
--> statement-breakpoint
CREATE TRIGGER cash_session_frozen BEFORE UPDATE OF id, collector_id, business_date, opening, created_at, created_by ON cash_session
BEGIN SELECT RAISE(ABORT, 'cash_session identity is fixed'); END;
--> statement-breakpoint
CREATE TRIGGER cash_session_open_update BEFORE UPDATE ON cash_session WHEN OLD.closed_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'reopen record is fixed while the session is open')
  WHERE NEW.closed_at IS NULL
    AND (NEW.reopened_by IS NOT OLD.reopened_by OR NEW.reopened_at IS NOT OLD.reopened_at
         OR NEW.reopen_reason IS NOT OLD.reopen_reason);
  SELECT RAISE(ABORT, 'closing must clear reopened_by and reopened_at')
  WHERE NEW.closed_at IS NOT NULL
    AND (NEW.reopened_by IS NOT NULL OR NEW.reopened_at IS NOT NULL OR NEW.reopen_reason IS NOT OLD.reopen_reason);
END;
--> statement-breakpoint
CREATE TRIGGER cash_session_close_only BEFORE UPDATE ON cash_session WHEN OLD.closed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash_session is closed; only a reopen with reason is allowed')
  WHERE NOT (
        NEW.closed_at IS NULL
    AND NEW.reopened_by IS NOT NULL AND NEW.reopened_at IS NOT NULL
    AND length(trim(coalesce(NEW.reopen_reason, ''))) > 0
    AND NEW.expected IS OLD.expected AND NEW.counted IS OLD.counted AND NEW.closed_by IS OLD.closed_by
  );
  -- Compared case-insensitively and with surrounding blanks ignored (the API also collapses inner
  -- runs of whitespace before comparing): "Recount " repeats "recount".
  SELECT RAISE(ABORT, 'reopen reason must differ from the previous reopen')
  WHERE lower(trim(NEW.reopen_reason)) = lower(trim(coalesce(OLD.reopen_reason, '')));
END;
--> statement-breakpoint
CREATE TRIGGER receipt_session_open BEFORE INSERT ON receipt WHEN NEW.cash_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash session is closed')
  WHERE (SELECT closed_at FROM cash_session WHERE id = NEW.cash_session_id) IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER expense_session_open BEFORE INSERT ON expense WHEN NEW.cash_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash session is closed')
  WHERE (SELECT closed_at FROM cash_session WHERE id = NEW.cash_session_id) IS NOT NULL;
END;
--> statement-breakpoint
CREATE TRIGGER transfer_session_open BEFORE INSERT ON transfer WHEN NEW.cash_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash session is closed')
  WHERE (SELECT closed_at FROM cash_session WHERE id = NEW.cash_session_id) IS NOT NULL;
END;
--> statement-breakpoint

-- Payroll maker-checker (PLAN §5.4, §14.8): draft -> approved -> paid, never backwards; lines freeze
-- with the approval; a salary is paid only against an approved (or already paid) slip, within its net.
CREATE TRIGGER payslip_no_delete BEFORE DELETE ON payslip BEGIN SELECT RAISE(ABORT, 'payslip cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER payslip_starts_draft BEFORE INSERT ON payslip WHEN NEW.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payslip must start as draft'); END;
--> statement-breakpoint
-- 'void' (a slip that will never be paid) is final and only reachable before any salary payment.
CREATE TRIGGER payslip_status_forward BEFORE UPDATE OF status ON payslip
WHEN NOT (NEW.status = OLD.status
          OR (OLD.status = 'draft' AND NEW.status = 'approved')
          OR (OLD.status = 'approved' AND NEW.status = 'paid')
          OR (OLD.status IN ('draft', 'approved') AND NEW.status = 'void'))
BEGIN SELECT RAISE(ABORT, 'payslip status only moves draft -> approved -> paid (or void before payment)'); END;
--> statement-breakpoint
CREATE TRIGGER payslip_void_unpaid BEFORE UPDATE OF status ON payslip
WHEN NEW.status = 'void' AND EXISTS (SELECT 1 FROM salary_payment WHERE payslip_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'a paid payslip cannot be voided'); END;
--> statement-breakpoint
CREATE TRIGGER payslip_frozen BEFORE UPDATE OF id, staff_id, period_key, created_at, created_by ON payslip
BEGIN SELECT RAISE(ABORT, 'payslip identity is fixed'); END;
--> statement-breakpoint
CREATE TRIGGER payslip_approver_frozen BEFORE UPDATE OF approved_by ON payslip
WHEN OLD.status <> 'draft' AND NEW.approved_by IS NOT OLD.approved_by
BEGIN SELECT RAISE(ABORT, 'payslip approver is fixed once approved'); END;
--> statement-breakpoint
CREATE TRIGGER payslip_line_insert_draft BEFORE INSERT ON payslip_line
BEGIN
  SELECT RAISE(ABORT, 'payslip is approved; lines are frozen')
  WHERE (SELECT status FROM payslip WHERE id = NEW.payslip_id) <> 'draft';
END;
--> statement-breakpoint
CREATE TRIGGER payslip_line_update_draft BEFORE UPDATE ON payslip_line
BEGIN
  SELECT RAISE(ABORT, 'payslip is approved; lines are frozen')
  WHERE (SELECT status FROM payslip WHERE id = OLD.payslip_id) <> 'draft'
     OR (SELECT status FROM payslip WHERE id = NEW.payslip_id) <> 'draft';
END;
--> statement-breakpoint
CREATE TRIGGER payslip_line_delete_draft BEFORE DELETE ON payslip_line
BEGIN
  SELECT RAISE(ABORT, 'payslip is approved; lines are frozen')
  WHERE (SELECT status FROM payslip WHERE id = OLD.payslip_id) <> 'draft';
END;
--> statement-breakpoint
CREATE TRIGGER salary_payment_needs_approval BEFORE INSERT ON salary_payment
BEGIN
  SELECT RAISE(ABORT, 'payslip is not approved')
  WHERE (SELECT status FROM payslip WHERE id = NEW.payslip_id) NOT IN ('approved', 'paid');
END;
--> statement-breakpoint
-- Salary paid against a slip never exceeds its net. Lines are positive (CHECK); basic and allowance
-- add, deduction and advance_recovery subtract. The net is fixed because lines freeze at approval.
CREATE TRIGGER salary_payment_within_net AFTER INSERT ON salary_payment
BEGIN
  SELECT RAISE(ABORT, 'salary payments exceed payslip net')
  WHERE (SELECT sum(amount) FROM salary_payment WHERE payslip_id = NEW.payslip_id)
      > (SELECT coalesce(sum(CASE WHEN kind IN ('basic', 'allowance') THEN amount ELSE -amount END), 0)
         FROM payslip_line WHERE payslip_id = NEW.payslip_id);
END;
--> statement-breakpoint

-- Receipt numbers never rewind or skip: the only update is next_no + 1 (PLAN §5.2 receipt batch).
CREATE TRIGGER receipt_series_monotonic BEFORE UPDATE ON receipt_series
WHEN NEW.next_no IS NOT OLD.next_no + 1 OR NEW.series IS NOT OLD.series OR NEW.year IS NOT OLD.year
BEGIN SELECT RAISE(ABORT, 'receipt_series only advances by one'); END;
--> statement-breakpoint
CREATE TRIGGER receipt_series_no_delete BEFORE DELETE ON receipt_series BEGIN SELECT RAISE(ABORT, 'receipt_series cannot be deleted'); END;
--> statement-breakpoint

-- History tables. Attendance corrections create a new register; marks are never edited.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER att_register_no_update BEFORE UPDATE ON att_register BEGIN SELECT RAISE(ABORT, 'att_register is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER att_register_no_delete BEFORE DELETE ON att_register BEGIN SELECT RAISE(ABORT, 'att_register is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER att_mark_no_update BEFORE UPDATE ON att_mark BEGIN SELECT RAISE(ABORT, 'att_mark is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER att_mark_no_delete BEFORE DELETE ON att_mark BEGIN SELECT RAISE(ABORT, 'att_mark is append-only'); END;
--> statement-breakpoint
-- The pointer only moves forward in client time (PLAN §5.1): a stale offline submission can never
-- overwrite a later office correction. The sync statement should carry the same WHERE; this is the backstop.
CREATE TRIGGER current_register_forward BEFORE UPDATE ON current_register
WHEN NOT (NEW.taken_at > OLD.taken_at)
  OR NEW.grp_id IS NOT OLD.grp_id OR NEW.date IS NOT OLD.date OR NEW.grp_subject_id IS NOT OLD.grp_subject_id
BEGIN SELECT RAISE(ABORT, 'current_register only moves forward'); END;
--> statement-breakpoint
CREATE TRIGGER current_register_no_delete BEFORE DELETE ON current_register BEGIN SELECT RAISE(ABORT, 'current_register cannot be deleted'); END;
--> statement-breakpoint

-- source: sql/30_ledger.sql
DROP VIEW IF EXISTS ledger_consistency;
--> statement-breakpoint
DROP VIEW IF EXISTS payer_credit;
--> statement-breakpoint
DROP VIEW IF EXISTS charge_status;
--> statement-breakpoint
DROP VIEW IF EXISTS charge_net;
--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_sums;
--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_shape;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_within_credit;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_reversal_shape;
--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_negative_within_net;
--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_parent_shape;
--> statement-breakpoint
-- Ledger invariants and derived views (experiment 1, hardened after the M0 review; ADR 0002).
-- Re-emitted in full by migration 0009 after 0008 rebuilt `receipt` (receipt kind 'opening', M3), and
-- by 0011 after 0010 rebuilt it again (methods 'cheque', 'other').
-- Charge tree: only `fee` rows are roots. concession / fine / reversal hang off a fee; fine_waiver (and a
-- reversal of a fine) hang off the fine, so a tree is at most two levels deep. Net = sum of the tree.
-- Allocations always target the root. Kind signs and the root rule are CHECKs on the table.

-- Children: right parent kind, same student and payer as the parent.
-- Concessions and fines belong to the family (PLAN §14.7: a sponsor is billed its share of the net and
-- is never fined); a sponsor root only ever takes a `reversal` child (a re-bill or a void). A fine is
-- only added to a root that still has money due.
CREATE TRIGGER charge_parent_shape BEFORE INSERT ON charge WHEN NEW.parent_charge_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid parent charge for this kind')
  WHERE NOT EXISTS (
    SELECT 1 FROM charge p
    WHERE p.id = NEW.parent_charge_id
      AND p.student_id = NEW.student_id AND p.payer_type = NEW.payer_type AND p.payer_id = NEW.payer_id
      AND CASE NEW.kind
            WHEN 'fine_waiver' THEN p.kind = 'fine'
            WHEN 'reversal' THEN p.kind IN ('fee', 'fine')
            ELSE p.kind = 'fee'
          END
  );
  SELECT RAISE(ABORT, 'concessions and fines are family lines; a sponsor root takes reversals only')
  WHERE NEW.kind IN ('concession', 'fine') AND NEW.payer_type <> 'family';
  SELECT RAISE(ABORT, 'a fine needs money still due on the fee')
  WHERE NEW.kind = 'fine'
    AND (SELECT coalesce(sum(amount), 0) FROM charge
         WHERE id = NEW.parent_charge_id OR parent_charge_id = NEW.parent_charge_id
            OR parent_charge_id IN (SELECT id FROM charge WHERE parent_charge_id = NEW.parent_charge_id))
      <= (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE charge_id = NEW.parent_charge_id);
END;
--> statement-breakpoint

-- A negative line can only take away what is still there: the parent's own subtree stays >= 0
-- (a fine_waiver never waives more than the fine), and the root's net never drops below what has
-- already been allocated to it. To cut a paid fee, release the allocation first, in the same batch.
CREATE TRIGGER charge_negative_within_net AFTER INSERT ON charge WHEN NEW.amount < 0
BEGIN
  SELECT RAISE(ABORT, 'line exceeds remaining net')
  WHERE (SELECT sum(amount) FROM charge
         WHERE id = NEW.parent_charge_id OR parent_charge_id = NEW.parent_charge_id
            OR parent_charge_id IN (SELECT id FROM charge WHERE parent_charge_id = NEW.parent_charge_id)) < 0;
  SELECT RAISE(ABORT, 'net would fall below allocated; release the allocation first')
  FROM (SELECT coalesce(parent_charge_id, id) AS root FROM charge WHERE id = NEW.parent_charge_id) r
  WHERE (SELECT sum(amount) FROM charge
         WHERE id = r.root OR parent_charge_id = r.root
            OR parent_charge_id IN (SELECT id FROM charge WHERE parent_charge_id = r.root))
      < (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE charge_id = r.root);
END;
--> statement-breakpoint

-- Reversal shape: mirrors exactly one payment (never a reversal or refund): same payer, same method,
-- exactly the negative amount. reverses_id is UNIQUE, so a payment is reversed at most once.
CREATE TRIGGER receipt_reversal_shape BEFORE INSERT ON receipt WHEN NEW.kind = 'reversal'
BEGIN
  SELECT RAISE(ABORT, 'reversal must mirror a payment exactly')
  WHERE NOT EXISTS (
    SELECT 1 FROM receipt o
    WHERE o.id = NEW.reverses_id AND o.kind = 'payment' AND o.amount = -NEW.amount
      AND o.payer_type = NEW.payer_type AND o.payer_id = NEW.payer_id AND o.method = NEW.method
  );
END;
--> statement-breakpoint

-- Payer credit (unallocated money) = Σ receipts (payment + reversal + refund, signed) − Σ allocations
-- (signed), per payer. It never goes below zero: a refund pays out at most the credit, and a positive
-- allocation (alloc_sums, below) spends at most the credit.
-- A reversal is inserted BEFORE its unwind allocations (they reference it), so at insert time its effect
-- is checked ASSUMING the unwinds follow in the same batch — packages/db/src/ledger reverseReceipt is the
-- only writer and always does this. The unwinds give back exactly what the payment still has allocated,
-- so: credit_now − |payment| + Σ payment allocations must stay >= 0 (e.g. a refund already paid that
-- credit out). A reversal inserted without its unwinds shows up in the ledger_consistency view.
CREATE TRIGGER receipt_within_credit AFTER INSERT ON receipt WHEN NEW.kind IN ('refund', 'reversal')
BEGIN
  SELECT RAISE(ABORT, 'refund exceeds unallocated credit')
  WHERE NEW.kind = 'refund'
    AND (SELECT coalesce(sum(amount), 0) FROM receipt
         WHERE payer_type = NEW.payer_type AND payer_id = NEW.payer_id)
      - (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
         WHERE r.payer_type = NEW.payer_type AND r.payer_id = NEW.payer_id) < 0;
  SELECT RAISE(ABORT, 'reversal would leave negative payer credit; the money was already paid out')
  WHERE NEW.kind = 'reversal'
    AND (SELECT coalesce(sum(amount), 0) FROM receipt
         WHERE payer_type = NEW.payer_type AND payer_id = NEW.payer_id)
      - (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
         WHERE r.payer_type = NEW.payer_type AND r.payer_id = NEW.payer_id)
      + (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE receipt_id = NEW.reverses_id) < 0;
END;
--> statement-breakpoint

CREATE TRIGGER alloc_shape BEFORE INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'allocation must target a root charge')
  WHERE (SELECT parent_charge_id FROM charge WHERE id = NEW.charge_id) IS NOT NULL;
  SELECT RAISE(ABORT, 'allocation payer must match the charge payer')
  WHERE NOT EXISTS (
    SELECT 1 FROM receipt r JOIN charge c ON c.id = NEW.charge_id
    WHERE r.id = NEW.receipt_id AND r.payer_type = c.payer_type AND r.payer_id = c.payer_id
  );
  SELECT RAISE(ABORT, 'a refund takes no allocations')
  WHERE (SELECT kind FROM receipt WHERE id = NEW.receipt_id) = 'refund';
  SELECT RAISE(ABORT, 'receipt has been reversed')
  WHERE EXISTS (SELECT 1 FROM receipt WHERE reverses_id = NEW.receipt_id);
END;
--> statement-breakpoint

-- Per (receipt, charge) pair, running sums decide (a negative row on a payment is a *release*):
--   payment (and opening credit, which behaves like one):  0 <= pair sum, sum over the receipt <= receipt amount, payer credit stays >= 0;
--   reversal: pair sum <= 0, and |pair sum| <= the reversed payment's pair sum on that charge.
-- One trigger so the checks run in a fixed order (the first violated rule names the error).
CREATE TRIGGER alloc_sums AFTER INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'release exceeds what this receipt allocated to the charge')
  FROM receipt r, (SELECT sum(amount) AS pair FROM receipt_allocation
                   WHERE receipt_id = NEW.receipt_id AND charge_id = NEW.charge_id) p
  WHERE r.id = NEW.receipt_id AND r.kind IN ('payment', 'opening') AND p.pair < 0;
  SELECT RAISE(ABORT, 'reversal can only unwind what the original allocated')
  FROM receipt r, (SELECT sum(amount) AS pair FROM receipt_allocation
                   WHERE receipt_id = NEW.receipt_id AND charge_id = NEW.charge_id) p
  WHERE r.id = NEW.receipt_id AND r.kind = 'reversal'
    AND (p.pair > 0
         OR -p.pair > (SELECT coalesce(sum(amount), 0) FROM receipt_allocation
                       WHERE receipt_id = r.reverses_id AND charge_id = NEW.charge_id));
  SELECT RAISE(ABORT, 'allocations exceed receipt amount')
  WHERE (SELECT abs(sum(amount)) FROM receipt_allocation WHERE receipt_id = NEW.receipt_id)
      > (SELECT abs(amount) FROM receipt WHERE id = NEW.receipt_id);
  -- Sum of allocations to a root charge <= its net (the whole tree).
  SELECT RAISE(ABORT, 'allocation exceeds charge net')
  WHERE (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE charge_id = NEW.charge_id)
      > (SELECT coalesce(sum(amount), 0) FROM charge
         WHERE id = NEW.charge_id OR parent_charge_id = NEW.charge_id
            OR parent_charge_id IN (SELECT id FROM charge WHERE parent_charge_id = NEW.charge_id));
  -- A positive row spends payer credit; it may not spend credit that was refunded or reversed away.
  SELECT RAISE(ABORT, 'allocation exceeds payer credit')
  FROM receipt p
  WHERE NEW.amount > 0 AND p.id = NEW.receipt_id
    AND (SELECT coalesce(sum(amount), 0) FROM receipt
         WHERE payer_type = p.payer_type AND payer_id = p.payer_id)
      - (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
         WHERE r.payer_type = p.payer_type AND r.payer_id = p.payer_id) < 0;
END;
--> statement-breakpoint

-- No stored balances anywhere: net, paid, due and credit are always derived.
CREATE VIEW charge_net AS
SELECT c.id, c.student_id, c.fee_head_id, c.period_key, c.payer_type, c.payer_id, c.due_date, c.kind,
       (SELECT coalesce(sum(x.amount), 0) FROM charge x
        WHERE x.id = c.id OR x.parent_charge_id = c.id
           OR x.parent_charge_id IN (SELECT y.id FROM charge y WHERE y.parent_charge_id = c.id)) AS net,
       (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a WHERE a.charge_id = c.id) AS paid
FROM charge c
WHERE c.parent_charge_id IS NULL;
--> statement-breakpoint

-- "Today" is the school day in Asia/Karachi (UTC+5, no DST), not the UTC date.
CREATE VIEW charge_status AS
SELECT *, net - paid AS due,
       CASE WHEN net - paid <= 0 THEN 'paid'
            WHEN paid > 0 THEN 'partial'
            WHEN due_date < date('now', '+5 hours') THEN 'overdue'
            ELSE 'due' END AS status
FROM charge_net;
--> statement-breakpoint

-- Unallocated credit per payer = receipts in (payments, reversals, refunds) - allocations.
CREATE VIEW payer_credit AS
SELECT r.payer_type, r.payer_id,
       sum(r.amount) - coalesce((SELECT sum(a.amount) FROM receipt_allocation a JOIN receipt ra ON ra.id = a.receipt_id
                                 WHERE ra.payer_type = r.payer_type AND ra.payer_id = r.payer_id), 0) AS credit
FROM receipt r
GROUP BY r.payer_type, r.payer_id;
--> statement-breakpoint

-- Rows that should never exist if every write went through the ledger helpers. Empty when healthy;
-- the nightly alarm on it is M6. For a payment (or opening credit), `expected` is the upper bound.
CREATE VIEW ledger_consistency AS
SELECT 'negative_credit' AS issue, payer_type, payer_id, NULL AS receipt_id, 0 AS expected, credit AS actual
FROM payer_credit
WHERE credit < 0
UNION ALL
SELECT issue, payer_type, payer_id, receipt_id, expected, actual
FROM (SELECT r.kind || '_allocations' AS issue, r.payer_type, r.payer_id, r.id AS receipt_id,
             CASE r.kind
               WHEN 'reversal' THEN -(SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a
                                      WHERE a.receipt_id = r.reverses_id)
               WHEN 'refund' THEN 0
               ELSE r.amount END AS expected,
             (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a WHERE a.receipt_id = r.id) AS actual
      FROM receipt r) x
WHERE CASE WHEN issue IN ('payment_allocations', 'opening_allocations') THEN actual < 0 OR actual > expected
           ELSE actual <> expected END;
--> statement-breakpoint

-- source: sql/40_foundation.sql
DROP TRIGGER IF EXISTS user_keep_owner;
--> statement-breakpoint
DROP TRIGGER IF EXISTS role_keep_owner;
--> statement-breakpoint
DROP INDEX IF EXISTS enrolment_roll_once;
--> statement-breakpoint
DROP INDEX IF EXISTS session_one_current;
--> statement-breakpoint
-- Milestone 1 rules: people, sessions, enrolment numbering. Same style as the ledger rules: the
-- database refuses the impossible state, app code maps the message text to a clean 409.
-- Re-emitted by migration 0011: 0010 rebuilt `role` (explicit ON DELETE RESTRICT on user_id), which
-- dropped the role triggers below.

-- Exactly zero or one current academic session; "set current" flips it inside one batch.
CREATE UNIQUE INDEX session_one_current ON session(is_current) WHERE is_current = 1;
--> statement-breakpoint

-- A roll number is unique among the active enrolments of a group (auto = max + 1, or typed by hand).
-- (Re-emitted after migration 0004 rebuilt `enrolment`, which dropped this index with the table.)
CREATE UNIQUE INDEX enrolment_roll_once ON enrolment(grp_id, roll_no) WHERE status = 'active' AND roll_no IS NOT NULL;
--> statement-breakpoint

-- At least one active owner must remain (PLAN §5.4: only an owner manages roles, so losing the last
-- one locks the installation with no way back short of editing the database). Covers both ways an
-- owner stops counting: the role row is removed, or the user is disabled.
CREATE TRIGGER role_keep_owner BEFORE DELETE ON role
WHEN OLD.role = 'owner' AND NOT EXISTS (
  SELECT 1 FROM role r JOIN "user" u ON u.id = r.user_id
  WHERE r.role = 'owner' AND u.status = 'active' AND r.user_id <> OLD.user_id
)
BEGIN SELECT RAISE(ABORT, 'last_owner: at least one active owner must remain'); END;
--> statement-breakpoint

CREATE TRIGGER user_keep_owner BEFORE UPDATE OF status ON "user"
WHEN OLD.status = 'active' AND NEW.status <> 'active'
  AND EXISTS (SELECT 1 FROM role WHERE user_id = OLD.id AND role = 'owner')
  AND NOT EXISTS (
    SELECT 1 FROM role r JOIN "user" u ON u.id = r.user_id
    WHERE r.role = 'owner' AND u.status = 'active' AND r.user_id <> OLD.id
  )
BEGIN SELECT RAISE(ABORT, 'last_owner: at least one active owner must remain'); END;
--> statement-breakpoint

-- source: sql/50_fees.sql
DROP TRIGGER IF EXISTS receipt_payment_shape;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_opening_shape;
--> statement-breakpoint
DROP TRIGGER IF EXISTS sponsorship_end_once;
--> statement-breakpoint
DROP TRIGGER IF EXISTS sponsorship_frozen;
--> statement-breakpoint
DROP TRIGGER IF EXISTS sponsorship_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS concession_end_shape;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_chunk_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_chunk_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_chunk_status;
--> statement-breakpoint
DROP TRIGGER IF EXISTS billing_run_period_format;
--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_period_format;
--> statement-breakpoint
-- Milestone 3 fee rules (PLAN §5.2, §14.5, §14.7). Same style as the ledger: the database refuses
-- the impossible state, the API maps the message text to a 409.

-- period_key is `YYYY-MM` everywhere (charges, fines, billing runs); generation and the register
-- compare it as text, so a stray `2026-1` would silently fall out of every report.
CREATE TRIGGER charge_period_format BEFORE INSERT ON charge
WHEN NEW.period_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
  OR substr(NEW.period_key, 6, 2) NOT BETWEEN '01' AND '12'
BEGIN SELECT RAISE(ABORT, 'period_key must be YYYY-MM'); END;
--> statement-breakpoint
CREATE TRIGGER billing_run_period_format BEFORE INSERT ON billing_run
WHEN NEW.period_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
  OR substr(NEW.period_key, 6, 2) NOT BETWEEN '01' AND '12'
BEGIN SELECT RAISE(ABORT, 'period_key must be YYYY-MM'); END;
--> statement-breakpoint

-- The generation log is history: one row per request, never changed. A failed chunk (status
-- 'failed') carries the error code; it wrote nothing else and the cron retries it next tick.
CREATE TRIGGER billing_chunk_status BEFORE INSERT ON billing_chunk
WHEN NEW.status NOT IN ('ok', 'failed') OR (NEW.status = 'failed') <> (NEW.error_code IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'billing_chunk status is ok, or failed with an error code'); END;
--> statement-breakpoint
CREATE TRIGGER billing_chunk_no_update BEFORE UPDATE ON billing_chunk BEGIN SELECT RAISE(ABORT, 'billing_chunk is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER billing_chunk_no_delete BEFORE DELETE ON billing_chunk BEGIN SELECT RAISE(ABORT, 'billing_chunk is append-only'); END;
--> statement-breakpoint

-- Ending a concession is the one permitted update (20_append_only.sql freezes the rest): it says
-- when, who and why, all three or none.
CREATE TRIGGER concession_end_shape BEFORE UPDATE OF ended_at, ended_by, end_reason ON concession
WHEN OLD.ended_at IS NULL
  AND (NEW.ended_at IS NULL OR NEW.ended_by IS NULL OR length(trim(coalesce(NEW.end_reason, ''))) = 0)
BEGIN SELECT RAISE(ABORT, 'ending a concession needs a date, who and a reason'); END;
--> statement-breakpoint

-- Sponsorships are history too: the only change is closing one (valid_to), once.
CREATE TRIGGER sponsorship_no_delete BEFORE DELETE ON sponsorship BEGIN SELECT RAISE(ABORT, 'sponsorship cannot be deleted; end it'); END;
--> statement-breakpoint
CREATE TRIGGER sponsorship_frozen BEFORE UPDATE OF id, sponsor_id, student_id, fee_head_id, share_pct, valid_from, created_at, created_by ON sponsorship
BEGIN SELECT RAISE(ABORT, 'sponsorship is never edited; end it and add a new row'); END;
--> statement-breakpoint
CREATE TRIGGER sponsorship_end_once BEFORE UPDATE OF valid_to ON sponsorship
WHEN OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL OR NEW.valid_to < OLD.valid_from
BEGIN SELECT RAISE(ABORT, 'sponsorship already ended'); END;
--> statement-breakpoint

-- Opening balance credit (receipt kind 'opening') is carry-in, not money: once per payer and
-- recorded against an opening_balance row; it never takes a series number or a cash session.
CREATE TRIGGER receipt_opening_shape BEFORE INSERT ON receipt WHEN NEW.kind = 'opening'
BEGIN
  SELECT RAISE(ABORT, 'opening credit must match an opening balance')
  WHERE NOT EXISTS (SELECT 1 FROM opening_balance o JOIN student s ON s.id = o.student_id
                    WHERE NEW.idempotency_key = 'opening:' || o.student_id AND o.amount = -NEW.amount
                      AND NEW.payer_type = 'family' AND s.family_id = NEW.payer_id);
END;
--> statement-breakpoint

-- Payment shape (M3 fix pass). Cash goes through a drawer: it needs the collector's cash session, and
-- its number is the one the series row was bumped to in the same batch (so a hand-typed number, or a
-- number from no series, is refused). Money that never touches a drawer (bank, wallets, cheque) names
-- the account it landed in and takes no session.
CREATE TRIGGER receipt_payment_shape BEFORE INSERT ON receipt WHEN NEW.kind = 'payment'
BEGIN
  SELECT RAISE(ABORT, 'a cash payment needs a cash session')
  WHERE NEW.method = 'cash' AND NEW.cash_session_id IS NULL;
  SELECT RAISE(ABORT, 'receipt number must be the next number of its series')
  WHERE NEW.method = 'cash' AND NOT EXISTS (
    SELECT 1 FROM receipt_series s
    WHERE NEW.receipt_no = s.series || '-' || s.year || '-' || printf('%05d', s.next_no - 1)
      AND NEW.receipt_no GLOB '*-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9]*');
  SELECT RAISE(ABORT, 'a non-cash payment names its account and takes no cash session')
  WHERE NEW.method <> 'cash' AND (NEW.account_id IS NULL OR NEW.cash_session_id IS NOT NULL);
END;

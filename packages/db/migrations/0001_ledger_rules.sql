-- source: sql/10_indexes.sql
-- Partial unique indexes: Drizzle's SQLite generator does not emit WHERE clauses we can rely on.

-- PLAN §4 "the one rule": at most one active primary enrolment (the school class) per student.
CREATE UNIQUE INDEX one_primary ON enrolment(student_id) WHERE is_primary = 1 AND status = 'active';
--> statement-breakpoint

-- Idempotent fee generation: re-running a month cannot bill the same fee twice.
CREATE UNIQUE INDEX charge_fee_once ON charge(student_id, fee_head_id, period_key, payer_id) WHERE kind = 'fee';
--> statement-breakpoint

-- A late fine is charged at most once per parent charge and period (fines always have a parent).
CREATE UNIQUE INDEX charge_fine_once ON charge(parent_charge_id, period_key) WHERE kind = 'fine';
--> statement-breakpoint

-- source: sql/20_append_only.sql
-- Money is append-only (PLAN §5.2). Corrections are new rows (reversal, concession end + new row, void).
-- RAISE(ABORT) inside a D1 batch rolls back the whole batch; app code matches on the message text.

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
-- with reopened_by/at/reason, every other column unchanged. variance is a generated column.
CREATE TRIGGER cash_session_no_delete BEFORE DELETE ON cash_session BEGIN SELECT RAISE(ABORT, 'cash_session cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER cash_session_frozen BEFORE UPDATE OF id, collector_id, business_date, opening, created_at, created_by ON cash_session
BEGIN SELECT RAISE(ABORT, 'cash_session identity is fixed'); END;
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
-- with the approval; a salary is paid only against an approved (or already paid) slip.
CREATE TRIGGER payslip_no_delete BEFORE DELETE ON payslip BEGIN SELECT RAISE(ABORT, 'payslip cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER payslip_starts_draft BEFORE INSERT ON payslip WHEN NEW.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'payslip must start as draft'); END;
--> statement-breakpoint
CREATE TRIGGER payslip_status_forward BEFORE UPDATE OF status ON payslip
WHEN NOT (NEW.status = OLD.status
          OR (OLD.status = 'draft' AND NEW.status = 'approved')
          OR (OLD.status = 'approved' AND NEW.status = 'paid'))
BEGIN SELECT RAISE(ABORT, 'payslip status only moves draft -> approved -> paid'); END;
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
-- Ledger invariants and derived views (experiment 1, hardened after the M0 review; ADR 0002).
-- Charge tree: only `fee` rows are roots. concession / fine / reversal hang off a fee; fine_waiver (and a
-- reversal of a fine) hang off the fine, so a tree is at most two levels deep. Net = sum of the tree.
-- Allocations always target the root. Kind signs and the root rule are CHECKs on the table.

-- Children: right parent kind, same student and payer as the parent.
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

-- A refund pays credit back out; it can never exceed the payer's unallocated credit.
CREATE TRIGGER receipt_refund_within_credit AFTER INSERT ON receipt WHEN NEW.kind = 'refund'
BEGIN
  SELECT RAISE(ABORT, 'refund exceeds unallocated credit')
  WHERE (SELECT credit FROM payer_credit WHERE payer_type = NEW.payer_type AND payer_id = NEW.payer_id) < 0;
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
--   payment:  0 <= pair sum, and sum over the receipt <= receipt amount;
--   reversal: pair sum <= 0, and |pair sum| <= the reversed payment's pair sum on that charge.
-- One trigger so the checks run in a fixed order (the first violated rule names the error).
CREATE TRIGGER alloc_sums AFTER INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'release exceeds what this receipt allocated to the charge')
  FROM receipt r, (SELECT sum(amount) AS pair FROM receipt_allocation
                   WHERE receipt_id = NEW.receipt_id AND charge_id = NEW.charge_id) p
  WHERE r.id = NEW.receipt_id AND r.kind = 'payment' AND p.pair < 0;
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

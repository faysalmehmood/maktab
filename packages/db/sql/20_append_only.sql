-- Money is append-only (PLAN §5.2). Corrections are new rows (reversal, concession end + new row, void).
-- RAISE(ABORT) inside a D1 batch rolls back the whole batch; app code matches on the message text.
-- Re-emitted by migration 0009: 0008 rebuilt `receipt`, which dropped the receipt triggers below.

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
  SELECT RAISE(ABORT, 'reopen reason must differ from the previous reopen')
  WHERE trim(NEW.reopen_reason) = trim(coalesce(OLD.reopen_reason, ''));
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

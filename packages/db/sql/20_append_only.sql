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

CREATE TRIGGER cash_session_no_delete BEFORE DELETE ON cash_session BEGIN SELECT RAISE(ABORT, 'cash_session cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER cash_session_frozen BEFORE UPDATE OF id, collector_id, business_date, opening, created_at, created_by ON cash_session
BEGIN SELECT RAISE(ABORT, 'cash_session identity is fixed'); END;
--> statement-breakpoint

CREATE TRIGGER payslip_no_delete BEFORE DELETE ON payslip BEGIN SELECT RAISE(ABORT, 'payslip cannot be deleted'); END;
--> statement-breakpoint

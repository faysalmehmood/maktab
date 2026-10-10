-- source: sql/10_indexes.sql
-- Partial unique indexes: Drizzle's SQLite generator does not emit WHERE clauses we can rely on.

-- PLAN §4 "the one rule": at most one active primary enrolment (the school class) per student.
CREATE UNIQUE INDEX one_primary ON enrolment(student_id) WHERE is_primary = 1 AND status = 'active';
--> statement-breakpoint

-- Idempotent fee generation: re-running a month cannot bill the same fee twice.
CREATE UNIQUE INDEX charge_fee_once ON charge(student_id, fee_head_id, period_key, payer_id) WHERE kind = 'fee';
--> statement-breakpoint

-- A late fine is charged at most once per parent charge and period.
CREATE UNIQUE INDEX charge_fine_once ON charge(parent_charge_id, period_key) WHERE kind = 'fine' AND parent_charge_id IS NOT NULL;
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

CREATE TRIGGER cash_session_no_delete BEFORE DELETE ON cash_session BEGIN SELECT RAISE(ABORT, 'cash_session cannot be deleted'); END;
--> statement-breakpoint
CREATE TRIGGER cash_session_frozen BEFORE UPDATE OF id, collector_id, business_date, opening, created_at, created_by ON cash_session
BEGIN SELECT RAISE(ABORT, 'cash_session identity is fixed'); END;
--> statement-breakpoint

CREATE TRIGGER payslip_no_delete BEFORE DELETE ON payslip BEGIN SELECT RAISE(ABORT, 'payslip cannot be deleted'); END;
--> statement-breakpoint

-- source: sql/30_ledger.sql
-- Ledger invariants and derived views (proven in experiment 1, local and remote D1).
-- Root-charge rule: a root charge has parent_charge_id NULL; concession/fine/fine_waiver/reversal lines
-- hang off it. Net is computed per root; allocations always target the root.

-- Child lines hang off a root, never off another child, so net needs exactly one level of folding.
CREATE TRIGGER charge_parent_is_root BEFORE INSERT ON charge WHEN NEW.parent_charge_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'parent charge must be a root charge')
  WHERE (SELECT parent_charge_id FROM charge WHERE id = NEW.parent_charge_id) IS NOT NULL;
END;
--> statement-breakpoint

CREATE TRIGGER alloc_root_only BEFORE INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'allocation must target a root charge')
  WHERE (SELECT parent_charge_id FROM charge WHERE id = NEW.charge_id) IS NOT NULL;
END;
--> statement-breakpoint

-- Invariant A: |sum(allocations of a receipt)| <= |receipt amount| (sign-aware for reversals).
CREATE TRIGGER alloc_within_receipt AFTER INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'allocations exceed receipt amount')
  WHERE (SELECT abs(coalesce(sum(amount), 0)) FROM receipt_allocation WHERE receipt_id = NEW.receipt_id)
      > (SELECT abs(amount) FROM receipt WHERE id = NEW.receipt_id);
END;
--> statement-breakpoint

-- Invariant B: sum(allocations to a root charge) <= its net (itself + its child lines).
CREATE TRIGGER alloc_within_charge AFTER INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'allocation exceeds charge net')
  WHERE (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE charge_id = NEW.charge_id)
      > (SELECT coalesce(sum(amount), 0) FROM charge WHERE id = NEW.charge_id OR parent_charge_id = NEW.charge_id);
END;
--> statement-breakpoint

-- No stored balances anywhere: net, paid and due are always derived.
CREATE VIEW charge_net AS
SELECT c.id, c.student_id, c.fee_head_id, c.period_key, c.payer_type, c.payer_id, c.due_date, c.kind,
       (SELECT coalesce(sum(x.amount), 0) FROM charge x WHERE x.id = c.id OR x.parent_charge_id = c.id) AS net,
       (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a WHERE a.charge_id = c.id) AS paid
FROM charge c
WHERE c.parent_charge_id IS NULL AND c.kind IN ('fee', 'fine');
--> statement-breakpoint

-- "Today" is the school day in Asia/Karachi (UTC+5, no DST), not the UTC date.
CREATE VIEW charge_status AS
SELECT *, net - paid AS due,
       CASE WHEN net - paid <= 0 THEN 'paid'
            WHEN paid > 0 THEN 'partial'
            WHEN due_date < date('now', '+5 hours') THEN 'overdue'
            ELSE 'due' END AS status
FROM charge_net;

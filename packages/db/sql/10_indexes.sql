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

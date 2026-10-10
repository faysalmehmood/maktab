-- source: sql/10_indexes.sql
DROP INDEX IF EXISTS charge_fine_once;
--> statement-breakpoint
DROP INDEX IF EXISTS charge_fee_once;
--> statement-breakpoint
DROP INDEX IF EXISTS one_primary;
--> statement-breakpoint
-- Partial unique indexes: Drizzle's SQLite generator does not emit WHERE clauses we can rely on.
-- Re-emitted after migration 0004 rebuilt `enrolment` (SQLite drops a table's indexes with it).

-- PLAN §4 "the one rule": at most one active primary enrolment (the school class) per student.
CREATE UNIQUE INDEX one_primary ON enrolment(student_id) WHERE is_primary = 1 AND status = 'active';
--> statement-breakpoint

-- Idempotent fee generation: re-running a month cannot bill the same fee twice.
CREATE UNIQUE INDEX charge_fee_once ON charge(student_id, fee_head_id, period_key, payer_id) WHERE kind = 'fee';
--> statement-breakpoint

-- A late fine is charged at most once per parent charge and period (fines always have a parent).
CREATE UNIQUE INDEX charge_fine_once ON charge(parent_charge_id, period_key) WHERE kind = 'fine';
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

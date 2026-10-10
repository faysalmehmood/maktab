-- source: sql/50_fees.sql
DROP TRIGGER IF EXISTS sponsorship_no_overlap;
--> statement-breakpoint
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
-- 'failed') carries the error code; it wrote nothing else and the cron retries it next tick. A
-- 'reopened' row (M4 fix pass, owner/admin "Re-open period" for a group finished with no fees, e.g.
-- rates added late) is a fresh cursor: not done, no next student, nothing written.
CREATE TRIGGER billing_chunk_status BEFORE INSERT ON billing_chunk
WHEN NEW.status NOT IN ('ok', 'failed', 'reopened') OR (NEW.status = 'failed') <> (NEW.error_code IS NOT NULL)
  OR (NEW.status = 'reopened' AND (NEW.done <> 0 OR NEW.next_student_id IS NOT NULL OR NEW.grp_id IS NULL))
BEGIN SELECT RAISE(ABORT, 'billing_chunk status is ok, failed with an error code, or a reopened group'); END;
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

-- Money shape (M3 fix pass; refunds and reversals added in the M3a closing pass). Every receipt that
-- moves money — payment, refund, reversal — is numbered from its series: its number is the one the
-- series row was bumped to in the same batch (a hand-typed number, or one from no series, is refused).
-- Cash goes through a drawer: it needs the cash session. Money that never touches a drawer (bank,
-- wallets, cheque, other) names the account and takes no session. (Opening credit is not money: see
-- receipt_opening_shape.)
CREATE TRIGGER receipt_payment_shape BEFORE INSERT ON receipt
WHEN NEW.kind IN ('payment', 'refund', 'reversal')
BEGIN
  SELECT RAISE(ABORT, 'a cash receipt needs a cash session')
  WHERE NEW.method = 'cash' AND NEW.cash_session_id IS NULL;
  SELECT RAISE(ABORT, 'receipt number must be the next number of its series')
  WHERE NOT EXISTS (
    SELECT 1 FROM receipt_series s
    WHERE NEW.receipt_no = s.series || '-' || s.year || '-' || printf('%05d', s.next_no - 1)
      AND NEW.receipt_no GLOB '*-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9]*');
  SELECT RAISE(ABORT, 'a non-cash receipt names its account and takes no cash session')
  WHERE NEW.method <> 'cash' AND (NEW.account_id IS NULL OR NEW.cash_session_id IS NOT NULL);
END;
--> statement-breakpoint

-- One sponsor, one student, one head (a NULL head covers every head): validity periods never overlap
-- (M3a closing pass). The API checks first for a clean 409; this is the backstop two parallel
-- requests cannot both pass. To change a share, end the old row and add a new one.
CREATE TRIGGER sponsorship_no_overlap BEFORE INSERT ON sponsorship
BEGIN
  SELECT RAISE(ABORT, 'sponsorship overlaps another for this sponsor and student')
  WHERE EXISTS (
    SELECT 1 FROM sponsorship o
    WHERE o.sponsor_id = NEW.sponsor_id AND o.student_id = NEW.student_id
      AND (o.fee_head_id IS NULL OR NEW.fee_head_id IS NULL OR o.fee_head_id = NEW.fee_head_id)
      AND o.valid_from <= coalesce(NEW.valid_to, '9999-12-31')
      AND (o.valid_to IS NULL OR o.valid_to >= NEW.valid_from));
END;

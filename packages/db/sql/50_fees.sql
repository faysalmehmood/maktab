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

-- The generation log is history: one row per request, never changed.
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

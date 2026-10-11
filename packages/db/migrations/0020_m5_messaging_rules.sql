-- source: sql/70_messaging.sql
-- Milestone 5: messaging (PLAN §5.3, §7, §14.9, §14.10). Same style as the ledger: the database refuses
-- the impossible state, the API maps the message text to a 409.

-- A queued message ends exactly once: sent (by someone, at a time) or skipped (with a reason). It never
-- goes back to the queue, and a skipped row stays skipped (wa_api delivery states may follow a send).
CREATE TRIGGER message_status_flow BEFORE UPDATE OF status ON message
WHEN NEW.status IS NOT OLD.status
  AND (NEW.status = 'queued' OR OLD.status = 'skipped'
       OR (OLD.status <> 'queued' AND NEW.status = 'skipped'))
BEGIN SELECT RAISE(ABORT, 'message is no longer queued'); END;
--> statement-breakpoint
CREATE TRIGGER message_end_shape BEFORE UPDATE OF status ON message
WHEN (NEW.status = 'sent' AND OLD.status = 'queued' AND NEW.sent_at IS NULL)
  OR (NEW.status = 'skipped' AND length(trim(coalesce(NEW.skipped_reason, ''))) = 0)
BEGIN SELECT RAISE(ABORT, 'a sent message needs a time; a skipped one a reason'); END;
--> statement-breakpoint

-- Parent links: the token is never edited (rotate = revoke + a new row), a revocation is final, and a
-- guardian has at most one live (unrevoked) link.
CREATE TRIGGER parent_link_frozen BEFORE UPDATE OF id, guardian_id, token_hash, token_salt, created_at, created_by ON parent_link
BEGIN SELECT RAISE(ABORT, 'parent link token is never edited; rotate it'); END;
--> statement-breakpoint
CREATE TRIGGER parent_link_revoke_once BEFORE UPDATE OF revoked_at ON parent_link
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN SELECT RAISE(ABORT, 'parent link already revoked'); END;
--> statement-breakpoint
CREATE TRIGGER parent_link_no_delete BEFORE DELETE ON parent_link BEGIN SELECT RAISE(ABORT, 'parent link cannot be deleted; revoke it'); END;
--> statement-breakpoint
CREATE UNIQUE INDEX parent_link_one_live ON parent_link (guardian_id) WHERE revoked_at IS NULL;

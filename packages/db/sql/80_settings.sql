-- M6 fix pass: the recycle bin's archived groups (grp.archived_at). An archived group takes no
-- enrolment, by any path (admission, re-admission, transfer, CSV import, a direct write), and a group
-- with enrolments is never archived even when the archive races an admission.

CREATE TRIGGER enrolment_grp_archived BEFORE INSERT ON enrolment
WHEN (SELECT archived_at FROM grp WHERE id = NEW.grp_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'group_archived: an archived group takes no enrolment'); END;
--> statement-breakpoint

CREATE TRIGGER enrolment_grp_archived_move BEFORE UPDATE OF grp_id ON enrolment
WHEN NEW.grp_id IS NOT OLD.grp_id AND (SELECT archived_at FROM grp WHERE id = NEW.grp_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'group_archived: an archived group takes no enrolment'); END;
--> statement-breakpoint

CREATE TRIGGER grp_archive_in_use BEFORE UPDATE OF archived_at ON grp
WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM enrolment WHERE grp_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'group_in_use: a group with enrolments cannot be archived'); END;

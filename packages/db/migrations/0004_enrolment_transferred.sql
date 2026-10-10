-- Rebuild of `enrolment` to widen its status CHECK ('transferred'), hand-ordered for D1.
-- D1 runs a migration as one transaction with foreign keys enforced (PRAGMA foreign_keys=OFF is a
-- no-op there), so drizzle-kit's copy → drop → rename leaves the charge / prev_enrolment_id
-- references counted as violations at COMMIT. Here the old rows go to a constraint-free copy, the
-- table is recreated under its own name, and re-inserting the rows clears every deferred violation
-- the implicit DELETE of DROP TABLE recorded. Partial indexes return in 0005 (sql/).
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__enrolment_copy` AS SELECT * FROM `enrolment`;--> statement-breakpoint
DROP TABLE `enrolment`;--> statement-breakpoint
CREATE TABLE `enrolment` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`grp_id` text NOT NULL,
	`is_primary` integer NOT NULL,
	`roll_no` text,
	`start_date` text NOT NULL,
	`end_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`end_reason` text,
	`prev_enrolment_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prev_enrolment_id`) REFERENCES `enrolment`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "enrolment_status" CHECK("status" IN ('active','promoted','retained','completed','withdrawn','transferred'))
);
--> statement-breakpoint
INSERT INTO `enrolment`("id", "student_id", "grp_id", "is_primary", "roll_no", "start_date", "end_date", "status", "end_reason", "prev_enrolment_id", "created_at", "created_by") SELECT "id", "student_id", "grp_id", "is_primary", "roll_no", "start_date", "end_date", "status", "end_reason", "prev_enrolment_id", "created_at", "created_by" FROM `__enrolment_copy`;--> statement-breakpoint
DROP TABLE `__enrolment_copy`;--> statement-breakpoint
CREATE INDEX `enrolment_grp` ON `enrolment` (`grp_id`,`status`);--> statement-breakpoint
CREATE INDEX `enrolment_student` ON `enrolment` (`student_id`);

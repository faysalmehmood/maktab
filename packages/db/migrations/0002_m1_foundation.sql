CREATE TABLE `admission_series` (
	`series` text PRIMARY KEY NOT NULL,
	`last_no` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `import_row` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`row_no` integer NOT NULL,
	`row_hash` text NOT NULL,
	`student_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`run_id`) REFERENCES `import_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_row_row_hash_unique` ON `import_row` (`row_hash`);--> statement-breakpoint
CREATE INDEX `import_row_run` ON `import_row` (`run_id`);--> statement-breakpoint
CREATE TABLE `import_run` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`file_name` text,
	`status` text DEFAULT 'running' NOT NULL,
	`total` integer NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`report` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	CONSTRAINT "import_run_status" CHECK("status" IN ('running','committed','failed'))
);
--> statement-breakpoint
ALTER TABLE `school` ADD `logo_key` text;--> statement-breakpoint
ALTER TABLE `school` ADD `receipt_prefix` text;--> statement-breakpoint
ALTER TABLE `school` ADD `setup_completed_at` text;
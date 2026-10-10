CREATE TABLE `holiday` (
	`date` text PRIMARY KEY NOT NULL,
	`name_en` text NOT NULL,
	`name_ur` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
ALTER TABLE `school` ADD `attendance_mode` text DEFAULT 'daily' NOT NULL;--> statement-breakpoint
ALTER TABLE `school` ADD `weekly_off` text DEFAULT '[0]' NOT NULL;
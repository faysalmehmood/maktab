CREATE TABLE `alarm_event` (
	`day` text PRIMARY KEY NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`total` integer NOT NULL,
	`alarms` text NOT NULL,
	`cleanup` text,
	`acknowledged_at` text,
	`acknowledged_by` text,
	FOREIGN KEY (`acknowledged_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `backup_run` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`finished_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`object_key` text,
	`bytes` integer,
	`sha256` text,
	`targets` text,
	`details` text,
	`run_url` text,
	`note` text,
	`created_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `backup_run_kind` ON `backup_run` (`kind`,`finished_at`);--> statement-breakpoint
CREATE TABLE `export_job` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`tables` text NOT NULL,
	`finished_at` text,
	`row_count` integer,
	`file_count` integer,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `export_job_created` ON `export_job` (`created_at`);--> statement-breakpoint
ALTER TABLE `grp` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `school` ADD `access_log_days` integer DEFAULT 90 NOT NULL;
ALTER TABLE `billing_chunk` ADD `fail_streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_chunk` ADD `retry_after` text;
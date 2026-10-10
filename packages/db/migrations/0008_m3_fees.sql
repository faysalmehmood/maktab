-- M3 fees. Rebuilds `receipt` to finalise its kind enum with 'opening' (PLAN §15: enums on money
-- tables are final before the pilot; no receipt rows exist anywhere yet, so the copy is empty).
-- SQLite's ALTER TABLE RENAME re-checks every view and trigger that names the table, so the ledger
-- views and the triggers on other tables that read `receipt` are dropped first; the next (custom)
-- migration re-creates sql/20_append_only.sql, sql/30_ledger.sql and sql/50_fees.sql in full.
DROP VIEW IF EXISTS ledger_consistency;--> statement-breakpoint
DROP VIEW IF EXISTS payer_credit;--> statement-breakpoint
DROP VIEW IF EXISTS charge_status;--> statement-breakpoint
DROP VIEW IF EXISTS charge_net;--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_sums;--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_shape;--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_within_credit;--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_reversal_shape;--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_negative_within_net;--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_parent_shape;--> statement-breakpoint
CREATE TABLE `billing_chunk` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`grp_id` text,
	`student_id` text,
	`next_student_id` text,
	`done` integer DEFAULT 1 NOT NULL,
	`fees` integer DEFAULT 0 NOT NULL,
	`concessions` integer DEFAULT 0 NOT NULL,
	`sponsored` integer DEFAULT 0 NOT NULL,
	`fines` integer DEFAULT 0 NOT NULL,
	`allocations` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`run_id`) REFERENCES `billing_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "billing_chunk_kind" CHECK("kind" IN ('fees','fines'))
);
--> statement-breakpoint
CREATE INDEX `billing_chunk_run` ON `billing_chunk` (`run_id`,`kind`,`grp_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_no` text NOT NULL,
	`kind` text NOT NULL,
	`reverses_id` text,
	`payer_type` text NOT NULL,
	`payer_id` text NOT NULL,
	`amount` integer NOT NULL,
	`method` text NOT NULL,
	`account_id` text,
	`collector_id` text NOT NULL,
	`cash_session_id` text,
	`business_date` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`reference` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`reverses_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`collector_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_session_id`) REFERENCES `cash_session`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_kind" CHECK("kind" IN ('payment','reversal','refund','opening')),
	CONSTRAINT "receipt_method" CHECK("method" IN ('cash','bank','jazzcash','easypaisa')),
	CONSTRAINT "receipt_payer_type" CHECK("payer_type" IN ('family','sponsor')),
	CONSTRAINT "receipt_kind_shape" CHECK(CASE "kind" WHEN 'payment' THEN "amount" > 0 AND "reverses_id" IS NULL WHEN 'opening' THEN "amount" > 0 AND "reverses_id" IS NULL AND "cash_session_id" IS NULL WHEN 'reversal' THEN "amount" < 0 AND "reverses_id" IS NOT NULL WHEN 'refund' THEN "amount" < 0 AND "reverses_id" IS NULL ELSE 0 END),
	CONSTRAINT "receipt_amount_int" CHECK(typeof("amount") = 'integer')
);
--> statement-breakpoint
INSERT INTO `__new_receipt`("id", "receipt_no", "kind", "reverses_id", "payer_type", "payer_id", "amount", "method", "account_id", "collector_id", "cash_session_id", "business_date", "idempotency_key", "reference", "note", "created_at", "created_by") SELECT "id", "receipt_no", "kind", "reverses_id", "payer_type", "payer_id", "amount", "method", "account_id", "collector_id", "cash_session_id", "business_date", "idempotency_key", "reference", "note", "created_at", "created_by" FROM `receipt`;--> statement-breakpoint
DROP TABLE `receipt`;--> statement-breakpoint
ALTER TABLE `__new_receipt` RENAME TO `receipt`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_receipt_no_unique` ON `receipt` (`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_reverses_id_unique` ON `receipt` (`reverses_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_idempotency_key_unique` ON `receipt` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `receipt_payer` ON `receipt` (`payer_type`,`payer_id`);--> statement-breakpoint
CREATE INDEX `receipt_day_collector` ON `receipt` (`business_date`,`collector_id`);--> statement-breakpoint
ALTER TABLE `school` ADD `fine_rule` text;--> statement-breakpoint
ALTER TABLE `school` ADD `sibling_rule` text;--> statement-breakpoint
ALTER TABLE `school` ADD `reminder_cooldown_days` integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `fee_head` ADD `name_ur` text;--> statement-breakpoint
ALTER TABLE `fee_head` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `charge_period` ON `charge` (`period_key`,`payer_type`,`payer_id`);
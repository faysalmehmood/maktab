-- M3 fix pass: the last enum pass before the pilot (PLAN §15). Rebuilds three tables:
--   receipt  — method + 'cheque', 'other'
--   payslip  — status + 'void' (and approved_by may stay NULL on a voided draft)
--   role     — user_id ON DELETE RESTRICT, explicit (users are disabled, never deleted)
-- and adds billing_chunk.status / error_code / error_message (plain columns: a failed generation
-- chunk is logged and retried; the allowed values are a trigger in sql/50_fees.sql).
-- Same pattern as 0008: D1 runs migrations with foreign keys ON, so the foreign-key check is deferred
-- to COMMIT, and each table is copied aside, dropped, re-created under its final name and copied
-- back (re-inserting the parent rows clears the deferred violations; a rename would not). Views and
-- the triggers elsewhere that read these tables are dropped first; the next (custom) migration 0011
-- re-creates sql/20_append_only.sql, 30_ledger.sql, 40_foundation.sql and 50_fees.sql in full.
-- Replayed over populated data in packages/db/test/migration-0010.test.ts and on workerd.
PRAGMA defer_foreign_keys = ON;--> statement-breakpoint
DROP VIEW IF EXISTS ledger_consistency;--> statement-breakpoint
DROP VIEW IF EXISTS payer_credit;--> statement-breakpoint
DROP VIEW IF EXISTS charge_status;--> statement-breakpoint
DROP VIEW IF EXISTS charge_net;--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_sums;--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_shape;--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_within_credit;--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_reversal_shape;--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_opening_shape;--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_session_open;--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_no_update;--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_no_delete;--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_no_delete;--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_starts_draft;--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_status_forward;--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_frozen;--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_approver_frozen;--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_line_insert_draft;--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_line_update_draft;--> statement-breakpoint
DROP TRIGGER IF EXISTS payslip_line_delete_draft;--> statement-breakpoint
DROP TRIGGER IF EXISTS salary_payment_needs_approval;--> statement-breakpoint
DROP TRIGGER IF EXISTS salary_payment_within_net;--> statement-breakpoint
DROP TRIGGER IF EXISTS role_keep_owner;--> statement-breakpoint
DROP TRIGGER IF EXISTS user_keep_owner;--> statement-breakpoint
CREATE TABLE `__old_role` AS SELECT * FROM `role`;--> statement-breakpoint
DROP TABLE `role`;--> statement-breakpoint
CREATE TABLE `role` (
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	PRIMARY KEY(`user_id`, `role`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "role_role" CHECK("role" IN ('owner','admin','accountant','teacher'))
);--> statement-breakpoint
INSERT INTO `role`("user_id", "role", "created_at", "created_by") SELECT "user_id", "role", "created_at", "created_by" FROM `__old_role`;--> statement-breakpoint
DROP TABLE `__old_role`;--> statement-breakpoint
CREATE TABLE `__old_payslip` AS SELECT * FROM `payslip`;--> statement-breakpoint
DROP TABLE `payslip`;--> statement-breakpoint
CREATE TABLE `payslip` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`period_key` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payslip_status" CHECK("status" IN ('draft','approved','paid','void')),
	CONSTRAINT "payslip_approved_by" CHECK("status" IN ('draft', 'void') OR "approved_by" IS NOT NULL)
);--> statement-breakpoint
INSERT INTO `payslip`("id", "staff_id", "period_key", "status", "approved_by", "created_at", "created_by") SELECT "id", "staff_id", "period_key", "status", "approved_by", "created_at", "created_by" FROM `__old_payslip`;--> statement-breakpoint
DROP TABLE `__old_payslip`;--> statement-breakpoint
CREATE UNIQUE INDEX `payslip_once` ON `payslip` (`staff_id`,`period_key`);--> statement-breakpoint
CREATE TABLE `__old_receipt` AS SELECT * FROM `receipt`;--> statement-breakpoint
DROP TABLE `receipt`;--> statement-breakpoint
CREATE TABLE `receipt` (
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
	CONSTRAINT "receipt_method" CHECK("method" IN ('cash','bank','jazzcash','easypaisa','cheque','other')),
	CONSTRAINT "receipt_payer_type" CHECK("payer_type" IN ('family','sponsor')),
	CONSTRAINT "receipt_kind_shape" CHECK(CASE "kind" WHEN 'payment' THEN "amount" > 0 AND "reverses_id" IS NULL WHEN 'opening' THEN "amount" > 0 AND "reverses_id" IS NULL AND "cash_session_id" IS NULL WHEN 'reversal' THEN "amount" < 0 AND "reverses_id" IS NOT NULL WHEN 'refund' THEN "amount" < 0 AND "reverses_id" IS NULL ELSE 0 END),
	CONSTRAINT "receipt_amount_int" CHECK(typeof("amount") = 'integer')
);--> statement-breakpoint
INSERT INTO `receipt`("id", "receipt_no", "kind", "reverses_id", "payer_type", "payer_id", "amount", "method", "account_id", "collector_id", "cash_session_id", "business_date", "idempotency_key", "reference", "note", "created_at", "created_by") SELECT "id", "receipt_no", "kind", "reverses_id", "payer_type", "payer_id", "amount", "method", "account_id", "collector_id", "cash_session_id", "business_date", "idempotency_key", "reference", "note", "created_at", "created_by" FROM `__old_receipt`;--> statement-breakpoint
DROP TABLE `__old_receipt`;--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_receipt_no_unique` ON `receipt` (`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_reverses_id_unique` ON `receipt` (`reverses_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_idempotency_key_unique` ON `receipt` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `receipt_payer` ON `receipt` (`payer_type`,`payer_id`);--> statement-breakpoint
CREATE INDEX `receipt_day_collector` ON `receipt` (`business_date`,`collector_id`);--> statement-breakpoint
ALTER TABLE `billing_chunk` ADD `status` text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_chunk` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `billing_chunk` ADD `error_message` text;
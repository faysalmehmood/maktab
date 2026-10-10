-- Widens message.channel with 'call' (PLAN §14.3: no WhatsApp consent, or no number to message ->
-- the office phones the family). Nothing references `message` by foreign key and it has no
-- triggers, so drizzle-kit's copy -> drop -> rename is safe on D1 (foreign keys always on): only its
-- outgoing references are re-checked, on rows that already satisfied them. Enum rule (PLAN §15):
-- the message channels are final from here, before the pilot.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_message` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`guardian_id` text,
	`channel` text NOT NULL,
	`template_key` text NOT NULL,
	`lang` text NOT NULL,
	`payload` text,
	`link_token_hash` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`provider_ref` text,
	`raw_response` text,
	`cost_estimate` integer,
	`cost_actual` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	`sent_at` text,
	`error` text,
	FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`guardian_id`) REFERENCES `guardian`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_channel" CHECK("channel" IN ('wa_manual','wa_api','sms','push','email','call')),
	CONSTRAINT "message_status" CHECK("status" IN ('queued','sent','delivered','read','failed','skipped')),
	CONSTRAINT "message_cost_estimate_int" CHECK("cost_estimate" IS NULL OR typeof("cost_estimate") = 'integer'),
	CONSTRAINT "message_cost_actual_int" CHECK("cost_actual" IS NULL OR typeof("cost_actual") = 'integer')
);
--> statement-breakpoint
INSERT INTO `__new_message`("id", "family_id", "guardian_id", "channel", "template_key", "lang", "payload", "link_token_hash", "status", "provider_ref", "raw_response", "cost_estimate", "cost_actual", "created_at", "created_by", "sent_at", "error") SELECT "id", "family_id", "guardian_id", "channel", "template_key", "lang", "payload", "link_token_hash", "status", "provider_ref", "raw_response", "cost_estimate", "cost_actual", "created_at", "created_by", "sent_at", "error" FROM `message`;--> statement-breakpoint
DROP TABLE `message`;--> statement-breakpoint
ALTER TABLE `__new_message` RENAME TO `message`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `message_queue` ON `message` (`status`,`template_key`);
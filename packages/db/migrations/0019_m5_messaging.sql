CREATE TABLE `message_template` (
	`key` text NOT NULL,
	`lang` text NOT NULL,
	`body` text NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`key`, `lang`),
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `parent_link_access` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ip_hash` text,
	`ua` text,
	FOREIGN KEY (`link_id`) REFERENCES `parent_link`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `parent_link_access_link` ON `parent_link_access` (`link_id`,`at`);--> statement-breakpoint
ALTER TABLE `school` ADD `parent_gate` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `school` ADD `announcement_groups_note` text;--> statement-breakpoint
ALTER TABLE `message` ADD `rendered_text` text;--> statement-breakpoint
ALTER TABLE `message` ADD `opened_at` text;--> statement-breakpoint
ALTER TABLE `message` ADD `sent_by` text REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `message` ADD `skipped_reason` text;--> statement-breakpoint
ALTER TABLE `message` ADD `skipped_at` text;--> statement-breakpoint
CREATE INDEX `message_family` ON `message` (`family_id`,`template_key`);--> statement-breakpoint
ALTER TABLE `parent_link` ADD `token_salt` text;--> statement-breakpoint
ALTER TABLE `parent_link` ADD `gate` text;--> statement-breakpoint
ALTER TABLE `parent_link` ADD `pin_hash` text;--> statement-breakpoint
ALTER TABLE `parent_link` ADD `gate_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `parent_link` ADD `gate_locked_until` text;--> statement-breakpoint
CREATE INDEX `parent_link_guardian` ON `parent_link` (`guardian_id`);--> statement-breakpoint
-- Default message templates (en/ur), equal to DEFAULT_TEMPLATES in @maktab/shared (a test checks).
INSERT OR IGNORE INTO `message_template` (`key`, `lang`, `body`) VALUES
  ('absence', 'en', 'Assalamu alaikum. {children} was absent from school today, {date}. If this is a mistake, please tell us. — {school}
Details:
{link}'),
  ('absence', 'ur', 'السلام علیکم۔ آپ کے بچے {children} آج {date} کو اسکول میں غیر حاضر تھے۔ اگر یہ غلطی ہے تو ہمیں بتائیں۔ — {school}
تفصیل:
{link}'),
  ('fee_due', 'en', 'Assalamu alaikum. The fee of {amount} for {children} ({month}) is due. — {school}
Details:
{link}'),
  ('fee_due', 'ur', 'السلام علیکم۔ {children} کی {month} کی فیس {amount} واجب الادا ہے۔ — {school}
تفصیل:
{link}'),
  ('fee_overdue', 'en', 'Assalamu alaikum. The fee of {amount} for {children} is overdue. Please pay soon. — {school}
Details:
{link}'),
  ('fee_overdue', 'ur', 'السلام علیکم۔ {children} کی فیس {amount} کی ادائیگی باقی ہے، براہ کرم جلد ادا کریں۔ — {school}
تفصیل:
{link}'),
  ('payment_received', 'en', 'Assalamu alaikum. We received {amount} for {children} (receipt {receipt_no}). JazakAllah. — {school}
Receipt:
{link}'),
  ('payment_received', 'ur', 'السلام علیکم۔ {children} کی فیس {amount} موصول ہو گئی (رسید {receipt_no})۔ جزاک اللہ۔ — {school}
رسید:
{link}'),
  ('notice', 'en', 'Assalamu alaikum.

— {school}
{link}'),
  ('notice', 'ur', 'السلام علیکم۔

— {school}
{link}'),
  ('result', 'en', 'Assalamu alaikum. Results for {children} are ready. — {school}
Details:
{link}'),
  ('result', 'ur', 'السلام علیکم۔ {children} کا نتیجہ تیار ہے۔ — {school}
تفصیل:
{link}');
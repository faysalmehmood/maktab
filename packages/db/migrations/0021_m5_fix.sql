ALTER TABLE `parent_link` ADD `gate_last_attempt_at` text;--> statement-breakpoint
CREATE INDEX `message_sent_at` ON `message` (`status`,`sent_at`);--> statement-breakpoint
CREATE INDEX `message_skipped_at` ON `message` (`status`,`skipped_at`);--> statement-breakpoint
-- M5 fix pass: new schools start with the birth-year gate (the ORM default); the existing school
-- moves to it too. Attendance stays visible without the gate; dues, receipts and results need it.
UPDATE school SET parent_gate = 'birth_year' WHERE parent_gate = 'none';--> statement-breakpoint
-- Notices are now wrapped in the `notice` template's {body} slot, so the parent link stays alone on
-- the last line (DEFAULT_TEMPLATES in @maktab/shared; a test keeps the two equal).
UPDATE message_template SET body = 'Assalamu alaikum.
{body}
— {school}
{link}' WHERE key = 'notice' AND lang = 'en' AND body = 'Assalamu alaikum.

— {school}
{link}';--> statement-breakpoint
UPDATE message_template SET body = 'السلام علیکم۔
{body}
— {school}
{link}' WHERE key = 'notice' AND lang = 'ur' AND body = 'السلام علیکم۔

— {school}
{link}';--> statement-breakpoint
-- Absence: "{children} {was} absent" (was/were by count); Urdu drops "آپ کے بچے" and uses {was} (تھے).
UPDATE message_template SET body = 'Assalamu alaikum. {children} {was} absent from school today, {date}. If this is a mistake, please tell us. — {school}
Details:
{link}' WHERE key = 'absence' AND lang = 'en' AND body = 'Assalamu alaikum. {children} was absent from school today, {date}. If this is a mistake, please tell us. — {school}
Details:
{link}';--> statement-breakpoint
UPDATE message_template SET body = 'السلام علیکم۔ {children} آج {date} کو اسکول میں غیر حاضر {was}۔ اگر یہ غلطی ہے تو ہمیں بتائیں۔ — {school}
تفصیل:
{link}' WHERE key = 'absence' AND lang = 'ur' AND body = 'السلام علیکم۔ آپ کے بچے {children} آج {date} کو اسکول میں غیر حاضر تھے۔ اگر یہ غلطی ہے تو ہمیں بتائیں۔ — {school}
تفصیل:
{link}';--> statement-breakpoint
-- Staff-edited texts keep their wording but gain the slots every template now requires.
UPDATE message_template SET body = '{body}' || char(10) || body
WHERE key = 'notice' AND instr(body, '{body}') = 0;--> statement-breakpoint
UPDATE message_template SET body = body || char(10) || '{link}' WHERE instr(body, '{link}') = 0;

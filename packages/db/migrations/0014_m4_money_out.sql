ALTER TABLE `school` ADD `advance_recovery_pct` integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE `staff` ADD `base_salary` integer;--> statement-breakpoint
ALTER TABLE `staff` ADD `allowances` text;--> statement-breakpoint
ALTER TABLE `expense` ADD `receipt_key` text;--> statement-breakpoint
CREATE INDEX `expense_date` ON `expense` (`date`);--> statement-breakpoint
CREATE INDEX `expense_session` ON `expense` (`cash_session_id`);--> statement-breakpoint
ALTER TABLE `expense_category` ADD `name_ur` text;--> statement-breakpoint
ALTER TABLE `expense_category` ADD `code` text;--> statement-breakpoint
ALTER TABLE `expense_category` ADD `system` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `expense_category` ADD `sort` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `expense_category_code` ON `expense_category` (`code`);--> statement-breakpoint
ALTER TABLE `payslip` ADD `approved_at` text;--> statement-breakpoint
ALTER TABLE `payslip` ADD `voided_by` text REFERENCES user(id);--> statement-breakpoint
ALTER TABLE `payslip` ADD `void_reason` text;--> statement-breakpoint
ALTER TABLE `salary_payment` ADD `cash_session_id` text REFERENCES cash_session(id);--> statement-breakpoint
ALTER TABLE `salary_payment` ADD `note` text;--> statement-breakpoint
CREATE INDEX `salary_payment_slip` ON `salary_payment` (`payslip_id`);--> statement-breakpoint
CREATE INDEX `salary_payment_session` ON `salary_payment` (`cash_session_id`);--> statement-breakpoint
ALTER TABLE `staff_advance` ADD `cash_session_id` text REFERENCES cash_session(id);--> statement-breakpoint
ALTER TABLE `staff_advance` ADD `note` text;--> statement-breakpoint
CREATE INDEX `staff_advance_staff` ON `staff_advance` (`staff_id`);--> statement-breakpoint
CREATE INDEX `staff_advance_session` ON `staff_advance` (`cash_session_id`);--> statement-breakpoint
-- M4 seed (PLAN §14.8): the expense categories, with stable codes. `salaries` is system-reserved:
-- reports show salaries from payslips, so it is never offered when recording an expense.
INSERT OR IGNORE INTO `expense_category` (`id`, `name`, `name_ur`, `code`, `system`, `sort`) VALUES
  ('expcat_rent', 'Rent', 'کرایہ', 'rent', 0, 10),
  ('expcat_utilities', 'Utilities', 'بل (بجلی، گیس، پانی)', 'utilities', 0, 20),
  ('expcat_salaries', 'Salaries', 'تنخواہیں', 'salaries', 1, 30),
  ('expcat_stationery', 'Stationery', 'اسٹیشنری', 'stationery', 0, 40),
  ('expcat_maintenance', 'Maintenance', 'مرمت و دیکھ بھال', 'maintenance', 0, 50),
  ('expcat_transport', 'Transport', 'ٹرانسپورٹ', 'transport', 0, 60),
  ('expcat_exam', 'Exams', 'امتحانات', 'exam', 0, 70),
  ('expcat_misc', 'Miscellaneous', 'متفرق', 'misc', 0, 80);

CREATE TABLE `att_mark` (
	`register_id` text NOT NULL,
	`student_id` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	PRIMARY KEY(`register_id`, `student_id`),
	FOREIGN KEY (`register_id`) REFERENCES `att_register`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "att_mark_status" CHECK("status" IN ('P','A','L','E'))
);
--> statement-breakpoint
CREATE TABLE `att_register` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`grp_id` text NOT NULL,
	`date` text NOT NULL,
	`grp_subject_id` text DEFAULT '' NOT NULL,
	`taken_by` text NOT NULL,
	`taken_at` text NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`batch_token` text NOT NULL,
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`taken_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `att_register_client_id_unique` ON `att_register` (`client_id`);--> statement-breakpoint
CREATE INDEX `att_register_key` ON `att_register` (`grp_id`,`date`,`grp_subject_id`);--> statement-breakpoint
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`user_id` text,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`diff` text
);
--> statement-breakpoint
CREATE INDEX `audit_entity` ON `audit` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `current_register` (
	`grp_id` text NOT NULL,
	`date` text NOT NULL,
	`grp_subject_id` text DEFAULT '' NOT NULL,
	`register_id` text NOT NULL,
	`taken_at` text NOT NULL,
	PRIMARY KEY(`grp_id`, `date`, `grp_subject_id`),
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`register_id`) REFERENCES `att_register`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `custom_field` (
	`id` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`key` text NOT NULL,
	`label_en` text NOT NULL,
	`label_ur` text,
	`type` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	CONSTRAINT "custom_field_type" CHECK("type" IN ('text','number','date','bool'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_field_key` ON `custom_field` (`entity`,`key`);--> statement-breakpoint
CREATE TABLE `enrolment` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`grp_id` text NOT NULL,
	`is_primary` integer NOT NULL,
	`roll_no` text,
	`start_date` text NOT NULL,
	`end_date` text,
	`status` text DEFAULT 'active' NOT NULL,
	`end_reason` text,
	`prev_enrolment_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prev_enrolment_id`) REFERENCES `enrolment`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "enrolment_status" CHECK("status" IN ('active','promoted','retained','completed','withdrawn'))
);
--> statement-breakpoint
CREATE INDEX `enrolment_grp` ON `enrolment` (`grp_id`,`status`);--> statement-breakpoint
CREATE TABLE `exam` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`term_id` text,
	`grp_id` text NOT NULL,
	`date_from` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`term_id`) REFERENCES `term`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "exam_status" CHECK("status" IN ('draft','published'))
);
--> statement-breakpoint
CREATE TABLE `exam_paper` (
	`id` text PRIMARY KEY NOT NULL,
	`exam_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`max_marks` real NOT NULL,
	`pass_marks` real,
	`weight` real DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`exam_id`) REFERENCES `exam`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_id`) REFERENCES `subject`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `family` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`address` text,
	`area` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE TABLE `grade_band` (
	`scale_id` text NOT NULL,
	`min_pct` real NOT NULL,
	`grade` text NOT NULL,
	`remark` text,
	PRIMARY KEY(`scale_id`, `min_pct`),
	FOREIGN KEY (`scale_id`) REFERENCES `grade_scale`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `grade_scale` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE TABLE `grp` (
	`id` text PRIMARY KEY NOT NULL,
	`programme_id` text NOT NULL,
	`session_id` text,
	`name` text NOT NULL,
	`is_primary` integer DEFAULT true NOT NULL,
	`class_teacher_id` text,
	`start_date` text,
	`end_date` text,
	`capacity` integer,
	`days` text,
	`start_time` text,
	`end_time` text,
	`room` text,
	`next_grp_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`programme_id`) REFERENCES `programme`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`class_teacher_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`next_grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grp_status" CHECK("status" IN ('open','running','closed'))
);
--> statement-breakpoint
CREATE TABLE `grp_subject` (
	`id` text PRIMARY KEY NOT NULL,
	`grp_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`teacher_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_id`) REFERENCES `subject`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`teacher_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grp_subject_once` ON `grp_subject` (`grp_id`,`subject_id`);--> statement-breakpoint
CREATE TABLE `guardian` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`name` text NOT NULL,
	`relation` text,
	`cnic` text,
	`phone` text,
	`whatsapp` text,
	`priority` integer DEFAULT 1 NOT NULL,
	`consent_whatsapp` integer DEFAULT false NOT NULL,
	`consent_sms` integer DEFAULT false NOT NULL,
	`lang` text DEFAULT 'ur' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `guardian_phone` ON `guardian` (`phone`);--> statement-breakpoint
CREATE INDEX `guardian_family` ON `guardian` (`family_id`);--> statement-breakpoint
CREATE TABLE `mark` (
	`paper_id` text NOT NULL,
	`student_id` text NOT NULL,
	`obtained` real,
	`is_absent` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	PRIMARY KEY(`paper_id`, `student_id`),
	FOREIGN KEY (`paper_id`) REFERENCES `exam_paper`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `programme` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`next_programme_id` text,
	`duration_weeks` integer,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`next_programme_id`) REFERENCES `programme`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "programme_kind" CHECK("kind" IN ('grade','course'))
);
--> statement-breakpoint
CREATE TABLE `school` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_ur` text,
	`mode` text DEFAULT 'school' NOT NULL,
	`address` text,
	`phone` text,
	`default_lang` text DEFAULT 'ur' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	CONSTRAINT "school_mode" CHECK("mode" IN ('school','academy','both'))
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE TABLE `slot` (
	`id` text PRIMARY KEY NOT NULL,
	`grp_id` text NOT NULL,
	`weekday` integer NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`grp_subject_id` text,
	`room` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grp_subject_id`) REFERENCES `grp_subject`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "slot_weekday" CHECK("weekday" BETWEEN 0 AND 6)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slot_no_clash` ON `slot` (`grp_id`,`weekday`,`start_time`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`phone` text,
	`role` text,
	`joined` text,
	`status` text DEFAULT 'active' NOT NULL,
	`extra` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `staff_att` (
	`staff_id` text NOT NULL,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	PRIMARY KEY(`staff_id`, `date`),
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "staff_att_status" CHECK("status" IN ('P','A','L','E'))
);
--> statement-breakpoint
CREATE TABLE `student` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`admission_no` text NOT NULL,
	`name` text NOT NULL,
	`father_name` text,
	`dob` text,
	`gender` text,
	`b_form_no` text,
	`photo_key` text,
	`admission_date` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`left_date` text,
	`left_reason` text,
	`extra` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "student_status" CHECK("status" IN ('active','left','graduated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `student_admission_no_unique` ON `student` (`admission_no`);--> statement-breakpoint
CREATE INDEX `student_family` ON `student` (`family_id`);--> statement-breakpoint
CREATE TABLE `subject` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short_name` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE TABLE `term` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`seq` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `role` (
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	PRIMARY KEY(`user_id`, `role`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "role_role" CHECK("role" IN ('owner','admin','accountant','teacher'))
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`google_sub` text,
	`status` text DEFAULT 'invited' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_status" CHECK("status" IN ('invited','active','disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_google_sub_unique` ON `user` (`google_sub`);--> statement-breakpoint
CREATE TABLE `user_session` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`ua` text,
	`ip` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `user_session_user` ON `user_session` (`user_id`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`guardian_id` text,
	`channel` text NOT NULL,
	`template_key` text NOT NULL,
	`lang` text NOT NULL,
	`payload` text,
	`link_token` text,
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
	CONSTRAINT "message_channel" CHECK("channel" IN ('wa_manual','wa_api','sms','push','email')),
	CONSTRAINT "message_status" CHECK("status" IN ('queued','sent','delivered','read','failed','skipped'))
);
--> statement-breakpoint
CREATE INDEX `message_queue` ON `message` (`status`,`template_key`);--> statement-breakpoint
CREATE TABLE `parent_link` (
	`id` text PRIMARY KEY NOT NULL,
	`guardian_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`last_seen_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`guardian_id`) REFERENCES `guardian`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parent_link_token_hash_unique` ON `parent_link` (`token_hash`);--> statement-breakpoint
CREATE TABLE `reminder_state` (
	`family_id` text NOT NULL,
	`template_key` text NOT NULL,
	`last_sent_on` text NOT NULL,
	PRIMARY KEY(`family_id`, `template_key`),
	FOREIGN KEY (`family_id`) REFERENCES `family`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`holder_staff_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`holder_staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "account_kind" CHECK("kind" IN ('cash','bank','wallet'))
);
--> statement-breakpoint
CREATE TABLE `billing_run` (
	`id` text PRIMARY KEY NOT NULL,
	`period_key` text NOT NULL,
	`run_at` text NOT NULL,
	`run_by` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`run_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_run_period_key_unique` ON `billing_run` (`period_key`);--> statement-breakpoint
CREATE TABLE `cash_session` (
	`id` text PRIMARY KEY NOT NULL,
	`collector_id` text NOT NULL,
	`business_date` text NOT NULL,
	`opening` integer DEFAULT 0 NOT NULL,
	`expected` integer,
	`counted` integer,
	`variance` integer,
	`closed_at` text,
	`closed_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`collector_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_session_once` ON `cash_session` (`collector_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `charge` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`enrolment_id` text,
	`fee_head_id` text NOT NULL,
	`period_key` text NOT NULL,
	`payer_type` text NOT NULL,
	`payer_id` text NOT NULL,
	`amount` integer NOT NULL,
	`due_date` text NOT NULL,
	`kind` text NOT NULL,
	`parent_charge_id` text,
	`reason` text,
	`run_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enrolment_id`) REFERENCES `enrolment`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fee_head_id`) REFERENCES `fee_head`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_charge_id`) REFERENCES `charge`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `billing_run`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "charge_kind" CHECK("kind" IN ('fee','concession','fine','fine_waiver','reversal')),
	CONSTRAINT "charge_payer_type" CHECK("payer_type" IN ('family','sponsor')),
	CONSTRAINT "charge_root_kind" CHECK("parent_charge_id" IS NOT NULL OR "kind" IN ('fee','fine'))
);
--> statement-breakpoint
CREATE INDEX `charge_payer` ON `charge` (`payer_id`);--> statement-breakpoint
CREATE INDEX `charge_parent` ON `charge` (`parent_charge_id`);--> statement-breakpoint
CREATE INDEX `charge_student` ON `charge` (`student_id`);--> statement-breakpoint
CREATE TABLE `concession` (
	`id` text PRIMARY KEY NOT NULL,
	`student_id` text NOT NULL,
	`fee_head_id` text,
	`type` text NOT NULL,
	`value` integer NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`approved_by` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`ended_at` text,
	`ended_by` text,
	`end_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fee_head_id`) REFERENCES `fee_head`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ended_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "concession_type" CHECK("type" IN ('pct','fixed')),
	CONSTRAINT "concession_reason" CHECK("reason" IN ('sibling','orphan','staff_child','scholarship','topper','needy','other')),
	CONSTRAINT "concession_value" CHECK("value" > 0 AND ("type" <> 'pct' OR "value" <= 100))
);
--> statement-breakpoint
CREATE TABLE `expense` (
	`id` text PRIMARY KEY NOT NULL,
	`expense_no` text NOT NULL,
	`category_id` text NOT NULL,
	`account_id` text NOT NULL,
	`cash_session_id` text,
	`amount` integer NOT NULL,
	`vendor` text,
	`date` text NOT NULL,
	`note` text,
	`voided_by` text,
	`void_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`category_id`) REFERENCES `expense_category`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_session_id`) REFERENCES `cash_session`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "expense_amount" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_expense_no_unique` ON `expense` (`expense_no`);--> statement-breakpoint
CREATE TABLE `expense_category` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `expense_category_name_unique` ON `expense_category` (`name`);--> statement-breakpoint
CREATE TABLE `fee_head` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`cadence` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	CONSTRAINT "fee_head_kind" CHECK("kind" IN ('admission','tuition','exam','course','misc','fine')),
	CONSTRAINT "fee_head_cadence" CHECK("cadence" IN ('monthly','once','per_term'))
);
--> statement-breakpoint
CREATE TABLE `fee_rate` (
	`id` text PRIMARY KEY NOT NULL,
	`fee_head_id` text NOT NULL,
	`programme_id` text,
	`grp_id` text,
	`amount` integer NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`fee_head_id`) REFERENCES `fee_head`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`programme_id`) REFERENCES `programme`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`grp_id`) REFERENCES `grp`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "fee_rate_target" CHECK(("programme_id" IS NULL) <> ("grp_id" IS NULL)),
	CONSTRAINT "fee_rate_amount" CHECK("amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE `opening_balance` (
	`student_id` text PRIMARY KEY NOT NULL,
	`amount` integer NOT NULL,
	`as_of` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
	CONSTRAINT "payslip_status" CHECK("status" IN ('draft','approved','paid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payslip_once` ON `payslip` (`staff_id`,`period_key`);--> statement-breakpoint
CREATE TABLE `payslip_line` (
	`id` text PRIMARY KEY NOT NULL,
	`payslip_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`payslip_id`) REFERENCES `payslip`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payslip_line_kind" CHECK("kind" IN ('basic','allowance','deduction','advance_recovery'))
);
--> statement-breakpoint
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
	CONSTRAINT "receipt_kind" CHECK("kind" IN ('payment','reversal','refund')),
	CONSTRAINT "receipt_method" CHECK("method" IN ('cash','bank','jazzcash','easypaisa')),
	CONSTRAINT "receipt_payer_type" CHECK("payer_type" IN ('family','sponsor')),
	CONSTRAINT "receipt_reversal_shape" CHECK(("kind" = 'reversal') = ("reverses_id" IS NOT NULL AND "amount" < 0)),
	CONSTRAINT "receipt_positive" CHECK("kind" = 'reversal' OR "amount" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_receipt_no_unique` ON `receipt` (`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_reverses_id_unique` ON `receipt` (`reverses_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_idempotency_key_unique` ON `receipt` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `receipt_payer` ON `receipt` (`payer_id`);--> statement-breakpoint
CREATE TABLE `receipt_allocation` (
	`receipt_id` text NOT NULL,
	`charge_id` text NOT NULL,
	`amount` integer NOT NULL,
	PRIMARY KEY(`receipt_id`, `charge_id`),
	FOREIGN KEY (`receipt_id`) REFERENCES `receipt`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`charge_id`) REFERENCES `charge`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `receipt_allocation_charge` ON `receipt_allocation` (`charge_id`);--> statement-breakpoint
CREATE TABLE `receipt_series` (
	`series` text NOT NULL,
	`year` integer NOT NULL,
	`next_no` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`series`, `year`)
);
--> statement-breakpoint
CREATE TABLE `salary_payment` (
	`id` text PRIMARY KEY NOT NULL,
	`payslip_id` text NOT NULL,
	`amount` integer NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`payslip_id`) REFERENCES `payslip`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "salary_payment_amount" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE `sponsor` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`cnic` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text
);
--> statement-breakpoint
CREATE TABLE `sponsorship` (
	`id` text PRIMARY KEY NOT NULL,
	`sponsor_id` text NOT NULL,
	`student_id` text NOT NULL,
	`fee_head_id` text,
	`share_pct` integer NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`sponsor_id`) REFERENCES `sponsor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`student_id`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fee_head_id`) REFERENCES `fee_head`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sponsorship_share" CHECK("share_pct" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE `staff_advance` (
	`id` text PRIMARY KEY NOT NULL,
	`staff_id` text NOT NULL,
	`amount` integer NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "staff_advance_amount" CHECK("amount" > 0)
);
--> statement-breakpoint
CREATE TABLE `transfer` (
	`id` text PRIMARY KEY NOT NULL,
	`from_account` text NOT NULL,
	`to_account` text NOT NULL,
	`amount` integer NOT NULL,
	`date` text NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text,
	FOREIGN KEY (`from_account`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_account`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "transfer_amount" CHECK("amount" > 0),
	CONSTRAINT "transfer_distinct" CHECK("from_account" <> "to_account")
);

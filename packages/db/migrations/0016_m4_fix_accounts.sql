ALTER TABLE `account` ADD `opening_balance` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `account` ADD `opening_as_of` text;--> statement-breakpoint
-- M4 fix pass (F4): a cash receipt now stores the drawer account it landed in at insert, so a later
-- change of who holds which drawer never moves history. Backfill the rows written before this
-- migration from the same lookup money_movement used until now. receipt is append-only, so its
-- update guard is lifted for this one statement and re-created identically (sql/20_append_only.sql);
-- `npm run db:verify` checks it is back.
DROP TRIGGER IF EXISTS receipt_no_update;--> statement-breakpoint
UPDATE receipt SET account_id = (SELECT d.account_id FROM drawer_account d WHERE d.user_id = receipt.collector_id)
WHERE method = 'cash' AND kind <> 'opening' AND account_id IS NULL;--> statement-breakpoint
CREATE TRIGGER receipt_no_update BEFORE UPDATE ON receipt BEGIN SELECT RAISE(ABORT, 'receipt is append-only'); END;

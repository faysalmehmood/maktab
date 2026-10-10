-- Milestone 4: money out (PLAN §5.2, §14.6, §14.8). Same style as the ledger: the database refuses the
-- impossible state, the API maps the message text to a 409. 20_append_only.sql already freezes
-- expenses (void only), advances and salary payments (append-only) and walks a payslip
-- draft -> approved -> paid (or void before payment), with salary paid within the net.

-- Expense numbers come from the `EXP` series, bumped in the same batch (like receipts): a typed number,
-- or one from another series, is refused. Money out of a drawer (a `cash` account) is in the payer's
-- cash session; money out of a bank or wallet takes no session. `salaries` is a system category:
-- salaries are payslips, never expenses (or the income/expense report would count them twice).
CREATE TRIGGER expense_shape BEFORE INSERT ON expense
BEGIN
  SELECT RAISE(ABORT, 'expense number must be the next number of the EXP series')
  WHERE NOT EXISTS (
    SELECT 1 FROM receipt_series s
    WHERE s.series = 'EXP' AND NEW.expense_no = 'EXP-' || s.year || '-' || printf('%05d', s.next_no - 1));
  SELECT RAISE(ABORT, 'a drawer expense needs a cash session; a bank expense takes none')
  WHERE ((SELECT kind FROM account WHERE id = NEW.account_id) = 'cash') <> (NEW.cash_session_id IS NOT NULL);
  SELECT RAISE(ABORT, 'this expense category is reserved')
  WHERE (SELECT system FROM expense_category WHERE id = NEW.category_id) = 1
     OR (SELECT deleted_at FROM expense_category WHERE id = NEW.category_id) IS NOT NULL;
END;
--> statement-breakpoint
-- Salary payments and advances: same drawer rule as expenses; a closed session takes no rows.
CREATE TRIGGER salary_payment_shape BEFORE INSERT ON salary_payment
BEGIN
  SELECT RAISE(ABORT, 'cash session is closed')
  WHERE NEW.cash_session_id IS NOT NULL
    AND (SELECT closed_at FROM cash_session WHERE id = NEW.cash_session_id) IS NOT NULL;
  SELECT RAISE(ABORT, 'a drawer payment needs a cash session; a bank payment takes none')
  WHERE ((SELECT kind FROM account WHERE id = NEW.account_id) = 'cash') <> (NEW.cash_session_id IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER staff_advance_shape BEFORE INSERT ON staff_advance
BEGIN
  SELECT RAISE(ABORT, 'cash session is closed')
  WHERE NEW.cash_session_id IS NOT NULL
    AND (SELECT closed_at FROM cash_session WHERE id = NEW.cash_session_id) IS NOT NULL;
  SELECT RAISE(ABORT, 'a drawer payment needs a cash session; a bank payment takes none')
  WHERE ((SELECT kind FROM account WHERE id = NEW.account_id) = 'cash') <> (NEW.cash_session_id IS NOT NULL);
END;
--> statement-breakpoint

-- M4 fix pass (F3, F6): cash out of a drawer comes from the payer's OWN drawer. A movement on a cash
-- account carries a session, and the account must be the drawer of that session's holder (the
-- `drawer_account` lookup below), so nobody pays out of — or moves cash from — someone else's drawer.
-- Receipts store the drawer they landed in (F4) and are held to the same rule. A transfer out of a
-- cash account needs the holder's open session like any other cash out. The drawer checks run AFTER
-- the insert (the row's other shape rules report first); the abort still rolls the batch back.
CREATE TRIGGER expense_own_drawer AFTER INSERT ON expense WHEN NEW.cash_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash leaves only the payer''s own drawer')
  WHERE NEW.account_id IS NOT (SELECT d.account_id FROM drawer_account d
                               JOIN cash_session s ON s.collector_id = d.user_id WHERE s.id = NEW.cash_session_id);
END;
--> statement-breakpoint
CREATE TRIGGER salary_payment_own_drawer AFTER INSERT ON salary_payment WHEN NEW.cash_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash leaves only the payer''s own drawer')
  WHERE NEW.account_id IS NOT (SELECT d.account_id FROM drawer_account d
                               JOIN cash_session s ON s.collector_id = d.user_id WHERE s.id = NEW.cash_session_id);
END;
--> statement-breakpoint
CREATE TRIGGER staff_advance_own_drawer AFTER INSERT ON staff_advance WHEN NEW.cash_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash leaves only the payer''s own drawer')
  WHERE NEW.account_id IS NOT (SELECT d.account_id FROM drawer_account d
                               JOIN cash_session s ON s.collector_id = d.user_id WHERE s.id = NEW.cash_session_id);
END;
--> statement-breakpoint
CREATE TRIGGER transfer_shape BEFORE INSERT ON transfer
BEGIN
  SELECT RAISE(ABORT, 'a transfer out of a drawer needs the holder''s open cash session; a bank transfer takes none')
  WHERE ((SELECT kind FROM account WHERE id = NEW.from_account) = 'cash') <> (NEW.cash_session_id IS NOT NULL);
END;
--> statement-breakpoint
CREATE TRIGGER transfer_own_drawer AFTER INSERT ON transfer WHEN NEW.cash_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash leaves only the payer''s own drawer')
  WHERE NEW.from_account IS NOT (SELECT d.account_id FROM drawer_account d
                                 JOIN cash_session s ON s.collector_id = d.user_id WHERE s.id = NEW.cash_session_id);
END;
--> statement-breakpoint
CREATE TRIGGER receipt_own_drawer AFTER INSERT ON receipt
WHEN NEW.method = 'cash' AND NEW.kind IN ('payment', 'refund', 'reversal')
BEGIN
  SELECT RAISE(ABORT, 'a cash receipt lands in its collector''s own drawer')
  WHERE NEW.account_id IS NOT (SELECT d.account_id FROM drawer_account d
                               JOIN cash_session s ON s.collector_id = d.user_id WHERE s.id = NEW.cash_session_id);
END;
--> statement-breakpoint
-- A drawer expense is voided only while its session is open: the close froze the expected cash, so a
-- late correction is a new entry in an open session (verify pass).
CREATE TRIGGER expense_void_session_open BEFORE UPDATE OF voided_by ON expense
WHEN OLD.voided_by IS NULL AND NEW.voided_by IS NOT NULL AND OLD.cash_session_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'cash session is closed')
  WHERE (SELECT closed_at FROM cash_session WHERE id = OLD.cash_session_id) IS NOT NULL;
END;
--> statement-breakpoint
-- An account's holder and opening balance are history once money has moved through it (F4): a new
-- holder would re-route the drawer lookup, an opening balance would rewrite every running balance.
-- The opening balance is set once (opening_as_of goes from NULL to a date, and then never changes).
CREATE TRIGGER account_holder_frozen BEFORE UPDATE OF holder_staff_id ON account
WHEN OLD.holder_staff_id IS NOT NEW.holder_staff_id
BEGIN
  SELECT RAISE(ABORT, 'account has movements; its holder is fixed')
  WHERE EXISTS (SELECT 1 FROM money_movement m WHERE m.account_id = OLD.id AND m.kind <> 'opening');
END;
--> statement-breakpoint
CREATE TRIGGER account_opening_once BEFORE UPDATE OF opening_balance, opening_as_of ON account
WHEN OLD.opening_balance IS NOT NEW.opening_balance OR OLD.opening_as_of IS NOT NEW.opening_as_of
BEGIN
  SELECT RAISE(ABORT, 'opening balance is already set')
  WHERE OLD.opening_as_of IS NOT NULL;
  SELECT RAISE(ABORT, 'account has movements; its opening balance is fixed')
  WHERE EXISTS (SELECT 1 FROM money_movement m WHERE m.account_id = OLD.id AND m.kind <> 'opening');
  SELECT RAISE(ABORT, 'opening balance needs a date')
  WHERE NEW.opening_as_of IS NULL OR NEW.opening_as_of NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]';
  SELECT RAISE(ABORT, 'opening balance is whole paisa')
  WHERE typeof(NEW.opening_balance) <> 'integer';
END;
--> statement-breakpoint

-- Approval (maker-checker, PLAN §5.4): never by the staff member themself; the net is never negative;
-- advance recovery never takes back more than is outstanding (recovery counts once the slip is
-- approved, so the slip being approved is not yet in advance_balance).
CREATE TRIGGER payslip_approve_rules BEFORE UPDATE OF status ON payslip
WHEN OLD.status = 'draft' AND NEW.status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'a payslip cannot be approved by its own staff member')
  WHERE NEW.approved_by = (SELECT user_id FROM staff WHERE id = NEW.staff_id);
  SELECT RAISE(ABORT, 'payslip net is negative')
  WHERE (SELECT coalesce(sum(CASE WHEN kind IN ('basic', 'allowance') THEN amount ELSE -amount END), 0)
         FROM payslip_line WHERE payslip_id = NEW.id) < 0;
  SELECT RAISE(ABORT, 'advance recovery exceeds outstanding advance')
  WHERE (SELECT coalesce(sum(amount), 0) FROM payslip_line
         WHERE payslip_id = NEW.id AND kind = 'advance_recovery')
      > (SELECT coalesce(sum(amount), 0) FROM staff_advance WHERE staff_id = NEW.staff_id)
      - (SELECT coalesce(sum(l.amount), 0) FROM payslip_line l JOIN payslip p ON p.id = l.payslip_id
         WHERE p.staff_id = NEW.staff_id AND p.status IN ('approved', 'paid') AND l.kind = 'advance_recovery');
END;
--> statement-breakpoint
-- 'paid' means settled: every rupee of the net has been paid.
CREATE TRIGGER payslip_paid_settled BEFORE UPDATE OF status ON payslip
WHEN OLD.status = 'approved' AND NEW.status = 'paid'
BEGIN
  SELECT RAISE(ABORT, 'payslip is not fully paid')
  WHERE (SELECT coalesce(sum(amount), 0) FROM salary_payment WHERE payslip_id = NEW.id)
      < (SELECT coalesce(sum(CASE WHEN kind IN ('basic', 'allowance') THEN amount ELSE -amount END), 0)
         FROM payslip_line WHERE payslip_id = NEW.id);
END;
--> statement-breakpoint
-- A void says who and why; nothing else carries a void record.
CREATE TRIGGER payslip_void_shape BEFORE UPDATE OF status, voided_by, void_reason ON payslip
BEGIN
  SELECT RAISE(ABORT, 'voiding a payslip needs who and a reason')
  WHERE NEW.status = 'void' AND (NEW.voided_by IS NULL OR length(trim(coalesce(NEW.void_reason, ''))) = 0);
  SELECT RAISE(ABORT, 'only a void payslip carries a void record')
  WHERE OLD.status <> 'void' AND NEW.status <> 'void' AND (NEW.voided_by IS NOT NULL OR NEW.void_reason IS NOT NULL);
  SELECT RAISE(ABORT, 'payslip void record is fixed')
  WHERE OLD.status = 'void' AND (NEW.voided_by IS NOT OLD.voided_by OR NEW.void_reason IS NOT OLD.void_reason);
END;
--> statement-breakpoint
-- A payslip period is `YYYY-MM`, like charges.
CREATE TRIGGER payslip_period_format BEFORE INSERT ON payslip
WHEN NEW.period_key NOT GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
  OR substr(NEW.period_key, 6, 2) NOT BETWEEN '01' AND '12'
BEGIN SELECT RAISE(ABORT, 'period_key must be YYYY-MM'); END;
--> statement-breakpoint

-- Derived, never stored (PLAN §5.2). earnings = basic + allowances; pay = earnings − deductions (the
-- salary expense); net = pay − advance recovery (what is paid out).
CREATE VIEW payslip_net AS
SELECT p.id, p.staff_id, p.period_key, p.status,
       coalesce(sum(CASE WHEN l.kind IN ('basic', 'allowance') THEN l.amount END), 0) AS earnings,
       coalesce(sum(CASE WHEN l.kind = 'deduction' THEN l.amount END), 0) AS deductions,
       coalesce(sum(CASE WHEN l.kind = 'advance_recovery' THEN l.amount END), 0) AS recovery,
       coalesce(sum(CASE WHEN l.kind IN ('basic', 'allowance') THEN l.amount WHEN l.kind = 'deduction' THEN -l.amount END), 0) AS pay,
       coalesce(sum(CASE WHEN l.kind IN ('basic', 'allowance') THEN l.amount ELSE -l.amount END), 0) AS net,
       (SELECT coalesce(sum(s.amount), 0) FROM salary_payment s WHERE s.payslip_id = p.id) AS paid
FROM payslip p LEFT JOIN payslip_line l ON l.payslip_id = p.id
GROUP BY p.id;
--> statement-breakpoint
-- Advance receivable per staff member: recovered through approved (or paid) payslips.
CREATE VIEW advance_balance AS
SELECT s.id AS staff_id,
       (SELECT coalesce(sum(a.amount), 0) FROM staff_advance a WHERE a.staff_id = s.id) AS advanced,
       (SELECT coalesce(sum(l.amount), 0) FROM payslip_line l JOIN payslip p ON p.id = l.payslip_id
        WHERE p.staff_id = s.id AND p.status IN ('approved', 'paid') AND l.kind = 'advance_recovery') AS recovered,
       (SELECT coalesce(sum(a.amount), 0) FROM staff_advance a WHERE a.staff_id = s.id)
     - (SELECT coalesce(sum(l.amount), 0) FROM payslip_line l JOIN payslip p ON p.id = l.payslip_id
        WHERE p.staff_id = s.id AND p.status IN ('approved', 'paid') AND l.kind = 'advance_recovery') AS outstanding
FROM staff s;
--> statement-breakpoint
-- A user's drawer: the cash account they hold, else the shared cash account (no holder), else the
-- first cash account. A lookup only (M4 fix pass): cash receipts store the account they landed in at
-- insert, and every cash movement must be on its session holder's drawer (triggers above).
CREATE VIEW drawer_account AS
SELECT u.id AS user_id,
       coalesce((SELECT a.id FROM account a JOIN staff s ON s.id = a.holder_staff_id
                 WHERE a.kind = 'cash' AND s.user_id = u.id ORDER BY a.created_at, a.id LIMIT 1),
                (SELECT a.id FROM account a WHERE a.kind = 'cash' AND a.holder_staff_id IS NULL
                 ORDER BY a.created_at, a.id LIMIT 1),
                (SELECT a.id FROM account a WHERE a.kind = 'cash' ORDER BY a.created_at, a.id LIMIT 1)) AS account_id
FROM "user" u;
--> statement-breakpoint
-- Every movement of money in or out of an account, signed (in > 0). Cashbook, account balances and
-- the income/expense reconciliation all read this one view, so they tie out by construction.
-- Opening credit (receipt kind 'opening') is not money and is left out; transfers are two rows.
-- A cash receipt names the drawer it landed in (stored at insert since the M4 fix pass; older rows
-- were backfilled by migration 0016), so changing who holds a drawer never moves history. An
-- account's pre-pilot opening balance is one row of kind 'opening' on its as-of date (not P&L; the
-- reconciliation leaves it out).
CREATE VIEW money_movement AS
SELECT r.account_id AS account_id,
       r.business_date AS date, 'receipt' AS kind, r.kind AS subkind, r.id AS ref_id, r.receipt_no AS ref_no,
       r.amount AS amount, r.cash_session_id, r.collector_id AS by_user, r.created_at
FROM receipt r WHERE r.kind <> 'opening'
UNION ALL
SELECT e.account_id, e.date, 'expense', c.code, e.id, e.expense_no, -e.amount, e.cash_session_id, e.created_by, e.created_at
FROM expense e JOIN expense_category c ON c.id = e.category_id WHERE e.voided_by IS NULL
UNION ALL
SELECT sp.account_id, sp.date, 'salary', p.period_key, sp.id, p.id, -sp.amount, sp.cash_session_id, sp.created_by, sp.created_at
FROM salary_payment sp JOIN payslip p ON p.id = sp.payslip_id
UNION ALL
SELECT a.account_id, a.date, 'advance', NULL, a.id, a.staff_id, -a.amount, a.cash_session_id, a.created_by, a.created_at
FROM staff_advance a
UNION ALL
-- Both legs of a transfer and the opening balances in one term (D1 allows at most 5 terms in a
-- compound SELECT).
SELECT * FROM (
  SELECT t.from_account, t.date, 'transfer_out', NULL, t.id, t.to_account, -t.amount, t.cash_session_id, t.created_by, t.created_at
  FROM transfer t
  UNION ALL
  SELECT t.to_account, t.date, 'transfer_in', NULL, t.id, t.from_account, t.amount, NULL, t.created_by, t.created_at
  FROM transfer t
  UNION ALL
  SELECT a.id, a.opening_as_of, 'opening', NULL, a.id, NULL, a.opening_balance, NULL, a.created_by, a.opening_as_of
  FROM account a WHERE a.opening_as_of IS NOT NULL
);

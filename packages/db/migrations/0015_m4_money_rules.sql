-- source: sql/30_ledger.sql
DROP VIEW IF EXISTS ledger_consistency;
--> statement-breakpoint
DROP VIEW IF EXISTS payer_credit;
--> statement-breakpoint
DROP VIEW IF EXISTS charge_status;
--> statement-breakpoint
DROP VIEW IF EXISTS charge_net;
--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_sums;
--> statement-breakpoint
DROP TRIGGER IF EXISTS alloc_shape;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_within_credit;
--> statement-breakpoint
DROP TRIGGER IF EXISTS receipt_reversal_shape;
--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_negative_within_net;
--> statement-breakpoint
DROP TRIGGER IF EXISTS charge_parent_shape;
--> statement-breakpoint
-- Ledger invariants and derived views (experiment 1, hardened after the M0 review; ADR 0002).
-- Re-emitted in full by migration 0009 after 0008 rebuilt `receipt` (receipt kind 'opening', M3), and
-- by 0011 after 0010 rebuilt it again (methods 'cheque', 'other'), and by 0015 (M4: ledger_consistency
-- also flags drawer cash without a session, mis-numbered receipts, overpaid payslips, negative advances).
-- Charge tree: only `fee` rows are roots. concession / fine / reversal hang off a fee; fine_waiver (and a
-- reversal of a fine) hang off the fine, so a tree is at most two levels deep. Net = sum of the tree.
-- Allocations always target the root. Kind signs and the root rule are CHECKs on the table.

-- Children: right parent kind, same student and payer as the parent.
-- Concessions and fines belong to the family (PLAN §14.7: a sponsor is billed its share of the net and
-- is never fined); a sponsor root only ever takes a `reversal` child (a re-bill or a void). A fine is
-- only added to a root that still has money due.
CREATE TRIGGER charge_parent_shape BEFORE INSERT ON charge WHEN NEW.parent_charge_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid parent charge for this kind')
  WHERE NOT EXISTS (
    SELECT 1 FROM charge p
    WHERE p.id = NEW.parent_charge_id
      AND p.student_id = NEW.student_id AND p.payer_type = NEW.payer_type AND p.payer_id = NEW.payer_id
      AND CASE NEW.kind
            WHEN 'fine_waiver' THEN p.kind = 'fine'
            WHEN 'reversal' THEN p.kind IN ('fee', 'fine')
            ELSE p.kind = 'fee'
          END
  );
  SELECT RAISE(ABORT, 'concessions and fines are family lines; a sponsor root takes reversals only')
  WHERE NEW.kind IN ('concession', 'fine') AND NEW.payer_type <> 'family';
  SELECT RAISE(ABORT, 'a fine needs money still due on the fee')
  WHERE NEW.kind = 'fine'
    AND (SELECT coalesce(sum(amount), 0) FROM charge
         WHERE id = NEW.parent_charge_id OR parent_charge_id = NEW.parent_charge_id
            OR parent_charge_id IN (SELECT id FROM charge WHERE parent_charge_id = NEW.parent_charge_id))
      <= (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE charge_id = NEW.parent_charge_id);
END;
--> statement-breakpoint

-- A negative line can only take away what is still there: the parent's own subtree stays >= 0
-- (a fine_waiver never waives more than the fine), and the root's net never drops below what has
-- already been allocated to it. To cut a paid fee, release the allocation first, in the same batch.
CREATE TRIGGER charge_negative_within_net AFTER INSERT ON charge WHEN NEW.amount < 0
BEGIN
  SELECT RAISE(ABORT, 'line exceeds remaining net')
  WHERE (SELECT sum(amount) FROM charge
         WHERE id = NEW.parent_charge_id OR parent_charge_id = NEW.parent_charge_id
            OR parent_charge_id IN (SELECT id FROM charge WHERE parent_charge_id = NEW.parent_charge_id)) < 0;
  SELECT RAISE(ABORT, 'net would fall below allocated; release the allocation first')
  FROM (SELECT coalesce(parent_charge_id, id) AS root FROM charge WHERE id = NEW.parent_charge_id) r
  WHERE (SELECT sum(amount) FROM charge
         WHERE id = r.root OR parent_charge_id = r.root
            OR parent_charge_id IN (SELECT id FROM charge WHERE parent_charge_id = r.root))
      < (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE charge_id = r.root);
END;
--> statement-breakpoint

-- Reversal shape: mirrors exactly one payment (never a reversal or refund): same payer, same method,
-- exactly the negative amount. reverses_id is UNIQUE, so a payment is reversed at most once.
CREATE TRIGGER receipt_reversal_shape BEFORE INSERT ON receipt WHEN NEW.kind = 'reversal'
BEGIN
  SELECT RAISE(ABORT, 'reversal must mirror a payment exactly')
  WHERE NOT EXISTS (
    SELECT 1 FROM receipt o
    WHERE o.id = NEW.reverses_id AND o.kind = 'payment' AND o.amount = -NEW.amount
      AND o.payer_type = NEW.payer_type AND o.payer_id = NEW.payer_id AND o.method = NEW.method
  );
END;
--> statement-breakpoint

-- Payer credit (unallocated money) = Σ receipts (payment + reversal + refund, signed) − Σ allocations
-- (signed), per payer. It never goes below zero: a refund pays out at most the credit, and a positive
-- allocation (alloc_sums, below) spends at most the credit.
-- A reversal is inserted BEFORE its unwind allocations (they reference it), so at insert time its effect
-- is checked ASSUMING the unwinds follow in the same batch — packages/db/src/ledger reverseReceipt is the
-- only writer and always does this. The unwinds give back exactly what the payment still has allocated,
-- so: credit_now − |payment| + Σ payment allocations must stay >= 0 (e.g. a refund already paid that
-- credit out). A reversal inserted without its unwinds shows up in the ledger_consistency view.
CREATE TRIGGER receipt_within_credit AFTER INSERT ON receipt WHEN NEW.kind IN ('refund', 'reversal')
BEGIN
  SELECT RAISE(ABORT, 'refund exceeds unallocated credit')
  WHERE NEW.kind = 'refund'
    AND (SELECT coalesce(sum(amount), 0) FROM receipt
         WHERE payer_type = NEW.payer_type AND payer_id = NEW.payer_id)
      - (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
         WHERE r.payer_type = NEW.payer_type AND r.payer_id = NEW.payer_id) < 0;
  SELECT RAISE(ABORT, 'reversal would leave negative payer credit; the money was already paid out')
  WHERE NEW.kind = 'reversal'
    AND (SELECT coalesce(sum(amount), 0) FROM receipt
         WHERE payer_type = NEW.payer_type AND payer_id = NEW.payer_id)
      - (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
         WHERE r.payer_type = NEW.payer_type AND r.payer_id = NEW.payer_id)
      + (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE receipt_id = NEW.reverses_id) < 0;
END;
--> statement-breakpoint

CREATE TRIGGER alloc_shape BEFORE INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'allocation must target a root charge')
  WHERE (SELECT parent_charge_id FROM charge WHERE id = NEW.charge_id) IS NOT NULL;
  SELECT RAISE(ABORT, 'allocation payer must match the charge payer')
  WHERE NOT EXISTS (
    SELECT 1 FROM receipt r JOIN charge c ON c.id = NEW.charge_id
    WHERE r.id = NEW.receipt_id AND r.payer_type = c.payer_type AND r.payer_id = c.payer_id
  );
  SELECT RAISE(ABORT, 'a refund takes no allocations')
  WHERE (SELECT kind FROM receipt WHERE id = NEW.receipt_id) = 'refund';
  SELECT RAISE(ABORT, 'receipt has been reversed')
  WHERE EXISTS (SELECT 1 FROM receipt WHERE reverses_id = NEW.receipt_id);
END;
--> statement-breakpoint

-- Per (receipt, charge) pair, running sums decide (a negative row on a payment is a *release*):
--   payment (and opening credit, which behaves like one):  0 <= pair sum, sum over the receipt <= receipt amount, payer credit stays >= 0;
--   reversal: pair sum <= 0, and |pair sum| <= the reversed payment's pair sum on that charge.
-- One trigger so the checks run in a fixed order (the first violated rule names the error).
CREATE TRIGGER alloc_sums AFTER INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'release exceeds what this receipt allocated to the charge')
  FROM receipt r, (SELECT sum(amount) AS pair FROM receipt_allocation
                   WHERE receipt_id = NEW.receipt_id AND charge_id = NEW.charge_id) p
  WHERE r.id = NEW.receipt_id AND r.kind IN ('payment', 'opening') AND p.pair < 0;
  SELECT RAISE(ABORT, 'reversal can only unwind what the original allocated')
  FROM receipt r, (SELECT sum(amount) AS pair FROM receipt_allocation
                   WHERE receipt_id = NEW.receipt_id AND charge_id = NEW.charge_id) p
  WHERE r.id = NEW.receipt_id AND r.kind = 'reversal'
    AND (p.pair > 0
         OR -p.pair > (SELECT coalesce(sum(amount), 0) FROM receipt_allocation
                       WHERE receipt_id = r.reverses_id AND charge_id = NEW.charge_id));
  SELECT RAISE(ABORT, 'allocations exceed receipt amount')
  WHERE (SELECT abs(sum(amount)) FROM receipt_allocation WHERE receipt_id = NEW.receipt_id)
      > (SELECT abs(amount) FROM receipt WHERE id = NEW.receipt_id);
  -- Sum of allocations to a root charge <= its net (the whole tree).
  SELECT RAISE(ABORT, 'allocation exceeds charge net')
  WHERE (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE charge_id = NEW.charge_id)
      > (SELECT coalesce(sum(amount), 0) FROM charge
         WHERE id = NEW.charge_id OR parent_charge_id = NEW.charge_id
            OR parent_charge_id IN (SELECT id FROM charge WHERE parent_charge_id = NEW.charge_id));
  -- A positive row spends payer credit; it may not spend credit that was refunded or reversed away.
  SELECT RAISE(ABORT, 'allocation exceeds payer credit')
  FROM receipt p
  WHERE NEW.amount > 0 AND p.id = NEW.receipt_id
    AND (SELECT coalesce(sum(amount), 0) FROM receipt
         WHERE payer_type = p.payer_type AND payer_id = p.payer_id)
      - (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a JOIN receipt r ON r.id = a.receipt_id
         WHERE r.payer_type = p.payer_type AND r.payer_id = p.payer_id) < 0;
END;
--> statement-breakpoint

-- No stored balances anywhere: net, paid, due and credit are always derived.
CREATE VIEW charge_net AS
SELECT c.id, c.student_id, c.fee_head_id, c.period_key, c.payer_type, c.payer_id, c.due_date, c.kind,
       (SELECT coalesce(sum(x.amount), 0) FROM charge x
        WHERE x.id = c.id OR x.parent_charge_id = c.id
           OR x.parent_charge_id IN (SELECT y.id FROM charge y WHERE y.parent_charge_id = c.id)) AS net,
       (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a WHERE a.charge_id = c.id) AS paid
FROM charge c
WHERE c.parent_charge_id IS NULL;
--> statement-breakpoint

-- "Today" is the school day in Asia/Karachi (UTC+5, no DST), not the UTC date.
CREATE VIEW charge_status AS
SELECT *, net - paid AS due,
       CASE WHEN net - paid <= 0 THEN 'paid'
            WHEN paid > 0 THEN 'partial'
            WHEN due_date < date('now', '+5 hours') THEN 'overdue'
            ELSE 'due' END AS status
FROM charge_net;
--> statement-breakpoint

-- Unallocated credit per payer = receipts in (payments, reversals, refunds) - allocations.
CREATE VIEW payer_credit AS
SELECT r.payer_type, r.payer_id,
       sum(r.amount) - coalesce((SELECT sum(a.amount) FROM receipt_allocation a JOIN receipt ra ON ra.id = a.receipt_id
                                 WHERE ra.payer_type = r.payer_type AND ra.payer_id = r.payer_id), 0) AS credit
FROM receipt r
GROUP BY r.payer_type, r.payer_id;
--> statement-breakpoint

-- Rows that should never exist if every write went through the ledger helpers. Empty when healthy;
-- the nightly alarm on it is M6. For a payment (or opening credit), `expected` is the upper bound.
CREATE VIEW ledger_consistency AS
SELECT 'negative_credit' AS issue, payer_type, payer_id, NULL AS receipt_id, 0 AS expected, credit AS actual
FROM payer_credit
WHERE credit < 0
UNION ALL
SELECT issue, payer_type, payer_id, receipt_id, expected, actual
FROM (SELECT r.kind || '_allocations' AS issue, r.payer_type, r.payer_id, r.id AS receipt_id,
             CASE r.kind
               WHEN 'reversal' THEN -(SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a
                                      WHERE a.receipt_id = r.reverses_id)
               WHEN 'refund' THEN 0
               ELSE r.amount END AS expected,
             (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a WHERE a.receipt_id = r.id) AS actual
      FROM receipt r) x
WHERE CASE WHEN issue IN ('payment_allocations', 'opening_allocations') THEN actual < 0 OR actual > expected
           ELSE actual <> expected END
-- M4 (migration 0015): money shapes the triggers refuse today but older rows (or a hand edit) could
-- carry. `receipt_id` names the offending row (a receipt, expense or payslip); payer_type 'staff'
-- rows are payroll. Cash that touched a drawer must be in a session; every money receipt is
-- numbered from its series (`<series>-YYYY-NNNNN`, issued: below next_no). Nested in one term: D1
-- allows at most 5 terms in a compound SELECT.
UNION ALL
SELECT * FROM (
SELECT 'cash_receipt_no_session' AS issue, r.payer_type, r.payer_id, r.id AS receipt_id, 1 AS expected, 0 AS actual
FROM receipt r WHERE r.method = 'cash' AND r.kind <> 'opening' AND r.cash_session_id IS NULL
UNION ALL
SELECT 'receipt_no_format', r.payer_type, r.payer_id, r.id, 1, 0
FROM receipt r
WHERE r.kind <> 'opening'
  AND NOT EXISTS (SELECT 1 FROM receipt_series s
                  WHERE r.receipt_no = s.series || '-' || s.year || '-' || substr(r.receipt_no, -5)
                    AND substr(r.receipt_no, -5) GLOB '[0-9][0-9][0-9][0-9][0-9]'
                    AND CAST(substr(r.receipt_no, -5) AS INTEGER) BETWEEN 1 AND s.next_no - 1)
UNION ALL
SELECT 'expense_cash_no_session', 'expense', e.category_id, e.id, 1, 0
FROM expense e JOIN account a ON a.id = e.account_id
WHERE a.kind = 'cash' AND e.cash_session_id IS NULL
UNION ALL
SELECT 'payslip_overpaid', 'staff', p.staff_id, p.id,
       (SELECT coalesce(sum(CASE WHEN l.kind IN ('basic', 'allowance') THEN l.amount ELSE -l.amount END), 0)
        FROM payslip_line l WHERE l.payslip_id = p.id) AS expected,
       (SELECT coalesce(sum(s.amount), 0) FROM salary_payment s WHERE s.payslip_id = p.id) AS actual
FROM payslip p
WHERE (SELECT coalesce(sum(s.amount), 0) FROM salary_payment s WHERE s.payslip_id = p.id)
    > (SELECT coalesce(sum(CASE WHEN l.kind IN ('basic', 'allowance') THEN l.amount ELSE -l.amount END), 0)
       FROM payslip_line l WHERE l.payslip_id = p.id)
UNION ALL
SELECT 'advance_negative', 'staff', st.id, NULL, 0,
       (SELECT coalesce(sum(a.amount), 0) FROM staff_advance a WHERE a.staff_id = st.id)
     - (SELECT coalesce(sum(l.amount), 0) FROM payslip_line l JOIN payslip p ON p.id = l.payslip_id
        WHERE p.staff_id = st.id AND p.status IN ('approved', 'paid') AND l.kind = 'advance_recovery')
FROM staff st
WHERE (SELECT coalesce(sum(a.amount), 0) FROM staff_advance a WHERE a.staff_id = st.id)
    < (SELECT coalesce(sum(l.amount), 0) FROM payslip_line l JOIN payslip p ON p.id = l.payslip_id
       WHERE p.staff_id = st.id AND p.status IN ('approved', 'paid') AND l.kind = 'advance_recovery')
);
--> statement-breakpoint

-- source: sql/60_money_out.sql
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
-- Which account a cash receipt landed in: cash receipts name no account (they go to the collector's
-- drawer), so they belong to the cash account the collector holds, else the shared cash account
-- (no holder), else the first cash account.
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
CREATE VIEW money_movement AS
SELECT CASE WHEN r.method = 'cash' THEN (SELECT d.account_id FROM drawer_account d WHERE d.user_id = r.collector_id)
            ELSE r.account_id END AS account_id,
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
-- Both legs of a transfer in one term (D1 allows at most 5 terms in a compound SELECT).
SELECT * FROM (
  SELECT t.from_account, t.date, 'transfer_out', NULL, t.id, t.to_account, -t.amount, t.cash_session_id, t.created_by, t.created_at
  FROM transfer t
  UNION ALL
  SELECT t.to_account, t.date, 'transfer_in', NULL, t.id, t.from_account, t.amount, NULL, t.created_by, t.created_at
  FROM transfer t
);

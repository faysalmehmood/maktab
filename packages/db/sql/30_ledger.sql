-- Ledger invariants and derived views (experiment 1, hardened after the M0 review; ADR 0002).
-- Re-emitted in full by migration 0009 after 0008 rebuilt `receipt` (receipt kind 'opening', M3).
-- Charge tree: only `fee` rows are roots. concession / fine / reversal hang off a fee; fine_waiver (and a
-- reversal of a fine) hang off the fine, so a tree is at most two levels deep. Net = sum of the tree.
-- Allocations always target the root. Kind signs and the root rule are CHECKs on the table.

-- Children: right parent kind, same student and payer as the parent.
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
           ELSE actual <> expected END;

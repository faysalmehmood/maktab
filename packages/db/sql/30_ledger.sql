-- Ledger invariants and derived views (experiment 1, hardened after the M0 review; ADR 0002).
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

-- A refund pays credit back out; it can never exceed the payer's unallocated credit.
CREATE TRIGGER receipt_refund_within_credit AFTER INSERT ON receipt WHEN NEW.kind = 'refund'
BEGIN
  SELECT RAISE(ABORT, 'refund exceeds unallocated credit')
  WHERE (SELECT credit FROM payer_credit WHERE payer_type = NEW.payer_type AND payer_id = NEW.payer_id) < 0;
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
--   payment:  0 <= pair sum, and sum over the receipt <= receipt amount;
--   reversal: pair sum <= 0, and |pair sum| <= the reversed payment's pair sum on that charge.
-- One trigger so the checks run in a fixed order (the first violated rule names the error).
CREATE TRIGGER alloc_sums AFTER INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'release exceeds what this receipt allocated to the charge')
  FROM receipt r, (SELECT sum(amount) AS pair FROM receipt_allocation
                   WHERE receipt_id = NEW.receipt_id AND charge_id = NEW.charge_id) p
  WHERE r.id = NEW.receipt_id AND r.kind = 'payment' AND p.pair < 0;
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

-- Ledger invariants and derived views (proven in experiment 1, local and remote D1).
-- Root-charge rule: a root charge has parent_charge_id NULL; concession/fine/fine_waiver/reversal lines
-- hang off it. Net is computed per root; allocations always target the root.

-- Child lines hang off a root, never off another child, so net needs exactly one level of folding.
CREATE TRIGGER charge_parent_is_root BEFORE INSERT ON charge WHEN NEW.parent_charge_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'parent charge must be a root charge')
  WHERE (SELECT parent_charge_id FROM charge WHERE id = NEW.parent_charge_id) IS NOT NULL;
END;
--> statement-breakpoint

CREATE TRIGGER alloc_root_only BEFORE INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'allocation must target a root charge')
  WHERE (SELECT parent_charge_id FROM charge WHERE id = NEW.charge_id) IS NOT NULL;
END;
--> statement-breakpoint

-- Invariant A: |sum(allocations of a receipt)| <= |receipt amount| (sign-aware for reversals).
CREATE TRIGGER alloc_within_receipt AFTER INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'allocations exceed receipt amount')
  WHERE (SELECT abs(coalesce(sum(amount), 0)) FROM receipt_allocation WHERE receipt_id = NEW.receipt_id)
      > (SELECT abs(amount) FROM receipt WHERE id = NEW.receipt_id);
END;
--> statement-breakpoint

-- Invariant B: sum(allocations to a root charge) <= its net (itself + its child lines).
CREATE TRIGGER alloc_within_charge AFTER INSERT ON receipt_allocation
BEGIN
  SELECT RAISE(ABORT, 'allocation exceeds charge net')
  WHERE (SELECT coalesce(sum(amount), 0) FROM receipt_allocation WHERE charge_id = NEW.charge_id)
      > (SELECT coalesce(sum(amount), 0) FROM charge WHERE id = NEW.charge_id OR parent_charge_id = NEW.charge_id);
END;
--> statement-breakpoint

-- No stored balances anywhere: net, paid and due are always derived.
CREATE VIEW charge_net AS
SELECT c.id, c.student_id, c.fee_head_id, c.period_key, c.payer_type, c.payer_id, c.due_date, c.kind,
       (SELECT coalesce(sum(x.amount), 0) FROM charge x WHERE x.id = c.id OR x.parent_charge_id = c.id) AS net,
       (SELECT coalesce(sum(a.amount), 0) FROM receipt_allocation a WHERE a.charge_id = c.id) AS paid
FROM charge c
WHERE c.parent_charge_id IS NULL AND c.kind IN ('fee', 'fine');
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

/**
 * The counter's allocation preview, shared by the web screen, the M3b smoke and the API drift test
 * so the three can never disagree. It mirrors packages/db ledger/alloc.ts: `openDues` orders open
 * roots by `due_date, period_key, student name, student id, head name, charge id` (SQLite BINARY
 * comparison) and `oldestFirst` splits the amount in that order; the remainder is credit.
 */

/** The fields of an open root the preview needs (FeeLineDto has them all). */
export type AllocLine = {
  id: string;
  due: number;
  due_date: string;
  period_key: string;
  student_name: string;
  student_id: string;
  head_name: string;
};

/** The server's ORDER BY for open dues, as a tuple compared element by element. */
export const allocSortKey = (l: AllocLine): readonly string[] => [
  l.due_date,
  l.period_key,
  l.student_name,
  l.student_id,
  l.head_name,
  l.id,
];

/**
 * SQLite compares TEXT with BINARY collation, i.e. by UTF-8 bytes; for strings without surrogate
 * pairs this is the same as comparing UTF-16 code units, which is what `<` does.
 */
export function compareAllocLines(a: AllocLine, b: AllocLine): number {
  const ka = allocSortKey(a);
  const kb = allocSortKey(b);
  for (let i = 0; i < ka.length; i++) {
    const x = ka[i] as string;
    const y = kb[i] as string;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Open roots (due > 0) in the order the server allocates. */
export function openDuesInOrder<T extends AllocLine>(lines: readonly T[]): T[] {
  return lines.filter((l) => l.due > 0).sort(compareAllocLines);
}

export type AllocationRow<T extends AllocLine = AllocLine> = { line: T; amount: number };
export type AllocationPreview<T extends AllocLine = AllocLine> = {
  rows: AllocationRow<T>[];
  /** What is left after the dues: kept as the payer's credit (advance). */
  credit: number;
  /** Σ open dues − what this payment allocates (before any credit). */
  after: number;
};

function split<T extends AllocLine>(dues: readonly T[], amount: number, totalDue: number) {
  const rows: AllocationRow<T>[] = [];
  let left = amount;
  for (const d of dues) {
    if (left <= 0) break;
    const take = Math.min(left, d.due);
    if (take > 0) rows.push({ line: d, amount: take });
    left -= take;
  }
  const credit = Math.max(0, left);
  return { rows, credit, after: totalDue - (amount - credit) };
}

/** Oldest first across the payer; the remainder is credit (PLAN §14.4 step 3). */
export function previewOldestFirst<T extends AllocLine>(
  lines: readonly T[],
  amount: number,
): AllocationPreview<T> {
  const dues = openDuesInOrder(lines);
  return split(
    dues,
    amount,
    dues.reduce((a, d) => a + d.due, 0),
  );
}

/**
 * "Only Ali's March": the chosen lines in server order, each paid up to its due from the amount;
 * what is left is credit. The `directed` body sent is exactly these rows.
 */
export function previewDirected<T extends AllocLine>(
  lines: readonly T[],
  chosen: ReadonlySet<string>,
  amount: number,
): AllocationPreview<T> {
  const all = openDuesInOrder(lines);
  return split(
    all.filter((l) => chosen.has(l.id)),
    amount,
    all.reduce((a, d) => a + d.due, 0),
  );
}

/**
 * "Still owed after this", credit-aware: the open dues left after the allocation, less the payer's
 * existing credit and whatever this payment adds to it (floor 0).
 */
export const balanceAfter = (p: AllocationPreview, payerCredit: number): number =>
  Math.max(0, p.after - (payerCredit + p.credit));

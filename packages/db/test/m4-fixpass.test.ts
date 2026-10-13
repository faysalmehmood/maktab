import { newId } from '@maktab/shared';
import { type SQL, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import {
  accountBalances,
  cashbook,
  closeSession,
  collect,
  defaultLines,
  expensePhotoVersions,
  generateCharges,
  generationCursor,
  incomeExpense,
  openSession,
  recordExpense,
  reopenableGroups,
  reopenGroupPeriod,
  sessionFor,
  setAccountOpening,
  setExpensePhoto,
  suggestedRecovery,
  updateAccount,
  voidExpense,
} from '../src/ledger';
import { createTestDb } from '../src/node';

// M4 fix pass on better-sqlite3: drawer accounts stored on receipts and frozen holders (F4), account
// opening balances, the bill-photo rules (F5), voids after a close, already-open drawers, ≥ 5-digit
// numbers (F10), the recovery suggestion, and "Re-open period" (C4).

const RS = (n: number) => n * 100;
const T = '2026-10-05';
let db: AppDb;
const run = (...qs: string[]) =>
  atomic(
    db,
    () => qs.map((q) => rawStatement(db, sql.raw(q))) as [ReturnType<typeof rawStatement>],
  );
const all = <R = Record<string, unknown>>(q: SQL) => db.all<R>(q);

async function refused(fn: () => Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected refusal ${pattern}`).toBeDefined();
  const parts: string[] = [];
  for (let e: unknown = caught, d = 0; e && d < 5; d++) {
    parts.push(
      e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e),
    );
    e = e instanceof Error ? e.cause : undefined;
  }
  expect(parts.join(' | ')).toMatch(pattern);
}

beforeEach(async () => {
  db = createTestDb();
  await run(
    `INSERT INTO "user" (id, email, name, status) VALUES ('O','o@x.pk','Owner','active'),('A','a@x.pk','Admin','active'),('U2','acct@x.pk','Accountant','active'),('U3','b@x.pk','Second','active')`,
    `INSERT INTO role (user_id, role) VALUES ('O','owner'),('A','admin'),('U2','accountant'),('U3','accountant')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at) VALUES ('SCH','Test','R','2026-04-01')`,
    `INSERT INTO staff (id, user_id, name) VALUES ('ST_U2','U2','Accountant'),('ST_U3','U3','Second')`,
    `INSERT INTO account (id, name, kind) VALUES ('CASH','Drawers','cash'),('BANK','Bank','bank')`,
    `INSERT INTO family (id, name) VALUES ('F1','Khan')`,
  );
});

const cat = async (code = 'stationery') =>
  (await all<{ id: string }>(sql`SELECT id FROM expense_category WHERE code = ${code}`))[0]?.id ??
  '';
const cashIn = (by: string, amount = RS(1000)) =>
  collect(db, {
    payerType: 'family',
    payerId: 'F1',
    amount,
    method: 'cash',
    businessDate: T,
    today: T,
    collectorId: by,
    idempotencyKey: newId(),
  });

describe('F4: cash receipts keep the drawer they landed in; a holder is frozen after movements', () => {
  it('stores account_id at insert; a later holder change cannot move it', async () => {
    await cashIn('U3');
    const [r] = await all<{ account_id: string }>(sql`SELECT account_id FROM receipt`);
    expect(r?.account_id).toBe('CASH');
    // A new drawer for U3 changes where U3's NEXT cash goes, never the receipt already taken.
    await run(
      `INSERT INTO account (id, name, kind, holder_staff_id) VALUES ('D3','U3 drawer','cash','ST_U3')`,
    );
    await cashIn('U3', RS(500));
    const rows = await all<{ account_id: string; amount: number }>(
      sql`SELECT account_id, amount FROM receipt ORDER BY amount`,
    );
    expect(rows).toEqual([
      { account_id: 'D3', amount: RS(500) },
      { account_id: 'CASH', amount: RS(1000) },
    ]);
    const bal = await accountBalances(db);
    expect(bal.find((b) => b.account_id === 'CASH')?.balance).toBe(RS(1000));
    expect(bal.find((b) => b.account_id === 'D3')?.balance).toBe(RS(500));
    // D3 has moved money: its holder is fixed (helper 409, trigger backstop).
    await refused(
      () => updateAccount(db, { accountId: 'D3', holderStaffId: 'ST_U2', by: 'O' }),
      /account_has_movements/,
    );
    await refused(
      () => run(`UPDATE account SET holder_staff_id = NULL WHERE id = 'D3'`),
      /its holder is fixed/,
    );
    // A rename is fine; so is a holder change before any movement.
    await updateAccount(db, { accountId: 'D3', name: 'Front desk', by: 'O' });
    await run(`INSERT INTO account (id, name, kind) VALUES ('D4','Spare','cash')`);
    await updateAccount(db, { accountId: 'D4', holderStaffId: 'ST_U2', by: 'O' });
    expect(await all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });

  it('a raw cash receipt naming another drawer is refused', async () => {
    await run(
      `INSERT INTO account (id, name, kind, holder_staff_id) VALUES ('D3','U3 drawer','cash','ST_U3')`,
    );
    await openSession(db, { collectorId: 'U2', businessDate: T });
    const s = await sessionFor(db, 'U2', T);
    await refused(
      () =>
        run(
          `INSERT INTO receipt_series (series, year, next_no) VALUES ('R', 2026, 2)`,
          `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, account_id, collector_id, cash_session_id, business_date, idempotency_key) VALUES ('x','R-2026-00001','payment','family','F1',100,'cash','D3','U2','${s?.id}','${T}','k')`,
        ),
      /lands in its collector's own drawer/,
    );
  });
});

describe('account opening balances (pre-pilot)', () => {
  it('set once by the ledger before any movement; balances and the cashbook start from it', async () => {
    await setAccountOpening(db, {
      accountId: 'BANK',
      amount: RS(250000),
      asOf: '2026-09-30',
      today: T,
      by: 'O',
    });
    await setAccountOpening(db, {
      accountId: 'CASH',
      amount: RS(3000),
      asOf: '2026-09-30',
      today: T,
      by: 'O',
    });
    await refused(
      () =>
        setAccountOpening(db, {
          accountId: 'BANK',
          amount: 1,
          asOf: '2026-09-30',
          today: T,
          by: 'O',
        }),
      /opening_already_set/,
    );
    await refused(
      () => run(`UPDATE account SET opening_balance = 1 WHERE id = 'BANK'`),
      /opening balance is already set/,
    );
    await recordExpense(db, {
      categoryId: await cat('rent'),
      amount: RS(10000),
      accountId: 'BANK',
      date: '2026-10-02',
      by: 'U2',
      today: T,
    });
    const bal = await accountBalances(db);
    expect(bal.find((b) => b.account_id === 'BANK')?.balance).toBe(RS(240000));
    expect(bal.find((b) => b.account_id === 'CASH')?.balance).toBe(RS(3000));
    // As of before the opening date: nothing yet.
    expect(
      (await accountBalances(db, { asOf: '2026-09-29' })).find((b) => b.account_id === 'BANK')
        ?.balance,
    ).toBe(0);
    const oct = await cashbook(db, { accountId: 'BANK', from: '2026-10-01', to: '2026-10-31' });
    expect([oct.opening, oct.closing, oct.rows.map((r) => r.kind)]).toEqual([
      RS(250000),
      RS(240000),
      ['expense'],
    ]);
    const sep = await cashbook(db, { accountId: 'BANK', from: '2026-09-01', to: '2026-09-30' });
    expect([sep.opening, sep.rows.map((r) => [r.kind, r.amount, r.party]), sep.closing]).toEqual([
      0,
      [['opening', RS(250000), null]],
      RS(250000),
    ]);
    // Not P&L: the income/expense reconciliation still ties.
    const ie = await incomeExpense(db, { from: '2026-09', to: '2026-10' });
    expect([ie.reconciliation.movement, ie.reconciliation.ties]).toEqual([-RS(10000), true]);
    expect(await all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });

  it('refused once money has moved, in the future, or overdrawn for a drawer', async () => {
    await cashIn('U2');
    await refused(
      () =>
        setAccountOpening(db, {
          accountId: 'CASH',
          amount: RS(1),
          asOf: '2026-09-30',
          today: T,
          by: 'O',
        }),
      /account_has_movements/,
    );
    await refused(
      () =>
        run(
          `UPDATE account SET opening_balance = 1, opening_as_of = '2026-09-30' WHERE id = 'CASH'`,
        ),
      /opening balance is fixed/,
    );
    await refused(
      () =>
        setAccountOpening(db, {
          accountId: 'BANK',
          amount: RS(1),
          asOf: '2026-10-06',
          today: T,
          by: 'O',
        }),
      /future/,
    );
    await run(`INSERT INTO account (id, name, kind) VALUES ('C2','Other','cash')`);
    await refused(
      () => setAccountOpening(db, { accountId: 'C2', amount: -RS(1), asOf: T, today: T, by: 'O' }),
      /bank/,
    );
    await setAccountOpening(db, {
      accountId: 'BANK',
      amount: -RS(5000),
      asOf: T,
      today: T,
      by: 'O',
    });
  });
});

describe('F5: bill photo', () => {
  it('replace only before void, only by the recorder or an owner/admin; old keys kept', async () => {
    const e = await recordExpense(db, {
      categoryId: await cat(),
      amount: RS(100),
      accountId: 'BANK',
      by: 'U2',
      today: T,
    });
    await setExpensePhoto(db, { id: e.id, key: 'k1', by: 'U2', canReplaceAny: false });
    await refused(
      () => setExpensePhoto(db, { id: e.id, key: 'k2', by: 'U3', canReplaceAny: false }),
      /forbidden/,
    );
    await setExpensePhoto(db, { id: e.id, key: 'k2', by: 'A', canReplaceAny: true });
    await voidExpense(db, { id: e.id, reason: 'dup', by: 'A' });
    await refused(
      () => setExpensePhoto(db, { id: e.id, key: 'k3', by: 'A', canReplaceAny: true }),
      /already_void/,
    );
    expect((await expensePhotoVersions(db, e.id)).map((v) => [v.key, v.by, v.current])).toEqual([
      ['k1', 'U2', false],
      ['k2', 'A', true],
    ]);
  });
});

describe('drawer sessions (verify pass)', () => {
  it('opening an open drawer with another float is refused; the same float is a no-op', async () => {
    const s = await openSession(db, { collectorId: 'U2', businessDate: T, opening: RS(2000) });
    expect(
      (await openSession(db, { collectorId: 'U2', businessDate: T, opening: RS(2000) })).id,
    ).toBe(s.id);
    await refused(
      () => openSession(db, { collectorId: 'U2', businessDate: T, opening: RS(500) }),
      /already_open/,
    );
  });

  it('a drawer expense cannot be voided once its session is closed (helper and trigger)', async () => {
    await openSession(db, { collectorId: 'U2', businessDate: T });
    const e = await recordExpense(db, {
      categoryId: await cat(),
      amount: RS(100),
      accountId: 'CASH',
      by: 'U2',
      today: T,
    });
    const s = await sessionFor(db, 'U2', T);
    await closeSession(db, { sessionId: s?.id ?? '', counted: 0, by: 'U2' });
    await refused(() => voidExpense(db, { id: e.id, reason: 'late', by: 'A' }), /session_closed/);
    await refused(
      () => run(`UPDATE expense SET voided_by = 'A', void_reason = 'late' WHERE id = '${e.id}'`),
      /cash session is closed/,
    );
  });
});

describe('F10: numbers past 99,999', () => {
  it('a 6-digit receipt number is well-formed for ledger_consistency', async () => {
    await run(`INSERT INTO receipt_series (series, year, next_no) VALUES ('R', 2026, 100000)`);
    await cashIn('U2');
    const [r] = await all<{ receipt_no: string }>(sql`SELECT receipt_no FROM receipt`);
    expect(r?.receipt_no).toBe('R-2026-100000');
    expect(await all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
    // The next one, written by hand the way the helpers do it, is well-formed too.
    await run(
      `UPDATE receipt_series SET next_no = next_no + 1 WHERE series = 'R'`,
      `INSERT INTO receipt (id, receipt_no, kind, payer_type, payer_id, amount, method, account_id, collector_id, business_date, idempotency_key) VALUES ('b','R-2026-100001','payment','family','F1',100,'bank','BANK','U2','${T}','kb')`,
    );
    expect(await all(sql`SELECT issue FROM ledger_consistency`)).toEqual([]);
  });
});

describe('advance recovery suggestion (verify pass)', () => {
  it('is 25% of the net after other deductions, capped by the advance', () => {
    expect(suggestedRecovery(RS(100000), RS(30000) - RS(10000), 25)).toBe(RS(5000));
    const lines = defaultLines({
      baseSalary: RS(30000),
      allowances: [],
      deductions: [{ amount: RS(10000), note: 'unpaid leave' }],
      outstanding: RS(100000),
      pct: 25,
    });
    expect(lines.map((l) => [l.kind, l.amount])).toEqual([
      ['basic', RS(30000)],
      ['deduction', RS(10000)],
      ['advance_recovery', RS(5000)],
    ]);
  });
});

describe('C4: re-open a period for a group that finished with no fees', () => {
  it('a missing rate → 0 fees → re-open → Generate bills it; the log only grows', async () => {
    await run(
      `INSERT INTO session (id, name, start_date, end_date, is_current) VALUES ('SS','2026-27','2026-04-01','2027-03-31',1)`,
      `INSERT INTO programme (id, name, kind, seq) VALUES ('P5','Class 5','grade',5)`,
      `INSERT INTO grp (id, programme_id, session_id, name, is_primary, status) VALUES ('G5','P5','SS','A',1,'running')`,
      `INSERT INTO student (id, family_id, admission_no, name, admission_date) VALUES ('S1','F1','1','Ali','2026-04-01')`,
      `INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, status) VALUES ('E1','S1','G5',1,'2026-04-01','active')`,
      `INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI','Tuition','tuition','monthly')`,
    );
    const r1 = await generateCharges(db, { period: '2026-10', scope: { grpId: 'G5' }, by: 'A' });
    expect([r1.counts.fees, r1.group_done]).toEqual([0, true]);
    expect(await generationCursor(db, '2026-10')).toBeNull();
    expect(await reopenableGroups(db, '2026-10')).toEqual(['G5']);
    await run(
      `INSERT INTO fee_rate (id, fee_head_id, programme_id, amount, effective_from) VALUES ('R5','TUI','P5',${RS(3000)},'2026-04-01')`,
    );
    await reopenGroupPeriod(db, { period: '2026-10', grpId: 'G5', by: 'A' });
    expect(await generationCursor(db, '2026-10')).toEqual({ grp_id: 'G5', after_student_id: null });
    const r2 = await generateCharges(db, { period: '2026-10', scope: { grpId: 'G5' }, by: 'A' });
    expect(r2.counts.fees).toBe(1);
    expect(await reopenableGroups(db, '2026-10')).toEqual([]);
    await refused(
      () => reopenGroupPeriod(db, { period: '2026-10', grpId: 'G5', by: 'A' }),
      /not_reopenable/,
    );
    expect(
      (await all<{ status: string }>(sql`SELECT status FROM billing_chunk ORDER BY rowid`)).map(
        (k) => k.status,
      ),
    ).toEqual(['ok', 'reopened', 'ok']);
    await refused(
      () =>
        run(
          `INSERT INTO billing_chunk (id, run_id, kind, grp_id, done, status) SELECT 'x', id, 'fees', 'G5', 1, 'reopened' FROM billing_run`,
        ),
      /reopened group/,
    );
  });
});

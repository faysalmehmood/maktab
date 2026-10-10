import { type SQL, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AppDb, atomic, rawStatement } from '../src/client';
import {
  accountBalances,
  approvePayslip,
  closeSession,
  createPayslip,
  generatePayslips,
  openSession,
  paySalary,
  recordAdvance,
  recordExpense,
  sessionFor,
  setPayslipLines,
} from '../src/ledger';
import { createTestDb } from '../src/node';

/**
 * The M4 review's adversarial cases (scratchpad review-m4/adv.mts), one test each, in the reviewer's
 * order on one shared database (later cases build on earlier state, as in the script). "OK" cases
 * are legitimate and must pass; the rest must be refused by the helper (the clean 4xx) and, for raw
 * SQL, by a trigger. Outcomes that changed in the fix pass are marked.
 */

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

let stat = '';
const sid = async (s: string, p = '2026-10') =>
  (
    await all<{ id: string }>(
      sql`SELECT id FROM payslip WHERE staff_id = ${s} AND period_key = ${p}`,
    )
  )[0]?.id ?? '';
const nextExp = `UPDATE receipt_series SET next_no = next_no + 1 WHERE series = 'EXP'`;
const expNo = `(SELECT 'EXP-' || year || '-' || printf('%05d', next_no - 1) FROM receipt_series WHERE series = 'EXP')`;
let tslip = '';

beforeAll(async () => {
  db = createTestDb();
  await run(
    `INSERT INTO "user" (id, email, name, status) VALUES ('O','o@x.pk','Owner','active'),('O2','o2@x.pk','Owner2','active'),('A','a@x.pk','Admin','active'),('U2','acct@x.pk','Accountant','active'),('T','t@x.pk','Teacher','active')`,
    `INSERT INTO role (user_id, role) VALUES ('O','owner'),('O2','owner'),('A','admin'),('U2','accountant'),('T','teacher')`,
    `INSERT INTO school (id, name, receipt_prefix, setup_completed_at) VALUES ('SCH','Test','R','2026-04-01')`,
    `INSERT INTO staff (id, user_id, name, base_salary, allowances) VALUES ('ST_T','T','Teacher T',${RS(30000)},NULL),('ST_O','O','Owner O',${RS(80000)},NULL),('ST_A','A','Admin',${RS(40000)},NULL),('ST_Z',NULL,'Zero',NULL,NULL)`,
    `INSERT INTO account (id, name, kind) VALUES ('CASH','Drawers','cash'),('CASH2','Petty','cash'),('BANK','Bank','bank')`,
  );
  stat =
    (await all<{ id: string }>(sql`SELECT id FROM expense_category WHERE code = 'stationery'`))[0]
      ?.id ?? '';
});

describe('M4 adversarial cases (review-m4/adv.mts)', () => {
  it('fix pass: a cash advance with no open drawer is refused (never auto-opened)', async () => {
    await refused(
      () =>
        recordAdvance(db, {
          staffId: 'ST_T',
          amount: RS(3000),
          accountId: 'CASH',
          by: 'U2',
          today: T,
        }),
      /no_open_session/,
    );
    await openSession(db, { collectorId: 'U2', businessDate: T });
  });

  it('OK: advance before payslip (cash)', async () => {
    await recordAdvance(db, {
      staffId: 'ST_T',
      amount: RS(3000),
      accountId: 'CASH',
      by: 'U2',
      today: T,
    });
  });

  it('OK: advance from the bank, backdated', async () => {
    await recordAdvance(db, {
      staffId: 'ST_T',
      amount: RS(1000),
      accountId: 'BANK',
      date: '2026-09-28',
      by: 'U2',
      today: T,
    });
  });

  it('OK: bank expense backdated', async () => {
    const e = await recordExpense(db, {
      categoryId: stat,
      amount: RS(100),
      accountId: 'BANK',
      date: '2026-09-01',
      by: 'U2',
      today: T,
    });
    expect(e.expense_no).toBe('EXP-2026-00001');
    await generatePayslips(db, { periodKey: '2026-10', by: 'U2' });
    tslip = await sid('ST_T');
  });

  it('OK: an owner’s slip approved by a second owner', async () => {
    await approvePayslip(db, { id: await sid('ST_O'), by: 'O2' });
  });

  it('refused: an owner approving their own slip (helper, then raw)', async () => {
    await createPayslip(db, { staffId: 'ST_O', periodKey: '2026-11', by: 'U2' });
    const nov = await sid('ST_O', '2026-11');
    await refused(() => approvePayslip(db, { id: nov, by: 'O' }), /own_payslip/);
    await refused(
      async () =>
        run(
          `UPDATE payslip SET status='approved', approved_by='O' WHERE id='${await sid('ST_O', '2026-11')}'`,
        ),
      /cannot be approved by its own staff member/,
    );
  });

  it('OK: a slip with no deductions approved (admin’s slip by the owner)', async () => {
    await approvePayslip(db, { id: await sid('ST_A'), by: 'O' });
  });

  it('OK: bank salary with no drawer open', async () => {
    const r = await paySalary(db, {
      payslipId: await sid('ST_A'),
      amount: RS(40000),
      accountId: 'BANK',
      by: 'U2',
      today: T,
    });
    expect(r.status).toBe('paid');
  });

  it('fix pass: recovery 5,000 > outstanding 4,000 is refused when the lines are written', async () => {
    await refused(
      () =>
        setPayslipLines(db, {
          id: tslip,
          by: 'U2',
          lines: [
            { kind: 'basic', amount: RS(30000) },
            { kind: 'advance_recovery', amount: RS(5000) },
          ],
        }),
      /recovery_exceeds_advance/,
    );
  });

  it('refused: approving recovery 5,000 slipped in by hand (helper, then raw)', async () => {
    await run(
      `DELETE FROM payslip_line WHERE payslip_id = '${tslip}'`,
      `INSERT INTO payslip_line (id, payslip_id, kind, amount) VALUES ('b1','${tslip}','basic',${RS(30000)}),('r1','${tslip}','advance_recovery',${RS(5000)})`,
    );
    await refused(() => approvePayslip(db, { id: tslip, by: 'O' }), /recovery_exceeds_advance/);
    await refused(
      () => run(`UPDATE payslip SET status='approved', approved_by='O' WHERE id='${tslip}'`),
      /advance recovery exceeds outstanding advance/,
    );
  });

  it('OK: October recovery 4,000; refused: November recovering the same 4,000 again', async () => {
    await setPayslipLines(db, {
      id: tslip,
      by: 'U2',
      lines: [
        { kind: 'basic', amount: RS(30000) },
        { kind: 'advance_recovery', amount: RS(4000) },
      ],
    });
    // Written while October is still a draft: 4,000 is outstanding then.
    await createPayslip(db, {
      staffId: 'ST_T',
      periodKey: '2026-11',
      by: 'U2',
      lines: [
        { kind: 'basic', amount: RS(30000) },
        { kind: 'advance_recovery', amount: RS(4000) },
      ],
    });
    await approvePayslip(db, { id: tslip, by: 'O' });
    await refused(
      async () => approvePayslip(db, { id: await sid('ST_T', '2026-11'), by: 'O' }),
      /recovery_exceeds_advance/,
    );
    await refused(
      async () =>
        run(
          `UPDATE payslip SET status='approved', approved_by='O' WHERE id='${await sid('ST_T', '2026-11')}'`,
        ),
      /advance recovery exceeds outstanding advance/,
    );
  });

  it('refused: approved with no approver (raw)', async () => {
    await createPayslip(db, {
      staffId: 'ST_T',
      periodKey: '2026-12',
      by: 'U2',
      lines: [{ kind: 'basic', amount: RS(1) }],
    });
    await refused(
      async () =>
        run(`UPDATE payslip SET status='approved' WHERE id='${await sid('ST_T', '2026-12')}'`),
      /payslip_approved_by/,
    );
  });

  it('refused: approving a negative net (raw)', async () => {
    await createPayslip(db, {
      staffId: 'ST_T',
      periodKey: '2027-01',
      by: 'U2',
      lines: [{ kind: 'basic', amount: RS(100) }],
    });
    const id = await sid('ST_T', '2027-01');
    await run(
      `INSERT INTO payslip_line (id,payslip_id,kind,amount) VALUES ('nl','${id}','deduction',${RS(200)})`,
    );
    await refused(
      () => run(`UPDATE payslip SET status='approved', approved_by='O' WHERE id='${id}'`),
      /payslip net is negative/,
    );
  });

  it('OK: pay 20,000 cash; refused: 7,000 more (net 26,000) by helper and raw', async () => {
    expect(
      (
        await paySalary(db, {
          payslipId: tslip,
          amount: RS(20000),
          accountId: 'CASH',
          by: 'U2',
          today: T,
        })
      ).status,
    ).toBe('approved');
    await refused(
      () =>
        paySalary(db, {
          payslipId: tslip,
          amount: RS(7000),
          accountId: 'BANK',
          by: 'U2',
          today: T,
        }),
      /exceeds_net/,
    );
    await refused(
      () =>
        run(
          `INSERT INTO salary_payment (id,payslip_id,amount,account_id,date) VALUES ('sp9','${tslip}',${RS(7000)},'BANK','${T}')`,
        ),
      /salary payments exceed payslip net/,
    );
  });

  it('refused: marking a part-paid slip paid, voiding it, voiding without a reason (raw)', async () => {
    await refused(
      () => run(`UPDATE payslip SET status='paid' WHERE id='${tslip}'`),
      /not fully paid/,
    );
    await refused(
      () =>
        run(`UPDATE payslip SET status='void', voided_by='O', void_reason='x' WHERE id='${tslip}'`),
      /paid payslip cannot be voided/,
    );
    await refused(
      async () =>
        run(
          `UPDATE payslip SET status='void', voided_by='O' WHERE id='${await sid('ST_T', '2026-12')}'`,
        ),
      /needs who and a reason/,
    );
  });

  it('refused: made-up, reused and receipt-series expense numbers; a negative advance (raw)', async () => {
    await refused(
      () =>
        run(
          `INSERT INTO expense (id,expense_no,category_id,account_id,amount,date) VALUES ('e1','EXP-2026-99999','${stat}','BANK',100,'${T}')`,
        ),
      /next number of the EXP series/,
    );
    await refused(
      () =>
        run(
          `INSERT INTO expense (id,expense_no,category_id,account_id,amount,date) VALUES ('e2','EXP-2026-00001','${stat}','BANK',100,'${T}')`,
        ),
      /UNIQUE constraint failed: expense.expense_no/,
    );
    await refused(
      () =>
        run(
          `INSERT INTO receipt_series (series,year,next_no) VALUES ('R',2026,5)`,
          `INSERT INTO expense (id,expense_no,category_id,account_id,amount,date) VALUES ('e3','R-2026-00004','${stat}','BANK',100,'${T}')`,
        ),
      /next number of the EXP series/,
    );
    await refused(
      () =>
        run(
          `INSERT INTO staff_advance (id,staff_id,amount,account_id,date) VALUES ('a1','ST_T',-100,'BANK','${T}')`,
        ),
      /staff_advance_amount/,
    );
  });

  it('fix pass (F3): a cash expense on another drawer in my session is refused (raw and helper)', async () => {
    const s = await sessionFor(db, 'U2', T);
    await refused(
      () =>
        run(
          nextExp,
          `INSERT INTO expense (id,expense_no,category_id,account_id,cash_session_id,amount,date) VALUES ('e4',${expNo},'${stat}','CASH2','${s?.id}',100,'${T}')`,
        ),
      /cash leaves only the payer's own drawer/,
    );
    await refused(
      () =>
        recordExpense(db, {
          categoryId: stat,
          amount: RS(50),
          accountId: 'CASH2',
          by: 'U2',
          today: T,
        }),
      /not_your_drawer/,
    );
  });

  it('fix pass (F6): a transfer out of a drawer with no session is refused (raw)', async () => {
    await refused(
      () =>
        run(
          `INSERT INTO transfer (id,from_account,to_account,amount,date) VALUES ('tr1','CASH','BANK',100,'${T}')`,
        ),
      /transfer out of a drawer needs the holder's open cash session/,
    );
  });

  it('refused: cash out of a closed drawer (helper, raw, salary) or with no session (raw)', async () => {
    const s = await sessionFor(db, 'U2', T);
    await closeSession(db, { sessionId: s?.id ?? '', counted: 0, by: 'U2' });
    await refused(
      () =>
        recordExpense(db, {
          categoryId: stat,
          amount: RS(1),
          accountId: 'CASH',
          by: 'U2',
          today: T,
        }),
      /session_closed/,
    );
    await refused(
      () =>
        run(
          nextExp,
          `INSERT INTO expense (id,expense_no,category_id,account_id,cash_session_id,amount,date) VALUES ('e5',${expNo},'${stat}','CASH','${s?.id}',100,'${T}')`,
        ),
      /cash session is closed/,
    );
    await refused(
      () =>
        paySalary(db, { payslipId: tslip, amount: RS(100), accountId: 'CASH', by: 'U2', today: T }),
      /session_closed/,
    );
    await refused(
      () =>
        run(
          nextExp,
          `INSERT INTO expense (id,expense_no,category_id,account_id,amount,date) VALUES ('e6',${expNo},'${stat}','CASH',100,'${T}')`,
        ),
      /drawer expense needs a cash session/,
    );
  });

  it('fix pass (F7): a zero-net slip (full recovery) is paid on approval', async () => {
    await recordAdvance(db, {
      staffId: 'ST_T',
      amount: RS(500),
      accountId: 'BANK',
      by: 'U2',
      today: T,
    });
    await createPayslip(db, {
      staffId: 'ST_T',
      periodKey: '2027-02',
      by: 'U2',
      lines: [
        { kind: 'basic', amount: RS(500) },
        { kind: 'advance_recovery', amount: RS(500) },
      ],
    });
    const id = await sid('ST_T', '2027-02');
    await approvePayslip(db, { id, by: 'O' });
    expect(await all(sql`SELECT status, approved_by FROM payslip WHERE id = ${id}`)).toEqual([
      { status: 'paid', approved_by: 'O' },
    ]);
  });

  it('fix pass (F7): an empty slip (no lines) is paid on approval', async () => {
    await createPayslip(db, { staffId: 'ST_Z', periodKey: '2026-10', by: 'U2', lines: [] });
    const id = await sid('ST_Z');
    await approvePayslip(db, { id, by: 'O' });
    expect(
      (await all<{ status: string }>(sql`SELECT status FROM payslip WHERE id = ${id}`))[0]?.status,
    ).toBe('paid');
  });

  it('fix pass (F9): ledger_consistency is empty — a negative-net draft is not "overpaid"', async () => {
    expect(await all(sql`SELECT issue, receipt_id FROM ledger_consistency`)).toEqual([]);
  });

  it('the drawer and the cash account agree; CASH2 never moved', async () => {
    const s = await sessionFor(db, 'U2', T);
    const bal = await accountBalances(db);
    expect(s?.expected).toBe(-RS(3000) - RS(20000));
    expect(bal.find((b) => b.account_id === 'CASH')?.balance).toBe(s?.expected);
    expect(bal.find((b) => b.account_id === 'CASH2')?.balance).toBe(0);
  });
});

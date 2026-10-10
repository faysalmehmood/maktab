import type { AppDb } from '@maktab/db';
import { createTestDb } from '@maktab/db/node';
import {
  type CashbookDto,
  type ExpenseCategoryDto,
  type ExpenseDto,
  type IncomeExpenseDto,
  type MonthDashboardDto,
  newId,
  type PayslipDetailDto,
  type PayslipListDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { todayPk } from '../src/lib/http';
import { fakeR2, signedInAs, testApp } from './helpers';

// M4 fix pass over HTTP: owner-pay privacy on every money read an accountant can open (F1), the
// per-request query budget of "my payslips" (F2), own-drawer cash out (F3), account set-up (holder
// freeze, opening balance), bill photo rules (F5) and "Re-open period" (C4).

type Res<T> = { status: number; body: T; text: string };
function client(request: ReturnType<typeof testApp>['request'], cookie: string) {
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed as T, text };
  };
}

const RS = (n: number) => n * 100;
// Request bodies take ULIDs.
const ACC2 = newId();
const ACC = newId();
const G5 = newId();
const today = todayPk();
const period = today.slice(0, 7);

/** Counts the handler's raw reads (`db.all`; the auth middleware uses the query builder). */
function countingDb(db: AppDb) {
  const counter = { n: 0 };
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'all')
        return (...args: Parameters<AppDb['all']>) => {
          counter.n++;
          return target.all(...args);
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as AppDb;
  return { wrapped, counter };
}

async function setup() {
  const r2 = fakeR2();
  const base = createTestDb();
  const { wrapped, counter } = countingDb(base);
  const t = testApp({ db: wrapped, env: { FILES: r2.bucket } });
  const owner = await signedInAs(base, ['owner']);
  const admin = await signedInAs(base, ['admin']);
  const acct = await signedInAs(base, ['accountant']);
  const acct2 = await signedInAs(base, ['accountant']);
  const teacher = await signedInAs(base, ['teacher']);
  const as = {
    owner: client(t.request, owner.cookie),
    admin: client(t.request, admin.cookie),
    acct: client(t.request, acct.cookie),
    acct2: client(t.request, acct2.cookie),
    teacher: client(t.request, teacher.cookie),
  };
  await as.owner('PUT', '/api/school', { name: 'Al-Noor', mode: 'school', receipt_prefix: 'AN' });
  const cash = (
    await as.owner<{ account: { id: string } }>('POST', '/api/accounts', {
      name: 'Drawers',
      kind: 'cash',
    })
  ).body.account.id;
  const bank = (
    await as.owner<{ account: { id: string } }>('POST', '/api/accounts', {
      name: 'HBL',
      kind: 'bank',
    })
  ).body.account.id;
  await base.run(sql`INSERT INTO staff (id, user_id, name, role, base_salary) VALUES
    ('ST_OWN', ${owner.userId}, 'Principal Sahib', 'principal', ${RS(90000)}),
    ('ST_T', ${teacher.userId}, 'Teacher One', 'teacher', ${RS(30000)}),
    (${ACC}, ${acct.userId}, 'Accountant', 'accountant', ${RS(25000)}),
    (${ACC2}, ${acct2.userId}, 'Second', 'accountant', NULL)`);
  return {
    ...t,
    db: base,
    r2,
    as,
    users: { owner, admin, acct, acct2, teacher },
    cash,
    bank,
    counter,
  };
}

/** A month with salaries for the owner, a teacher and the accountant, paid from the bank. */
async function payroll(s: Awaited<ReturnType<typeof setup>>) {
  await s.as.owner('POST', '/api/payslips/generate', { period });
  const list = await s.as.owner<PayslipListDto>('GET', `/api/payslips?period=${period}`);
  for (const p of list.body.payslips) {
    const by = p.staff_id === 'ST_OWN' ? s.as.admin : s.as.owner;
    expect((await by('POST', `/api/payslips/${p.id}/approve`)).status).toBe(200);
    expect(
      (await s.as.admin('POST', `/api/payslips/${p.id}/pay`, { amount: p.net, account_id: s.bank }))
        .status,
    ).toBe(201);
  }
  // An owner advance from the bank too.
  expect(
    (
      await s.as.admin('POST', '/api/advances', {
        staff_id: 'ST_OWN',
        amount: RS(5000),
        account_id: s.bank,
      })
    ).status,
  ).toBe(201);
  return list.body.payslips;
}

describe('F1: owner pay is never visible to an accountant', () => {
  it('income-expense JSON + CSV, dashboard tile, cashbook JSON + CSV, salary and advance registers', async () => {
    const s = await setup();
    await payroll(s);
    const q = `from=${period}&to=${period}`;

    const own = await s.as.owner<IncomeExpenseDto>('GET', `/api/reports/income-expense?${q}`);
    expect(own.body.salaries).toEqual({ pay: RS(145000), slips: 3, scope: 'all' });
    expect(own.body.reconciliation.salary_paid).toBe(RS(145000));
    const acc = await s.as.acct<IncomeExpenseDto>('GET', `/api/reports/income-expense?${q}`);
    expect(acc.body.salaries).toEqual({ pay: RS(55000), slips: 2, scope: 'excluding_owners' });
    expect(acc.body.net).toBe(-RS(55000));
    expect(acc.body.months[0]?.salaries).toBe(RS(55000));
    expect(acc.body.reconciliation).toEqual({ ties: true });
    expect(acc.text).not.toContain('90000');

    const csvOwn = await s.as.owner('GET', `/api/reports/income-expense?${q}&format=csv`);
    expect(csvOwn.text).toContain('Salaries,145000');
    const csvAcc = await s.as.acct('GET', `/api/reports/income-expense?${q}&format=csv`);
    expect(csvAcc.text).toContain('Salaries (excluding management),55000');
    expect(csvAcc.text).not.toContain('145000');

    const dashOwn = await s.as.owner<MonthDashboardDto>(
      'GET',
      `/api/dashboard/month?period=${period}`,
    );
    expect([dashOwn.body.salaries, dashOwn.body.salaries_scope]).toEqual([RS(145000), 'all']);
    const dash = await s.as.acct<MonthDashboardDto>('GET', `/api/dashboard/month?period=${period}`);
    expect([dash.body.salaries, dash.body.salaries_scope, dash.body.net]).toEqual([
      RS(55000),
      'excluding_owners',
      -RS(55000),
    ]);

    const book = `/api/reports/cashbook?account_id=${s.bank}&from=${period}-01&to=${today}`;
    const bOwn = await s.as.owner<CashbookDto>('GET', book);
    expect(
      bOwn.body.rows
        .filter((r) => r.party === 'Principal Sahib')
        .map((r) => r.kind)
        .sort(),
    ).toEqual(['advance', 'salary']);
    const bAcc = await s.as.acct<CashbookDto>('GET', book);
    expect(bAcc.text).not.toContain('Principal Sahib');
    expect(
      bAcc.body.rows
        .filter((r) => r.kind === 'owner_draw')
        .map((r) => [r.party, r.amount, r.ref_id]),
    ).toEqual(
      expect.arrayContaining([
        ['—', -RS(90000), 'owner_draw'],
        ['—', -RS(5000), 'owner_draw'],
      ]),
    );
    expect(bAcc.body.closing).toBe(bOwn.body.closing); // the account's money is real either way
    const bCsv = await s.as.acct('GET', `${book}&format=csv`);
    expect(bCsv.text).toContain('owner_draw');
    expect(bCsv.text).not.toContain('Principal Sahib');

    for (const path of [
      `/api/reports/salaries?period=${period}&format=csv`,
      `/api/reports/salaries?period=${period}`,
      '/api/reports/advances?format=csv',
      '/api/reports/advances',
    ]) {
      const r = await s.as.acct('GET', path);
      expect(r.status, path).toBe(200);
      expect(r.text, path).not.toContain('Principal Sahib');
    }
    const regOwn = await s.as.owner('GET', `/api/reports/salaries?period=${period}&format=csv`);
    expect(regOwn.text).toContain('Principal Sahib');
  });
});

describe('F2: GET /api/payslips/mine reads in at most 4 queries, whatever the slip count', () => {
  it('1 slip and 6 slips cost the same', async () => {
    const s = await setup();
    const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
    const mk = async (p: string) => {
      const c = await s.as.owner<{ payslip: PayslipDetailDto }>('POST', '/api/payslips', {
        staff_id: 'ST_T',
        period: p,
      });
      await s.as.owner('POST', `/api/payslips/${c.body.payslip.id}/approve`);
      await s.as.owner('POST', `/api/payslips/${c.body.payslip.id}/pay`, {
        amount: RS(1000),
        account_id: s.bank,
      });
    };
    await mk(months[0] ?? '');
    s.counter.n = 0;
    const one = await s.as.teacher<{ payslips: PayslipDetailDto[] }>('GET', '/api/payslips/mine');
    const nOne = s.counter.n;
    expect(one.body.payslips).toHaveLength(1);
    for (const p of months.slice(1)) await mk(p);
    s.counter.n = 0;
    const six = await s.as.teacher<{ payslips: PayslipDetailDto[] }>('GET', '/api/payslips/mine');
    expect(six.body.payslips).toHaveLength(6);
    expect(s.counter.n).toBeLessThanOrEqual(4);
    expect(s.counter.n).toBe(nOne);
    const first = six.body.payslips.at(-1);
    expect([
      first?.period_key,
      first?.lines.length,
      first?.payments.length,
      first?.paid_partial,
    ]).toEqual(['2026-01', 1, 1, true]);
    expect(six.body.payslips[0]?.school.name).toBe('Al-Noor');
  });
});

describe('F3 / accounts: own drawer, holder freeze, opening balance', () => {
  it('cash leaves only my drawer; holders freeze after movement; the opening is the owner’s, once', async () => {
    const s = await setup();
    const cats = await s.as.acct<{ categories: ExpenseCategoryDto[] }>(
      'GET',
      '/api/expenses/categories',
    );
    const misc = cats.body.categories.find((c) => c.code === 'misc')?.id as string;
    // A drawer held by the second accountant.
    const held = await s.as.owner<{ account: { id: string } }>('POST', '/api/accounts', {
      name: 'Second drawer',
      kind: 'cash',
      holder_staff_id: ACC2,
    });
    const mine = await s.as.acct<{
      my_drawer: string;
      accounts: { id: string; has_movements: boolean }[];
    }>('GET', '/api/accounts');
    expect(mine.body.my_drawer).toBe(s.cash);
    expect((await s.as.acct2<{ my_drawer: string }>('GET', '/api/accounts')).body.my_drawer).toBe(
      held.body.account.id,
    );
    await s.as.acct('POST', '/api/cash/sessions', { opening: 0 });
    const other = await s.as.acct<{ error: { code: string } }>('POST', '/api/expenses', {
      category_id: misc,
      amount: RS(10),
      account_id: held.body.account.id,
    });
    expect([other.status, other.body.error.code]).toEqual([409, 'not_your_drawer']);
    const handover = await s.as.acct<{ error: { code: string } }>('POST', '/api/transfers', {
      from_account: held.body.account.id,
      to_account: s.bank,
      amount: RS(10),
    });
    expect([handover.status, handover.body.error.code]).toEqual([409, 'not_your_drawer']);
    expect(
      (
        await s.as.acct('POST', '/api/expenses', {
          category_id: misc,
          amount: RS(10),
          account_id: s.cash,
        })
      ).status,
    ).toBe(201);

    // The shared drawer has moved money: its holder is fixed; a fresh account can still be given one.
    const frozen = await s.as.owner<{ error: { code: string } }>('PUT', `/api/accounts/${s.cash}`, {
      holder_staff_id: ACC,
    });
    expect([frozen.status, frozen.body.error.code]).toEqual([409, 'account_has_movements']);
    expect(
      (await s.as.admin('PUT', `/api/accounts/${s.cash}`, { name: 'Main drawer' })).status,
    ).toBe(200);
    expect(
      (await s.as.admin('PUT', `/api/accounts/${held.body.account.id}`, { holder_staff_id: ACC }))
        .status,
    ).toBe(200);
    expect((await s.as.acct('PUT', `/api/accounts/${s.bank}`, { name: 'x' })).status).toBe(403);

    // Opening balance: owner only, once, before movements.
    const body = { amount: RS(250000), as_of: today };
    expect((await s.as.admin('POST', `/api/accounts/${s.bank}/opening`, body)).status).toBe(403);
    const set = await s.as.owner<{ account: { opening_balance: number; opening_as_of: string } }>(
      'POST',
      `/api/accounts/${s.bank}/opening`,
      body,
    );
    expect([set.status, set.body.account.opening_balance, set.body.account.opening_as_of]).toEqual([
      200,
      RS(250000),
      today,
    ]);
    const again = await s.as.owner<{ error: { code: string } }>(
      'POST',
      `/api/accounts/${s.bank}/opening`,
      body,
    );
    expect([again.status, again.body.error.code]).toEqual([409, 'opening_already_set']);
    const moved = await s.as.owner<{ error: { code: string } }>(
      'POST',
      `/api/accounts/${s.cash}/opening`,
      {
        amount: RS(1),
        as_of: today,
      },
    );
    expect([moved.status, moved.body.error.code]).toEqual([409, 'account_has_movements']);
    const bal = await s.as.owner<{ accounts: { account_id: string; balance: number }[] }>(
      'GET',
      '/api/reports/accounts',
    );
    expect(bal.body.accounts.find((a) => a.account_id === s.bank)?.balance).toBe(RS(250000));
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });
});

describe('F5: expense bill photo', () => {
  it('replace by recorder or owner/admin only, never on a void expense; old objects kept', async () => {
    const s = await setup();
    const cats = await s.as.acct<{ categories: ExpenseCategoryDto[] }>(
      'GET',
      '/api/expenses/categories',
    );
    const rent = cats.body.categories.find((c) => c.code === 'rent')?.id as string;
    const e = await s.as.acct<{ expense: ExpenseDto }>('POST', '/api/expenses', {
      category_id: rent,
      amount: RS(500),
      account_id: s.bank,
    });
    const id = e.body.expense.id;
    const upload = async (cookie: string) => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      const form = new FormData();
      form.set('file', new File([png], 'bill.png', { type: 'image/png' }));
      const req = new Request('http://x', { method: 'POST', body: form });
      const bytes = await req.arrayBuffer();
      return (
        await s.request(`/api/expenses/${id}/photo`, {
          method: 'POST',
          headers: {
            cookie,
            'content-type': req.headers.get('content-type') ?? '',
            'content-length': String(bytes.byteLength),
          },
          body: bytes,
        })
      ).status;
    };
    expect(await upload(s.users.acct.cookie)).toBe(200);
    expect(await upload(s.users.acct2.cookie)).toBe(403);
    expect(await upload(s.users.admin.cookie)).toBe(200);
    const keys = await s.db.all<{ key: string }>(
      sql`SELECT json_extract(diff, '$.after.receipt_key') AS key FROM audit
          WHERE entity = 'expense' AND entity_id = ${id} AND action = 'photo'`,
    );
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(await s.r2.bucket.get(k.key)).not.toBeNull();
    await s.as.admin('POST', `/api/expenses/${id}/void`, { reason: 'dup' });
    expect(await upload(s.users.admin.cookie)).toBe(409);
  });
});

describe('C4: re-open period over HTTP', () => {
  it('lists the group, owner/admin re-open it, Generate bills it', async () => {
    const s = await setup();
    await s.db.run(sql`INSERT INTO session (id, name, start_date, end_date, is_current)
      VALUES ('SS', '2026-27', '2026-04-01', '2027-03-31', 1)`);
    await s.db.run(
      sql`INSERT INTO programme (id, name, kind, seq) VALUES ('P5', 'Class 5', 'grade', 5)`,
    );
    await s.db.run(sql`INSERT INTO grp (id, programme_id, session_id, name, is_primary, status)
      VALUES (${G5}, 'P5', 'SS', 'A', 1, 'running')`);
    await s.db.run(sql`INSERT INTO family (id, name) VALUES ('F1', 'Khan')`);
    await s.db.run(sql`INSERT INTO student (id, family_id, admission_no, name, admission_date)
      VALUES ('S1', 'F1', '1', 'Ali', '2026-04-01')`);
    await s.db.run(sql`INSERT INTO enrolment (id, student_id, grp_id, is_primary, start_date, status)
      VALUES ('E1', 'S1', ${G5}, 1, '2026-04-01', 'active')`);
    await s.db.run(
      sql`INSERT INTO fee_head (id, name, kind, cadence) VALUES ('TUI', 'Tuition', 'tuition', 'monthly')`,
    );
    const p = '2026-10';
    const gen = () =>
      s.as.admin<{ counts: { fees: number } }>('POST', '/api/fees/generate', { period: p });
    expect((await gen()).body.counts.fees).toBe(0);
    const runs = await s.as.admin<{ reopenable: string[]; complete: boolean }>(
      'GET',
      `/api/fees/runs?period=${p}`,
    );
    expect([runs.body.complete, runs.body.reopenable]).toEqual([true, [G5]]);
    await s.db.run(sql`INSERT INTO fee_rate (id, fee_head_id, programme_id, amount, effective_from)
      VALUES ('R5', 'TUI', 'P5', ${RS(3000)}, '2026-04-01')`);
    expect(
      (await s.as.acct('POST', '/api/fees/runs/reopen', { period: p, grp_id: G5 })).status,
    ).toBe(403);
    const re = await s.as.admin<{ cursor: { grp_id: string } }>('POST', '/api/fees/runs/reopen', {
      period: p,
      grp_id: G5,
    });
    expect([re.status, re.body.cursor.grp_id]).toEqual([200, G5]);
    expect((await gen()).body.counts.fees).toBe(1);
    const no = await s.as.admin<{ error: { code: string } }>('POST', '/api/fees/runs/reopen', {
      period: p,
      grp_id: G5,
    });
    expect([no.status, no.body.error.code]).toEqual([409, 'not_reopenable']);
  });
});

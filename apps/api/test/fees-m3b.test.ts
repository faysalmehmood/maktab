import { oldestFirst, openDues } from '@maktab/db';
import {
  type AdmissionResult,
  type FamilyHitDto,
  type FamilyStatementDto,
  type FeeHeadDto,
  type GenerateResultDto,
  type GroupDto,
  newId,
  type ProgrammeDto,
  previewOldestFirst,
  type UnbilledDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { todayPk } from '../src/lib/http';
import { signedInAs, testApp } from './helpers';

// M3b fix pass over HTTP: generate commit counts, unbilled enrolments + per-student billing, fines
// on the family statement + waiver, refunds from credit to a named account, counter search by
// family/guardian name, fine preview names, reminder skips, and the shared preview = the planner.

type Res<T> = { status: number; body: T };
function client(request: ReturnType<typeof testApp>['request'], cookie: string) {
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
}

const RS = (n: number) => n * 100;
const today = todayPk();
const period = today.slice(0, 7);
const prevPeriod = (() => {
  const d = new Date(`${period}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();
const year = Number(today.slice(0, 4));

async function setup() {
  const t = testApp();
  const owner = await signedInAs(t.db, ['owner']);
  const api = client(t.request, owner.cookie);
  await api('PUT', '/api/school', { name: 'Al-Noor', mode: 'school', receipt_prefix: 'AN' });
  await api('POST', '/api/sessions', {
    name: 'S',
    start_date: `${year - 1}-01-01`,
    end_date: `${year + 1}-12-31`,
  });
  const progs = await api<{ items: ProgrammeDto[] }>('POST', '/api/programmes/seed-pk');
  const p5 = progs.body.items.find((p) => p.name === 'Class 5')?.id as string;
  const g5a = (await api<GroupDto>('POST', '/api/groups', { programme_id: p5, name: '5-A' })).body;
  const tui = (
    await api<{ head: FeeHeadDto }>('POST', '/api/fees/heads', {
      name: 'Tuition',
      kind: 'tuition',
      cadence: 'monthly',
    })
  ).body.head;
  expect(
    (
      await api('POST', '/api/fees/rates', {
        fee_head_id: tui.id,
        programme_id: p5,
        amount: RS(3000),
        effective_from: `${year - 1}-01-01`,
      })
    ).status,
  ).toBe(201);
  await api('PUT', '/api/school/fees', {
    fine_rule: { enabled: true, grace_day: 10, type: 'fixed', value: RS(200), cap: null },
    sibling_rule: [],
    reminder_cooldown_days: 7,
  });
  await t.db.run(sql`UPDATE school SET setup_completed_at = ${today}`);
  return { ...t, owner, api, p5, g5a, tui };
}

const admit = (
  s: Awaited<ReturnType<typeof setup>>,
  name: string,
  o: { familyId?: string; charge?: boolean; guardian?: string } = {},
) =>
  s.api<AdmissionResult>('POST', '/api/admissions', {
    ...(o.familyId
      ? { family_id: o.familyId }
      : {
          family: { name: `${name} family` },
          guardians: [
            {
              name: o.guardian ?? `${name} father`,
              phone: `0300${String(Math.floor(1e6 + Math.random() * 8e6))}`,
              consent_whatsapp: true,
            },
          ],
        }),
    student: { name, admission_date: `${prevPeriod}-01` },
    enrolment: { grp_id: s.g5a.id, start_date: `${prevPeriod}-01` },
    fees: { charge: o.charge ?? true },
  });

const feeRows = async (s: Awaited<ReturnType<typeof setup>>, p: string) =>
  (
    await s.db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM charge WHERE kind = 'fee' AND period_key = ${p}`,
    )
  )[0]?.n ?? 0;

async function generate(s: Awaited<ReturnType<typeof setup>>, p: string, dryRun = false) {
  const totals = { fees: 0, concessions: 0, sponsored: 0, allocations: 0 };
  let next: GenerateResultDto['next'] = null;
  do {
    const r: Res<GenerateResultDto> = await s.api<GenerateResultDto>('POST', '/api/fees/generate', {
      period: p,
      dry_run: dryRun,
      ...(next ? { grp_id: next.grp_id, after_student_id: next.after_student_id } : {}),
    });
    expect(r.status).toBe(200);
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r.body.counts[k];
    next = r.body.next;
  } while (next);
  return totals;
}

describe('generate (commit) reports what it inserted', () => {
  it('counts equal the rows written; a second run reports 0 new', async () => {
    const s = await setup();
    await admit(s, 'Ali', { charge: false });
    await admit(s, 'Bilal', { charge: false });
    const before = await feeRows(s, period);
    const dry = await generate(s, period, true);
    expect(dry.fees).toBe(2);
    const done = await generate(s, period);
    expect(done.fees).toBe((await feeRows(s, period)) - before);
    expect(done.fees).toBe(2);
    expect((await generate(s, period)).fees).toBe(0);
    expect(await feeRows(s, period)).toBe(before + 2);
  });
});

describe('unbilled enrolments + per-student "Bill now"', () => {
  it('lists live enrolments with no monthly fee; regenerate bills one; owner/admin only', async () => {
    const s = await setup();
    const a = await admit(s, 'Ali', { charge: false });
    await admit(s, 'Zara', { charge: true });
    const list = await s.api<UnbilledDto>('GET', `/api/fees/unbilled?period=${period}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      period,
      items: [
        {
          student_id: a.body.student_id,
          student_name: 'Ali',
          admission_no: expect.any(String),
          enrolment_id: expect.any(String),
          grp_id: s.g5a.id,
          group_name: 'Class 5 5-A',
          start_date: `${prevPeriod}-01`,
        },
      ],
      more: false,
    });
    const r = await s.api<GenerateResultDto>('POST', '/api/fees/regenerate', {
      student_id: a.body.student_id,
      period,
    });
    expect(r.status).toBe(200);
    expect(r.body.counts.fees).toBe(1);
    expect(
      (await s.api<UnbilledDto>('GET', `/api/fees/unbilled?period=${period}`)).body.items,
    ).toEqual([]);
    for (const role of ['accountant', 'teacher'] as const) {
      const u = await signedInAs(s.db, [role]);
      const res = await client(s.request, u.cookie)('GET', `/api/fees/unbilled?period=${period}`);
      expect(res.status).toBe(403);
    }
  });
});

describe('fines on the family statement, waiver, refund, search', () => {
  it('a fine is listed with what is left; waiving it zeroes `left`', async () => {
    const s = await setup();
    const a = await admit(s, 'Ali');
    const fam = a.body.family_id;
    const fines = await s.api<{
      planned: { student_id: string; student_name: string | null; period_key: string }[];
    }>('POST', '/api/fees/fines/apply', { dry_run: true, as_of: `${year + 1}-12-01` });
    expect(fines.body.planned.map((f) => f.student_name)).toContain('Ali');
    await s.api('POST', '/api/fees/fines/apply', { dry_run: false, as_of: `${year + 1}-12-01` });
    const st = await s.api<FamilyStatementDto>('GET', `/api/fees/family/${fam}`);
    const fine = st.body.fines[0];
    expect(fine).toMatchObject({ amount: RS(200), waived: 0, left: RS(200) });
    expect(st.body.charges.some((c) => c.id === fine?.root_id && c.fine === RS(200))).toBe(true);
    const w = await s.api('POST', `/api/fees/fines/${fine?.id}/waive`, { reason: 'first time' });
    expect(w.status).toBe(201);
    const after = await s.api<FamilyStatementDto>('GET', `/api/fees/family/${fam}`);
    expect(after.body.fines.find((f) => f.id === fine?.id)).toMatchObject({
      waived: RS(200),
      left: 0,
    });
  });

  it('refund from credit to a named bank account; replay with the same key', async () => {
    const s = await setup();
    const a = await admit(s, 'Ali');
    const fam = a.body.family_id;
    const bank = (
      await s.api<{ account: { id: string } }>('POST', '/api/accounts', {
        name: 'HBL',
        kind: 'bank',
      })
    ).body.account.id;
    const bank2 = (
      await s.api<{ account: { id: string } }>('POST', '/api/accounts', {
        name: 'Meezan',
        kind: 'bank',
      })
    ).body.account.id;
    const st = await s.api<FamilyStatementDto>('GET', `/api/fees/family/${fam}`);
    const pay = await s.api('POST', '/api/receipts', {
      idempotency_key: `k-${newId()}`,
      payer_id: fam,
      amount: st.body.totals.due + RS(1000),
      method: 'bank',
      account_id: bank,
      expected_due_hash: st.body.dues_hash,
    });
    expect(pay.status).toBe(201);
    const key = `rfd-${newId()}`;
    const body = {
      idempotency_key: key,
      payer_id: fam,
      amount: RS(600),
      method: 'bank',
      account_id: bank2,
      reason: 'moved away',
    };
    const r = await s.api<{ receipt: { kind: string; account_id: string; amount: number } }>(
      'POST',
      '/api/refunds',
      body,
    );
    expect(r.status).toBe(201);
    expect(r.body.receipt).toMatchObject({ kind: 'refund', account_id: bank2 });
    const again = await s.api<{ replayed: boolean }>('POST', '/api/refunds', body);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    const credit = (await s.api<FamilyStatementDto>('GET', `/api/fees/family/${fam}`)).body.credit;
    expect(credit).toBe(RS(400));
  });

  it('counter search finds a family by its own name and by a guardian name', async () => {
    const s = await setup();
    const a = await admit(s, 'Ali', { guardian: 'Tariq Mehmood' });
    const byFamily = await s.api<{ families: FamilyHitDto[] }>(
      'GET',
      `/api/fees/search?q=${encodeURIComponent('Ali fam')}`,
    );
    expect(byFamily.body.families.map((f) => f.family_id)).toContain(a.body.family_id);
    const byGuardian = await s.api<{ families: FamilyHitDto[] }>(
      'GET',
      `/api/fees/search?q=${encodeURIComponent('Mehmood')}`,
    );
    expect(byGuardian.body.families.map((f) => f.family_id)).toEqual([a.body.family_id]);
  });

  it('Remind all reports families skipped for the cooldown on a re-run', async () => {
    const s = await setup();
    await admit(s, 'Ali');
    const first = await s.api<{ queued: number; skipped: number }>(
      'POST',
      '/api/fees/defaulters/remind',
      { template: 'fee_due' },
    );
    expect(first.body).toMatchObject({ queued: 1, skipped: 0 });
    const again = await s.api<{ queued: number; skipped: number }>(
      'POST',
      '/api/fees/defaulters/remind',
      { template: 'fee_due' },
    );
    expect(again.body).toMatchObject({ queued: 0, skipped: 1 });
  });
});

describe('drift: the shared counter preview equals the server planner', () => {
  it('previewOldestFirst (web, smoke) = openDues + oldestFirst (ledger) on a two-child family', async () => {
    const s = await setup();
    const a = await admit(s, 'Zainab', { charge: false });
    await admit(s, 'Ahmed', { familyId: a.body.family_id, charge: false });
    await admit(s, 'Ahmed', { familyId: a.body.family_id, charge: false });
    await generate(s, prevPeriod);
    await generate(s, period);
    const fam = a.body.family_id;
    const st = (await s.api<FamilyStatementDto>('GET', `/api/fees/family/${fam}`)).body;
    const dues = await openDues(s.db, 'family', fam);
    expect(dues.length).toBe(6);
    const total = dues.reduce((x, d) => x + d.due, 0);
    for (const amount of [1, RS(2999), RS(3000), RS(7500), total - 1, total, total + RS(50)]) {
      const web = previewOldestFirst(st.charges, amount);
      const server = oldestFirst(dues, amount);
      expect(web.rows.map((r) => [r.line.id, r.amount])).toEqual(
        server.rows.map((r) => [r.chargeId, r.amount]),
      );
      expect(web.credit).toBe(Math.max(0, server.left));
    }
  });
});

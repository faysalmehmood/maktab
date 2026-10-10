import { staff } from '@maktab/db';
import {
  type AdmissionResult,
  type CollectResultDto,
  type DefaulterDto,
  type FamilyStatementDto,
  type FeeHeadDto,
  type GenerateResultDto,
  type GroupDto,
  newId,
  type ProgrammeDto,
  type ReceiptPrintDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { todayPk } from '../src/lib/http';
import { signedInAs, testApp } from './helpers';

// M3 over HTTP (better-sqlite3): admission billing with the sibling rule, the counter, print JSON,
// reversal + re-entry, teacher scope, cash sessions, register CSV, reminders. D1: d1-fees.test.ts.

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
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed as T, text };
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

/** School + session + Class 5 (two sections) + heads/rates + fee settings, all over HTTP. */
async function setup() {
  const t = testApp();
  const owner = await signedInAs(t.db, ['owner']);
  const api = client(t.request, owner.cookie);
  expect(
    (
      await api('PUT', '/api/school', {
        name: 'Al-Noor',
        name_ur: 'النور',
        mode: 'school',
        receipt_prefix: 'AN',
      })
    ).status,
  ).toBe(200);
  const year = Number(today.slice(0, 4));
  expect(
    (
      await api('POST', '/api/sessions', {
        name: 'S',
        start_date: `${year - 1}-01-01`,
        end_date: `${year + 1}-12-31`,
      })
    ).status,
  ).toBe(201);
  const progs = await api<{ items: ProgrammeDto[] }>('POST', '/api/programmes/seed-pk');
  const p5 = progs.body.items.find((p) => p.name === 'Class 5')?.id as string;
  const g5a = (await api<GroupDto>('POST', '/api/groups', { programme_id: p5, name: '5-A' })).body;
  const g5b = (await api<GroupDto>('POST', '/api/groups', { programme_id: p5, name: '5-B' })).body;
  const tui = (
    await api<{ head: FeeHeadDto }>('POST', '/api/fees/heads', {
      name: 'Tuition',
      name_ur: 'ٹیوشن فیس',
      kind: 'tuition',
      cadence: 'monthly',
    })
  ).body.head;
  const adm = (
    await api<{ head: FeeHeadDto }>('POST', '/api/fees/heads', {
      name: 'Admission',
      name_ur: 'داخلہ فیس',
      kind: 'admission',
      cadence: 'once',
    })
  ).body.head;
  const from = `${year - 1}-01-01`;
  for (const body of [
    { fee_head_id: tui.id, programme_id: p5, amount: RS(3000), effective_from: from },
    { fee_head_id: tui.id, grp_id: g5b.id, amount: RS(3500), effective_from: from },
    { fee_head_id: adm.id, programme_id: p5, amount: RS(5000), effective_from: from },
  ])
    expect((await api('POST', '/api/fees/rates', body)).status).toBe(201);
  expect(
    (
      await api('PUT', '/api/school/fees', {
        fine_rule: { enabled: true, grace_day: 10, type: 'fixed', value: RS(200), cap: null },
        sibling_rule: [{ nth: 2, pct: 10 }],
        reminder_cooldown_days: 7,
      })
    ).status,
  ).toBe(200);
  await t.db.run(sql`UPDATE school SET setup_completed_at = ${today}`);
  return { ...t, owner, api, p5, g5a, g5b, tui, adm };
}

const admitNew = (
  api: ReturnType<typeof client>,
  grpId: string,
  name: string,
  o: { familyId?: string; consent?: boolean; start?: string; fees?: Record<string, unknown> } = {},
) =>
  api<AdmissionResult>('POST', '/api/admissions', {
    ...(o.familyId
      ? { family_id: o.familyId }
      : {
          family: { name: `${name} family` },
          guardians: [
            {
              name: `${name} father`,
              phone: `0300${String(Math.floor(1e6 + Math.random() * 8e6))}`,
              consent_whatsapp: o.consent ?? true,
            },
          ],
        }),
    student: { name, admission_date: o.start ?? `${prevPeriod}-01` },
    enrolment: { grp_id: grpId, start_date: o.start ?? `${prevPeriod}-01` },
    ...(o.fees ? { fees: o.fees } : {}),
  });

describe('admission bills the first period in the same batch', () => {
  it('new family, then a sibling with the auto concession; the preview matches; re-admission bills too', async () => {
    const s = await setup();
    const preview = await s.api<{
      fees: {
        charges: { fee_head_id: string; amount: number }[];
        sibling: { nth: number; pct: number };
      };
    }>('GET', `/api/admissions/preview-fees?grp_id=${s.g5a.id}&start_date=${prevPeriod}-01`);
    expect(preview.status).toBe(200);
    expect(preview.body.fees.sibling).toEqual({ nth: 1, pct: 0, applied: false });
    const a = await admitNew(s.api, s.g5a.id, 'Ali');
    expect(a.status).toBe(201);
    expect(a.body.fees?.period).toBe(period);
    expect(a.body.fees?.charges.map((c) => [c.fee_head_id, c.amount]).sort()).toEqual(
      [
        [s.tui.id, RS(3000)],
        [s.adm.id, RS(5000)],
      ].sort(),
    );
    const p2 = await s.api<{
      fees: { sibling: { nth: number; pct: number }; total_family: number };
    }>(
      'GET',
      `/api/admissions/preview-fees?grp_id=${s.g5b.id}&family_id=${a.body.family_id}&start_date=${prevPeriod}-01`,
    );
    expect(p2.body.fees.sibling).toMatchObject({ nth: 2, pct: 10 });
    const b = await admitNew(s.api, s.g5b.id, 'Sara', { familyId: a.body.family_id });
    expect(b.body.fees?.sibling).toEqual({ nth: 2, pct: 10, applied: true });
    // 5-B tuition Rs 3,500 less 10% = Rs 350 concession line; admission fee is not tuition.
    expect(
      b.body.fees?.charges.filter((c) => c.kind === 'concession').map((c) => c.amount),
    ).toEqual([-RS(350)]);
    expect(b.body.fees?.total_family).toBe(p2.body.fees.total_family);
    const [k] = await s.db.all<{ reason: string; value: number }>(
      sql`SELECT reason, value FROM concession WHERE student_id = ${b.body.student_id}`,
    );
    expect(k).toEqual({ reason: 'sibling', value: 10 });
    // Opt-out and pro-rata are explicit.
    const c = await admitNew(s.api, s.g5a.id, 'Hina', {
      familyId: a.body.family_id,
      start: today,
      fees: { sibling_concession: false, pro_rata: true },
    });
    expect(c.body.fees?.sibling.applied).toBe(false);
    // Re-admission: leave, then come back — billed in the same batch, admission fee again.
    expect(
      (
        await s.api('POST', `/api/students/${c.body.student_id}/status`, {
          status: 'left',
          date: today,
          reason: 'moved',
        })
      ).status,
    ).toBe(200);
    await s.db.run(
      sql`UPDATE enrolment SET status = 'withdrawn', end_date = ${today} WHERE student_id = ${c.body.student_id}`,
    );
    // Next month (the same month is already billed: one root per student, head and period).
    const nx = new Date(`${period}-01T00:00:00Z`);
    nx.setUTCMonth(nx.getUTCMonth() + 1);
    const nextStart = `${nx.toISOString().slice(0, 7)}-01`;
    const re = await s.api<AdmissionResult>('POST', '/api/admissions', {
      readmit_student_id: c.body.student_id,
      enrolment: { grp_id: s.g5a.id, start_date: nextStart },
      fees: { sibling_concession: false },
    });
    expect(re.status).toBe(201);
    expect(re.body.fees?.charges.map((x) => x.fee_head_id)).toContain(s.adm.id);
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });
});

describe('the fee counter over HTTP', () => {
  async function family() {
    const s = await setup();
    const a = await admitNew(s.api, s.g5a.id, 'Ali');
    const b = await admitNew(s.api, s.g5b.id, 'Sara', { familyId: a.body.family_id });
    // Previous month too, so something is overdue whatever today's date is.
    let next: GenerateResultDto['next'] | undefined;
    do {
      const g = await s.api<GenerateResultDto>('POST', '/api/fees/generate', {
        period: prevPeriod,
        ...(next ? { grp_id: next.grp_id, after_student_id: next.after_student_id } : {}),
      });
      expect(g.status).toBe(200);
      next = g.body.next;
    } while (next);
    return { ...s, fam: a.body.family_id, ali: a.body.student_id, sara: b.body.student_id };
  }

  it('collects oldest first, replays by key, prints with Urdu labels, reverses and re-enters', async () => {
    const s = await family();
    const st = await s.api<FamilyStatementDto>('GET', `/api/fees/family/${s.fam}`);
    // prev: Ali 3000 + Sara 3150; now: Ali 3000+5000, Sara 3150+5000.
    expect(st.body.totals.due).toBe(RS(3000 + 3150 + 8000 + 8150));
    const search = await s.api<{ families: { family_id: string; due: number }[] }>(
      'GET',
      '/api/fees/search?q=Sara',
    );
    expect(search.body.families[0]).toMatchObject({ family_id: s.fam, due: st.body.totals.due });
    const key = newId();
    const body = { idempotency_key: key, payer_id: s.fam, amount: RS(7000), method: 'cash' };
    const r = await s.api<CollectResultDto>('POST', '/api/receipts', body);
    expect(r.status).toBe(201);
    expect(r.body.receipt.receipt_no).toBe(`AN-${today.slice(0, 4)}-00001`);
    // Allocated oldest month first (Ali, Sara), then Ali's current tuition; listed by child.
    expect(r.body.receipt.allocations.map((x) => [x.student_name, x.period_key, x.amount])).toEqual(
      [
        ['Ali', prevPeriod, RS(3000)],
        ['Ali', period, RS(850)],
        ['Sara', prevPeriod, RS(3150)],
      ],
    );
    const again = await s.api<CollectResultDto>('POST', '/api/receipts', body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, receipt: { id: r.body.receipt.id } });
    const print = await s.api<ReceiptPrintDto>(
      'GET',
      `/api/receipts/${r.body.receipt.id}?format=print`,
    );
    expect(print.status).toBe(200);
    expect(print.body.labels.ur.title).toBe('فیس رسید');
    expect(print.body.school).toMatchObject({ name: 'Al-Noor', name_ur: 'النور' });
    expect(print.body.students.map((b) => [b.student_name, b.subtotal])).toEqual([
      ['Ali', RS(3850)],
      ['Sara', RS(3150)],
    ]);
    expect(print.body.students[0]?.lines.map((l) => l.head_name_ur)).toContain('ٹیوشن فیس');
    expect(print.body.totals).toMatchObject({
      amount: RS(7000),
      allocated: RS(7000),
      credit_added: 0,
    });
    // An accountant cannot reverse; an owner reverses with a re-entry in one step.
    const acct = await signedInAs(s.db, ['accountant']);
    const acctApi = client(s.request, acct.cookie);
    expect(
      (await acctApi('POST', `/api/receipts/${r.body.receipt.id}/reverse`, { reason: 'x' })).status,
    ).toBe(403);
    const rev = await s.api<{
      reversal: { amount: number; receipt_no: string };
      reentry: { amount: number; allocations: { amount: number }[] };
    }>('POST', `/api/receipts/${r.body.receipt.id}/reverse`, {
      reason: 'keyed 7000, was 6000',
      reenter: { amount: RS(6000) },
    });
    expect(rev.status).toBe(201);
    expect(rev.body.reversal.amount).toBe(-RS(7000));
    expect(rev.body.reentry.allocations.reduce((a, x) => a + x.amount, 0)).toBe(RS(6000));
    expect(
      (await s.api('POST', `/api/receipts/${r.body.receipt.id}/reverse`, { reason: 'again' })).body,
    ).toMatchObject({ error: { code: 'already_reversed' } });
    const printed = await s.api<ReceiptPrintDto>(
      'GET',
      `/api/receipts/${r.body.receipt.id}?format=print`,
    );
    expect(printed.body.reversed).toBe(true);
    // Notify queues one payment_received per receipt.
    const reentryId = (
      await s.db.all<{ id: string }>(sql`SELECT id FROM receipt WHERE note LIKE 're-entry%'`)
    )[0]?.id;
    const n1 = await s.api<{ queued: boolean }>('POST', `/api/receipts/${reentryId}/notify`);
    const n2 = await s.api<{ queued: boolean }>('POST', `/api/receipts/${reentryId}/notify`);
    expect([n1.status, n1.body.queued, n2.body.queued]).toEqual([201, true, false]);
    expect(await s.db.all(sql`SELECT channel, template_key FROM message`)).toEqual([
      { channel: 'wa_manual', template_key: 'payment_received' },
    ]);
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });

  it('advance credit, refund within credit, cash close with variance and reopen', async () => {
    const s = await family();
    const due = (await s.api<FamilyStatementDto>('GET', `/api/fees/family/${s.fam}`)).body.totals
      .due;
    const acct = await signedInAs(s.db, ['accountant']);
    const a = client(s.request, acct.cookie);
    const r = await a<CollectResultDto>('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: s.fam,
      amount: due + RS(1000),
      method: 'cash',
    });
    expect(r.body.receipt).toMatchObject({
      unallocated: RS(1000),
      payer_credit: RS(1000),
      payer_due: 0,
    });
    expect(
      (
        await a('POST', '/api/refunds', {
          idempotency_key: newId(),
          payer_id: s.fam,
          amount: RS(500),
          method: 'cash',
          reason: 'x',
        })
      ).status,
    ).toBe(403);
    const ref = await s.api('POST', '/api/refunds', {
      idempotency_key: newId(),
      payer_id: s.fam,
      amount: RS(1500),
      method: 'cash',
      reason: 'leaving',
    });
    expect(ref.body).toMatchObject({ error: { code: 'exceeds_credit' } });
    expect(
      (
        await s.api('POST', '/api/refunds', {
          idempotency_key: newId(),
          payer_id: s.fam,
          amount: RS(400),
          method: 'cash',
          reason: 'leaving',
        })
      ).status,
    ).toBe(201);
    // The accountant sees only their own drawer and closes it; the owner's refund is in the owner's.
    const mine = await a<{ sessions: { id: string; expected: number; collector_id: string }[] }>(
      'GET',
      '/api/cash/sessions',
    );
    expect(mine.body.sessions).toHaveLength(1);
    expect(mine.body.sessions[0]?.expected).toBe(due + RS(1000));
    const all = await s.api<{ sessions: { id: string; collector_id: string }[] }>(
      'GET',
      '/api/cash/sessions',
    );
    expect(all.body.sessions).toHaveLength(2);
    const ownerSession = all.body.sessions.find((x) => x.collector_id === s.owner.userId)?.id;
    expect(
      (await a('POST', `/api/cash/sessions/${ownerSession}/close`, { counted: 0 })).status,
    ).toBe(403);
    const sid = mine.body.sessions[0]?.id;
    const closed = await a<{ session: { variance: number } }>(
      'POST',
      `/api/cash/sessions/${sid}/close`,
      { counted: due + RS(900) },
    );
    expect(closed.body.session.variance).toBe(-RS(100));
    const refused = await a('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: s.fam,
      amount: RS(1),
      method: 'cash',
    });
    expect(refused.body).toMatchObject({ error: { code: 'session_closed' } });
    expect((await a('POST', `/api/cash/sessions/${sid}/reopen`, { reason: 'late' })).status).toBe(
      403,
    );
    expect(
      (await s.api('POST', `/api/cash/sessions/${sid}/reopen`, { reason: 'late payment' })).status,
    ).toBe(200);
    expect(
      (
        await a('POST', '/api/receipts', {
          idempotency_key: newId(),
          payer_id: s.fam,
          amount: RS(1),
          method: 'cash',
        })
      ).status,
    ).toBe(201);
    // Handover from the drawer to the bank.
    const cash = (
      await s.api<{ account: { id: string } }>('POST', '/api/accounts', {
        name: 'Drawers',
        kind: 'cash',
      })
    ).body.account.id;
    const bank = (
      await s.api<{ account: { id: string } }>('POST', '/api/accounts', {
        name: 'HBL',
        kind: 'bank',
      })
    ).body.account.id;
    expect(
      (
        await a('POST', '/api/transfers', {
          from_account: cash,
          to_account: bank,
          amount: RS(1000),
        })
      ).status,
    ).toBe(201);
    const after = await a<{ sessions: { expected: number }[] }>('GET', '/api/cash/sessions');
    expect(after.body.sessions[0]?.expected).toBe(due + RS(1000) + RS(1) - RS(1000));
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });

  it('fines after grace, waiver; defaulters: teacher sees own group summary only; reminders cool down', async () => {
    const s = await family();
    const fines = await s.api<{ applied: number }>('POST', '/api/fees/fines/apply', {
      period: prevPeriod,
      as_of: `${period}-01`,
    });
    expect(fines.body.applied).toBe(2);
    const [fine] = await s.db.all<{ id: string }>(
      sql`SELECT id FROM charge WHERE kind = 'fine' ORDER BY id LIMIT 1`,
    );
    expect(
      (await s.api('POST', `/api/fees/fines/${fine?.id}/waive`, { reason: 'first time' })).status,
    ).toBe(201);
    const d = await s.api<{ defaulters: DefaulterDto[]; summary_only: boolean }>(
      'GET',
      '/api/fees/defaulters',
    );
    expect(d.body.summary_only).toBe(false);
    expect(d.body.defaulters.map((x) => x.student_name).sort()).toEqual(['Ali', 'Sara']);
    // A teacher who is class teacher of 5-A only.
    const teacher = await signedInAs(s.db, ['teacher']);
    const staffId = newId();
    await s.db.insert(staff).values({ id: staffId, userId: teacher.userId, name: 'Ms Sana' });
    expect(
      (await s.api('PATCH', `/api/groups/${s.g5a.id}`, { class_teacher_id: staffId })).status,
    ).toBe(200);
    const t = client(s.request, teacher.cookie);
    const td = await t<{ defaulters: Record<string, unknown>[]; summary_only: boolean }>(
      'GET',
      '/api/fees/defaulters',
    );
    expect(td.body.summary_only).toBe(true);
    expect(td.body.defaulters.map((x) => x.student_name)).toEqual(['Ali']);
    expect(Object.keys(td.body.defaulters[0] ?? {}).sort()).toEqual(
      [
        'admission_no',
        'group',
        'grp_id',
        'months_overdue',
        'overdue',
        'student_id',
        'student_name',
      ].sort(),
    );
    for (const path of [
      `/api/fees/family/${s.fam}`,
      '/api/fees/search?q=Ali',
      `/api/fees/register?grp_id=${s.g5a.id}&period=${period}`,
      '/api/cash/sessions',
    ])
      expect((await t('GET', path)).status, path).toBe(403);
    // Remind: one message per family, then the cooldown holds.
    const r1 = await s.api<{ queued: number }>('POST', '/api/fees/defaulters/remind', {});
    expect(r1.body.queued).toBe(1);
    const r2 = await s.api<{ queued: number }>('POST', '/api/fees/defaulters/remind', {});
    expect(r2.body.queued).toBe(0);
    expect(
      await s.db.all(
        sql`SELECT template_key, channel, json_array_length(payload, '$.student_ids') AS n FROM message`,
      ),
    ).toEqual([{ template_key: 'fee_overdue', channel: 'wa_manual', n: 2 }]);
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });

  it('register CSV is formula-safe; concession register; regenerate after a new concession', async () => {
    const s = await family();
    await s.db.run(sql`UPDATE student SET name = '=HYPERLINK("x")' WHERE id = ${s.ali}`);
    const csv = await s.api(
      'GET',
      `/api/fees/register?grp_id=${s.g5a.id}&period=${period}&format=csv`,
    );
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.text.split('\r\n')[0]).toContain('Admission no');
    const k = await s.api<{ concession: { id: string } }>('POST', '/api/fees/concessions', {
      student_id: s.ali,
      type: 'pct',
      value: 50,
      reason: 'orphan',
      valid_from: `${period}-01`,
    });
    expect(k.status).toBe(201);
    const regen = await s.api<{ counts: { late_concessions: number } }>(
      'POST',
      '/api/fees/regenerate',
      { student_id: s.ali, period },
    );
    expect(regen.body.counts.late_concessions).toBe(1);
    const reg = await s.api<{ concessions: { reason: string; amount_given: number }[] }>(
      'GET',
      '/api/fees/concessions/register',
    );
    expect(reg.body.concessions.find((c) => c.reason === 'orphan')?.amount_given).toBe(RS(1500));
    const acct = await signedInAs(s.db, ['accountant']);
    expect(
      (
        await client(s.request, acct.cookie)('POST', '/api/fees/concessions', {
          student_id: s.ali,
          type: 'pct',
          value: 5,
          reason: 'other',
          valid_from: today,
        })
      ).status,
    ).toBe(403);
  });
});

describe('M3a fix pass over HTTP', () => {
  async function family() {
    const s = await setup();
    const a = await admitNew(s.api, s.g5a.id, 'Ali');
    const b = await admitNew(s.api, s.g5b.id, 'Sara', { familyId: a.body.family_id });
    return { ...s, fam: a.body.family_id, ali: a.body.student_id, sara: b.body.student_id };
  }
  const yesterday = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  it('an overlapping sponsorship (same sponsor, student, head) is 409 sponsorship_overlap', async () => {
    const s = await family();
    const sp = await s.api<{ sponsor: { id: string } }>('POST', '/api/fees/sponsors', {
      name: 'Trust',
    });
    const base = { sponsor_id: sp.body.sponsor.id, student_id: s.ali, fee_head_id: null };
    const first = await s.api('POST', '/api/fees/sponsorships', {
      ...base,
      share_pct: 50,
      valid_from: `${prevPeriod}-01`,
    });
    expect(first.status).toBe(201);
    for (const clash of [
      { ...base, share_pct: 60, valid_from: `${period}-01` },
      { ...base, fee_head_id: s.tui.id, share_pct: 10, valid_from: `${period}-01` },
    ]) {
      const r = await s.api<{ error: { code: string } }>('POST', '/api/fees/sponsorships', clash);
      expect([r.status, r.body.error.code]).toEqual([409, 'sponsorship_overlap']);
    }
    // After ending it, a new row from the next day is fine.
    const id = (first.body as { sponsorship: { id: string } }).sponsorship.id;
    expect(
      (
        await s.api('POST', `/api/fees/sponsorships/${id}/end`, {
          valid_to: `${prevPeriod}-28`,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await s.api('POST', '/api/fees/sponsorships', {
          ...base,
          share_pct: 25,
          valid_from: `${period}-01`,
        })
      ).status,
    ).toBe(201);
  });

  it('business_date: today by default; yesterday for owner/admin with a reason (audited); else 400', async () => {
    const s = await family();
    const acct = client(s.request, (await signedInAs(s.db, ['accountant'])).cookie);
    const pay = (api: ReturnType<typeof client>, extra: Record<string, unknown>) =>
      api<{ error?: { code: string }; receipt?: { id: string; receipt_no: string } }>(
        'POST',
        '/api/receipts',
        { idempotency_key: newId(), payer_id: s.fam, amount: RS(10), method: 'cash', ...extra },
      );
    for (const [api, extra] of [
      [acct, { business_date: yesterday, backdate_reason: 'late' }],
      [s.api, { business_date: yesterday }],
      [s.api, { business_date: '2025-12-31', backdate_reason: 'reviewer repro' }],
    ] as const) {
      const r = await pay(api, extra);
      expect([r.status, r.body.error?.code]).toEqual([400, 'bad_business_date']);
    }
    expect(await s.db.all(sql`SELECT * FROM cash_session`)).toEqual([]);
    const ok = await pay(s.api, { business_date: yesterday, backdate_reason: 'forgot' });
    expect(ok.status).toBe(201);
    const [row] = await s.db.all<{ bd: string; sd: string }>(sql`SELECT r.business_date AS bd,
      s.business_date AS sd FROM receipt r JOIN cash_session s ON s.id = r.cash_session_id`);
    expect(row).toEqual({ bd: yesterday, sd: today });
    expect(ok.body.receipt?.receipt_no.slice(3, 7)).toBe(today.slice(0, 4));
    expect(
      await s.db.all(sql`SELECT json_extract(diff, '$.reason') AS reason FROM audit
        WHERE action = 'backdate' AND entity_id = ${ok.body.receipt?.id as string}`),
    ).toEqual([{ reason: 'forgot' }]);
    // A drawer is never opened for a past day.
    const open = await acct<{ error: { code: string } }>('POST', '/api/cash/sessions', {
      business_date: yesterday,
    });
    expect([open.status, open.body.error.code]).toEqual([400, 'bad_business_date']);
  });

  it('dues hash: a stale view is 409 stale_dues; idempotency is per user; non-cash picks an account', async () => {
    const s = await family();
    const st = await s.api<FamilyStatementDto>('GET', `/api/fees/family/${s.fam}`);
    expect(st.body.dues_hash).toMatch(/^[0-9a-f]{16}$/);
    const key = newId();
    const first = await s.api<CollectResultDto>('POST', '/api/receipts', {
      idempotency_key: key,
      payer_id: s.fam,
      amount: RS(100),
      method: 'cash',
      expected_due_hash: st.body.dues_hash,
    });
    expect(first.status).toBe(201);
    const stale = await s.api<{ error: { code: string } }>('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: s.fam,
      amount: RS(100),
      method: 'cash',
      expected_due_hash: st.body.dues_hash,
    });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'stale_dues']);
    const admin = client(s.request, (await signedInAs(s.db, ['admin'])).cookie);
    const other = await admin<{ error: { code: string } }>('POST', '/api/receipts', {
      idempotency_key: key,
      payer_id: s.fam,
      amount: RS(100),
      method: 'cash',
    });
    expect([other.status, other.body.error.code]).toEqual([409, 'idempotency_conflict']);
    expect(
      await s.db.all(sql`SELECT action, json_extract(diff, '$.receipt_no') AS no FROM audit
        WHERE entity = 'receipt' AND entity_id = ${first.body.receipt.id}`),
    ).toEqual([{ action: 'collect', no: first.body.receipt.receipt_no }]);
    // Bank money: no account yet → 400 account_required; once one exists it is used, no drawer.
    const bankPay = () =>
      s.api<CollectResultDto & { error?: { code: string } }>('POST', '/api/receipts', {
        idempotency_key: newId(),
        payer_id: s.fam,
        amount: RS(100),
        method: 'cheque',
        reference: 'CHQ 1234',
      });
    const none = await bankPay();
    expect([none.status, none.body.error?.code]).toEqual([400, 'account_required']);
    const bank = (
      await s.api<{ account: { id: string } }>('POST', '/api/accounts', {
        name: 'HBL',
        kind: 'bank',
      })
    ).body.account.id;
    const ok = await bankPay();
    expect(ok.status).toBe(201);
    expect(ok.body.receipt).toMatchObject({
      method: 'cheque',
      account_id: bank,
      cash_session_id: null,
    });
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });

  it('void a charge: reason required; paid money becomes credit and pays the next due', async () => {
    const s = await family();
    const [adm] = await s.db.all<{ id: string; net: number }>(sql`SELECT c.id, n.net FROM charge c
      JOIN charge_net n ON n.id = c.id WHERE c.student_id = ${s.ali} AND c.fee_head_id = ${s.adm.id}`);
    const pay = await s.api<CollectResultDto>('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: s.fam,
      amount: adm?.net,
      method: 'cash',
      directed: [{ charge_id: adm?.id, amount: adm?.net }],
    });
    expect(pay.status).toBe(201);
    const bad = await s.api<{ error: { code: string } }>(
      'POST',
      `/api/charges/${adm?.id}/void`,
      {},
    );
    expect(bad.status).toBe(400);
    const v = await s.api<{ amount: number; released: number; credit_applied: number }>(
      'POST',
      `/api/charges/${adm?.id}/void`,
      { reason: 'admission fee waived by the owner' },
    );
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ amount: adm?.net, released: adm?.net });
    expect(v.body.credit_applied).toBeGreaterThan(0);
    const again = await s.api<{ error: { code: string } }>('POST', `/api/charges/${adm?.id}/void`, {
      reason: 'again',
    });
    expect([again.status, again.body.error.code]).toEqual([409, 'already_void']);
    const acct = client(s.request, (await signedInAs(s.db, ['accountant'])).cookie);
    expect((await acct('POST', `/api/charges/${adm?.id}/void`, { reason: 'x' })).status).toBe(403);
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });

  it('a failing group is logged and skipped by "Generate"; GET /api/fees/runs shows it; a late student is billed by regenerate', async () => {
    const s = await family();
    await s.db.run(
      sql.raw(
        `CREATE TRIGGER test_boom BEFORE INSERT ON charge WHEN NEW.student_id = '${s.sara}' AND NEW.period_key = '${prevPeriod}' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      ),
    );
    const seen: GenerateResultDto[] = [];
    let next: GenerateResultDto['next'] | undefined;
    do {
      const g = await s.api<GenerateResultDto>('POST', '/api/fees/generate', {
        period: prevPeriod,
        ...(next ? { grp_id: next.grp_id, after_student_id: next.after_student_id } : {}),
      });
      expect(g.status).toBe(200);
      seen.push(g.body);
      next = g.body.next;
    } while (next && seen.length < 5);
    expect(seen.map((x) => x.failed?.grp_id ?? null).filter(Boolean)).toEqual([s.g5b.id]);
    expect(seen.at(-1)?.done).toBe(true);
    const runs = await s.api<{
      complete: boolean;
      failing: { grp_id: string; error_code: string }[];
      chunks: { status: string; error_message: string | null }[];
    }>('GET', `/api/fees/runs?period=${prevPeriod}`);
    expect(runs.body.complete).toBe(false);
    expect(runs.body.failing).toEqual([
      expect.objectContaining({ grp_id: s.g5b.id, error_code: 'constraint' }),
    ]);
    expect(runs.body.chunks.find((k) => k.status === 'failed')?.error_message).toMatch(/boom/);
    await s.db.run(sql`DROP TRIGGER test_boom`);
    const retry = await s.api<GenerateResultDto>('POST', '/api/fees/generate', {
      period: prevPeriod,
    });
    expect([retry.body.grp_id, retry.body.failed, retry.body.done]).toEqual([s.g5b.id, null, true]);
    // A student enrolled after the group's chunk completed: generation skips the finished group…
    const late = await admitNew(s.api, s.g5a.id, 'Late', {
      start: `${prevPeriod}-01`,
      fees: { charge: false },
    });
    expect(late.status).toBe(201);
    const g = await s.api<GenerateResultDto>('POST', '/api/fees/generate', { period: prevPeriod });
    expect([g.body.grp_id, g.body.done]).toEqual([null, true]);
    // …and POST /api/fees/regenerate bills them.
    const rg = await s.api<{ counts: { fees: number } }>('POST', '/api/fees/regenerate', {
      student_id: late.body.student_id,
      period: prevPeriod,
    });
    expect(rg.status).toBe(200);
    expect(rg.body.counts.fees).toBe(2);
    expect(await s.db.all(sql`SELECT * FROM ledger_consistency`)).toEqual([]);
  });
});

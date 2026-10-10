/**
 * Milestone 3b smoke: drives the fee counter over HTTP exactly as the web screen does, against
 * `wrangler dev --local`:
 * search → family view (dues_hash) → the shared oldest-first preview (@maktab/shared) →
 * POST /api/receipts with expected_due_hash and one idempotency key → the allocation equals the preview → a retry with the
 * same key replays → a collection against the old hash is 409 stale_dues → reload → print JSON
 * (Urdu labels, lines) → payment-received queued → student fees tab and dashboard tiles agree →
 * reverse with reason → the print shows reversed.
 *
 *   npm run db:migrate:local && npm run dev -w @maktab/api   # terminal 1
 *   npm run smoke:m3b -w @maktab/api                         # terminal 2
 *
 * Self-contained (own group, heads and family with a random suffix); its heads are archived at the
 * end. Exit 1 on the first failure.
 */
import type {
  AdmissionResult,
  CollectResultDto,
  FamilyHitDto,
  FamilyStatementDto,
  FeeDashboardDto,
  FeeHeadDto,
  FeeLineDto,
  GenerateResultDto,
  GroupDto,
  ProgrammeDto,
  ReceiptPrintDto,
  SchoolResponse,
  SessionDto,
  StudentFeesDto,
} from '@maktab/shared';
import { newId, previewOldestFirst } from '@maktab/shared';
import { mintDevSession } from './dev-session';
import { always, EMAIL, expectOk, finish, makeApi, runId as run, step } from './smoke-lib';

let cookie = '';
const api = makeApi(() => cookie);
const RS = (n: number) => n * 100;
const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const period = today.slice(0, 7);

/** The counter's preview, the very function the web screen uses (@maktab/shared alloc.ts). */
function preview(lines: readonly FeeLineDto[], amount: number) {
  const p = previewOldestFirst(lines, amount);
  return {
    rows: p.rows.map((r) => ({ charge_id: r.line.id, amount: r.amount })),
    credit: p.credit,
  };
}

async function main() {
  let groupId = '';
  const heads: FeeHeadDto[] = [];
  let family = '';
  let student = '';
  let view: FamilyStatementDto | null = null;
  let receiptId = '';

  await step(`owner session for ${EMAIL}; school, session, setup finished`, async () => {
    cookie = (await mintDevSession(EMAIL)).cookie;
    const s = await api<SchoolResponse>('GET', '/api/school');
    if (!s.body.school) {
      const r = await api('PUT', '/api/school', {
        name: 'Smoke School',
        name_ur: 'اسکول',
        mode: 'both',
      });
      expectOk(r.status === 200, r);
    }
    const sessions = await api<{ items: SessionDto[] }>('GET', '/api/sessions');
    if (!sessions.body.items.some((x) => x.is_current)) {
      const y = Number(today.slice(0, 4));
      const r = await api('POST', '/api/sessions', {
        name: `${y}-${y + 1}`,
        start_date: `${y - 1}-04-01`,
        end_date: `${y + 1}-03-31`,
      });
      expectOk(r.status === 201, r);
    }
    await api('POST', '/api/programmes/seed-pk');
    const after = await api<SchoolResponse>('GET', '/api/school');
    if (!after.body.school?.setup_completed_at)
      expectOk((await api('POST', '/api/school/complete-setup')).status === 200, 'complete-setup');
  });

  await step('a group with tuition + admission rates; a family of two admitted', async () => {
    const progs = await api<{ items: ProgrammeDto[] }>('GET', '/api/programmes');
    const c6 = progs.body.items.find((p) => p.name === 'Class 6');
    expectOk(c6, 'Class 6 missing');
    const g = await api<GroupDto>('POST', '/api/groups', {
      programme_id: c6?.id,
      name: `6-${run}`,
    });
    expectOk(g.status === 201, g);
    groupId = g.body.id;
    for (const h of [
      {
        name: `Tuition ${run}`,
        name_ur: 'ٹیوشن فیس',
        kind: 'tuition',
        cadence: 'monthly',
        amount: RS(2500),
      },
      {
        name: `Admission ${run}`,
        name_ur: 'داخلہ فیس',
        kind: 'admission',
        cadence: 'once',
        amount: RS(4000),
      },
    ]) {
      const r = await api<{ head: FeeHeadDto }>('POST', '/api/fees/heads', h);
      expectOk(r.status === 201, r);
      heads.push(r.body.head);
      const rate = await api('POST', '/api/fees/rates', {
        fee_head_id: r.body.head.id,
        grp_id: groupId,
        amount: h.amount,
        effective_from: `${period}-01`,
      });
      expectOk(rate.status === 201, rate);
    }
    const start = `${period}-01`;
    const a = await api<AdmissionResult>('POST', '/api/admissions', {
      family: { name: `Counter ${run}` },
      guardians: [
        {
          name: 'Tariq',
          phone: `0300${String(Math.floor(1e6 + Math.random() * 8e6))}`,
          consent_whatsapp: true,
        },
      ],
      student: { name: `Bilal ${run}`, admission_date: start },
      enrolment: { grp_id: groupId, start_date: start },
    });
    expectOk(a.status === 201, a);
    family = a.body.family_id;
    student = a.body.student_id;
    const b = await api<AdmissionResult>('POST', '/api/admissions', {
      family_id: family,
      student: { name: `Hira ${run}`, admission_date: start },
      enrolment: { grp_id: groupId, start_date: start },
    });
    expectOk(b.status === 201, b);
    // Billing loop as the Billing screen runs it (idempotent: admission already billed this month).
    let next: GenerateResultDto['next'] = null;
    let n = 0;
    do {
      const r: { status: number; body: GenerateResultDto } = await api<GenerateResultDto>(
        'POST',
        '/api/fees/generate',
        {
          period,
          ...(next ? { grp_id: next.grp_id, after_student_id: next.after_student_id } : {}),
        },
      );
      expectOk(r.status === 200 && !r.body.failed, r);
      next = r.body.next;
    } while (next && ++n < 200);
  });

  await step('counter search finds the family by a child’s name', async () => {
    const r = await api<{ families: FamilyHitDto[] }>(
      'GET',
      `/api/fees/search?q=${encodeURIComponent(`Hira ${run}`)}`,
    );
    expectOk(r.status === 200 && r.body.families.some((f) => f.family_id === family), r);
  });

  const amount = RS(5000);
  let key = '';
  await step(
    'family view → preview → collect (hash + key); the allocation equals the preview',
    async () => {
      const v = await api<FamilyStatementDto>('GET', `/api/fees/family/${family}`);
      expectOk(v.status === 200 && v.body.dues_hash, v);
      view = v.body;
      const p = preview(view.charges, amount);
      key = `ctr-${newId()}`;
      const r = await api<CollectResultDto>('POST', '/api/receipts', {
        idempotency_key: key,
        payer_type: 'family',
        payer_id: family,
        amount,
        method: 'cash',
        expected_due_hash: view.dues_hash,
      });
      expectOk(r.status === 201, r);
      receiptId = r.body.receipt.id;
      const got = r.body.receipt.allocations.map((x) => `${x.charge_id}:${x.amount}`).sort();
      const want = p.rows.map((x) => `${x.charge_id}:${x.amount}`).sort();
      expectOk(JSON.stringify(got) === JSON.stringify(want), { got, want });
      expectOk(r.body.receipt.unallocated === p.credit, r.body.receipt);
      return r.body.receipt.receipt_no;
    },
  );

  await step('retry with the same key replays the same receipt (200, replayed)', async () => {
    const r = await api<CollectResultDto>('POST', '/api/receipts', {
      idempotency_key: key,
      payer_type: 'family',
      payer_id: family,
      amount,
      method: 'cash',
      expected_due_hash: view?.dues_hash,
    });
    expectOk(r.status === 200 && r.body.replayed && r.body.receipt.id === receiptId, r);
  });

  await step(
    'a new attempt against the old view is 409 stale_dues; reload gives a new hash',
    async () => {
      const r = await api<{ error: { code: string } }>('POST', '/api/receipts', {
        idempotency_key: `ctr-${newId()}`,
        payer_type: 'family',
        payer_id: family,
        amount: RS(100),
        method: 'cash',
        expected_due_hash: view?.dues_hash,
      });
      expectOk(r.status === 409 && r.body.error.code === 'stale_dues', r);
      const v = await api<FamilyStatementDto>('GET', `/api/fees/family/${family}`);
      expectOk(v.body.dues_hash !== view?.dues_hash, 'hash did not change');
    },
  );

  await step('print JSON: Urdu labels, one block per child, totals add up', async () => {
    const r = await api<ReceiptPrintDto>('GET', `/api/receipts/${receiptId}?format=print`);
    expectOk(r.status === 200, r);
    expectOk(r.body.labels.ur.receipt_no === 'رسید نمبر', r.body.labels.ur);
    const sum = r.body.students.reduce((a, s) => a + s.subtotal, 0);
    expectOk(sum === r.body.totals.allocated && r.body.totals.amount === amount, r.body.totals);
    expectOk(!r.body.reversed, 'reversed too early');
  });

  await step('Send payment-received → queued once', async () => {
    const a = await api<{ queued: boolean }>('POST', `/api/receipts/${receiptId}/notify`);
    expectOk(a.status === 201 && a.body.queued, a);
    const b = await api<{ queued: boolean }>('POST', `/api/receipts/${receiptId}/notify`);
    expectOk(b.status === 200 && !b.body.queued, b);
  });

  await step('student fees tab and dashboard tiles agree with the family view', async () => {
    const s = await api<StudentFeesDto>('GET', `/api/fees/student/${student}`);
    expectOk(s.status === 200 && s.body.receipts.some((x) => x.id === receiptId), s);
    const d = await api<FeeDashboardDto>('GET', '/api/dashboard/fees');
    expectOk(d.status === 200 && d.body.collected_total >= amount, d);
    expectOk(d.body.queued_fee_messages >= 1, d.body);
  });

  await step('reverse with a reason → the print says reversed', async () => {
    const r = await api('POST', `/api/receipts/${receiptId}/reverse`, { reason: `smoke ${run}` });
    expectOk(r.status === 201, r);
    const p = await api<ReceiptPrintDto>('GET', `/api/receipts/${receiptId}?format=print`);
    expectOk(p.body.reversed === true, p.body);
  });

  await always('cleanup: archive the smoke fee heads', async () => {
    for (const h of heads) await api('PATCH', `/api/fees/heads/${h.id}`, { archived: true });
  });

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

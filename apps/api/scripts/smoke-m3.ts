/**
 * Milestone 3 definition of done, over HTTP against `wrangler dev --local --test-scheduled`:
 * fee heads and rates → admit 3 students (two siblings, the second with the automatic sibling
 * concession; one sponsored 50%) → generate last month and this month (chunked) → dry-run preview
 * and defaulters → collect for the family (partial, then full with credit) → the print JSON carries
 * Urdu labels → reverse one receipt → late fines after the grace day → waive one → close the cash
 * session with a variance → ledger_consistency is empty → the cron handler runs via /__scheduled.
 * Prints PASS/FAIL per step; exit 1 on failure.
 *
 *   npm run db:migrate:local && npm run dev -w @maktab/api -- --test-scheduled   # terminal 1
 *   npm run smoke:m3 -w @maktab/api                                             # terminal 2
 *
 * Self-contained (own group, heads, accountant and students, with a random suffix), so it runs on
 * an empty database or after the other smokes, and again. Its fee heads are archived and the
 * school's fee settings restored at the end. Finishes the setup wizard if it was not (the cron
 * does nothing before that).
 */
import { createRequire } from 'node:module';
import type {
  AdmissionResult,
  CollectResultDto,
  DefaulterDto,
  FamilyStatementDto,
  FeeHeadDto,
  FeeSettingsDto,
  GenerateResultDto,
  GroupDto,
  ProgrammeDto,
  ReceiptPrintDto,
  SchoolResponse,
  SessionDto,
  StaffRowDto,
} from '@maktab/shared';
import { newId } from '@maktab/shared';
import { localD1File, mintDevSession } from './dev-session';
import { always, BASE, EMAIL, expectOk, finish, makeApi, runId as run, step } from './smoke-lib';

let ownerCookie = '';
let acctCookie = '';
const api = makeApi(() => ownerCookie);
const acct = makeApi(() => acctCookie);

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const period = today.slice(0, 7);
const prevPeriod = (() => {
  const d = new Date(`${period}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();
const RS = (n: number) => n * 100;
const phone = () => `0300-${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

/** Read-only look into the local D1 file (the API has no route for the consistency view). */
function localQuery<T>(q: string): T[] {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(localD1File(), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(q).all() as T[];
  } finally {
    db.close();
  }
}

async function generate(p: string, dryRun = false): Promise<GenerateResultDto[]> {
  const out: GenerateResultDto[] = [];
  let next: GenerateResultDto['next'] = null;
  for (let i = 0; i < 200; i++) {
    const r: { status: number; body: GenerateResultDto } = await api<GenerateResultDto>(
      'POST',
      '/api/fees/generate',
      {
        period: p,
        dry_run: dryRun,
        ...(next ? { grp_id: next.grp_id, after_student_id: next.after_student_id } : {}),
      },
    );
    expectOk(r.status === 200, r);
    // A failed group is logged and skipped (M3 fix pass); in the smoke nothing may fail.
    expectOk(!r.body.failed, r);
    out.push(r.body);
    next = r.body.next;
    if (!next) return out;
  }
  throw new Error('generation did not finish in 200 chunks');
}

async function main() {
  let groupId = '';
  const heads: FeeHeadDto[] = [];
  let restoreFees: FeeSettingsDto | null = null;
  let family = '';
  let zaraFamily = '';
  let partialReceipt = '';

  await step('API reachable (GET /api/health)', async () => {
    const r = await api<{ status: string }>('GET', '/api/health');
    expectOk(r.status === 200 && r.body.status === 'ok', r);
  });

  await step(`owner session for ${EMAIL}`, async () => {
    ownerCookie = (await mintDevSession(EMAIL)).cookie;
  });

  await step(
    'school, current session, setup finished; fee settings (fine + sibling rule)',
    async () => {
      const s = await api<SchoolResponse>('GET', '/api/school');
      if (!s.body.school) {
        const r = await api('PUT', '/api/school', {
          name: 'Smoke Test School',
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
      if (!after.body.school?.setup_completed_at) {
        const r = await api('POST', '/api/school/complete-setup');
        expectOk(r.status === 200, r);
      }
      restoreFees = (await api<{ fees: FeeSettingsDto }>('GET', '/api/school/fees')).body.fees;
      const r = await api('PUT', '/api/school/fees', {
        fine_rule: { enabled: true, grace_day: 10, type: 'fixed', value: RS(200), cap: null },
        sibling_rule: [{ nth: 2, pct: 10 }],
        reminder_cooldown_days: 7,
      });
      expectOk(r.status === 200, r);
    },
  );

  await step('group, fee heads (tuition, admission) and group rates', async () => {
    const progs = await api<{ items: ProgrammeDto[] }>('GET', '/api/programmes');
    const c7 = progs.body.items.find((p) => p.name === 'Class 7');
    expectOk(c7, 'Class 7 missing');
    const g = await api<GroupDto>('POST', '/api/groups', {
      programme_id: c7?.id,
      name: `7-${run}`,
    });
    expectOk(g.status === 201, g);
    groupId = g.body.id;
    for (const h of [
      {
        name: `Tuition ${run}`,
        name_ur: 'ٹیوشن فیس',
        kind: 'tuition',
        cadence: 'monthly',
        amount: RS(3000),
      },
      {
        name: `Admission ${run}`,
        name_ur: 'داخلہ فیس',
        kind: 'admission',
        cadence: 'once',
        amount: RS(5000),
      },
    ]) {
      const r = await api<{ head: FeeHeadDto }>('POST', '/api/fees/heads', h);
      expectOk(r.status === 201, r);
      heads.push(r.body.head);
      const rate = await api('POST', '/api/fees/rates', {
        fee_head_id: r.body.head.id,
        grp_id: groupId,
        amount: h.amount,
        effective_from: `${prevPeriod}-01`,
      });
      expectOk(rate.status === 201, rate);
    }
  });

  await step(
    'admit Ali, then his sister Sara (10% sibling concession), and Zara (sponsored 50%)',
    async () => {
      const start = `${prevPeriod}-01`;
      const preview = await api<{ fees: { total_family: number } }>(
        'GET',
        `/api/admissions/preview-fees?grp_id=${groupId}&start_date=${start}`,
      );
      expectOk(preview.body.fees.total_family === RS(8000), preview);
      const a = await api<AdmissionResult>('POST', '/api/admissions', {
        family: { name: `Khan ${run}` },
        guardians: [{ name: 'Imran Khan', phone: phone(), consent_whatsapp: true }],
        student: { name: `Ali ${run}`, admission_date: start },
        enrolment: { grp_id: groupId, start_date: start },
      });
      expectOk(a.status === 201 && a.body.fees?.total_family === RS(8000), a);
      family = a.body.family_id;
      const b = await api<AdmissionResult>('POST', '/api/admissions', {
        family_id: family,
        student: { name: `Sara ${run}`, admission_date: start },
        enrolment: { grp_id: groupId, start_date: start },
      });
      expectOk(
        b.status === 201 && b.body.fees?.sibling.applied && b.body.fees.total_family === RS(7700),
        b,
      );
      const z = await api<AdmissionResult>('POST', '/api/admissions', {
        family: { name: `Bibi ${run}` },
        guardians: [{ name: 'Nasreen', phone: phone(), consent_whatsapp: false }],
        student: { name: `Zara ${run}`, admission_date: start },
        enrolment: { grp_id: groupId, start_date: start },
        fees: { charge: false },
      });
      expectOk(z.status === 201 && z.body.fees === null, z);
      zaraFamily = z.body.family_id;
      const sp = await api<{ sponsor: { id: string } }>('POST', '/api/fees/sponsors', {
        name: `Trust ${run}`,
      });
      const sh = await api('POST', '/api/fees/sponsorships', {
        sponsor_id: sp.body.sponsor.id,
        student_id: z.body.student_id,
        share_pct: 50,
        valid_from: start,
      });
      expectOk(sh.status === 201, sh);
      return 'Ali Rs 8,000, Sara Rs 7,700 billed at admission; Zara not yet';
    },
  );

  await step(`generate ${prevPeriod} and ${period} (dry run first, then chunked)`, async () => {
    const dry = await generate(period, true);
    const zara = dry.flatMap((c) => c.planned).filter((c) => c.payer_type === 'sponsor');
    // Half of Zara's tuition; her admission fee belongs to her first month (last month's run).
    expectOk(
      zara.length === 1,
      dry.map((d) => d.planned),
    );
    await generate(prevPeriod);
    const now = await generate(period);
    const counts = now.reduce((a, c) => a + c.counts.fees + c.counts.sponsored, 0);
    const again = await generate(period);
    expectOk(
      again.every((c) => c.counts.fees === 0),
      again,
    );
    return `${counts} new roots this month; re-run inserted nothing`;
  });

  await step('defaulters list the three children (last month overdue)', async () => {
    const d = await api<{ defaulters: DefaulterDto[] }>(
      'GET',
      `/api/fees/defaulters?grp_id=${groupId}`,
    );
    expectOk(d.status === 200 && d.body.defaulters.length === 3, d);
    const ex = await api<{ defaulters: DefaulterDto[] }>(
      'GET',
      `/api/fees/defaulters?grp_id=${groupId}&exclude_sponsored=1`,
    );
    expectOk(ex.body.defaulters.length === 2, ex);
  });

  await step(
    'an accountant collects for the family: partial, then the rest plus an advance',
    async () => {
      const email = `m3-acct-${run}@example.com`;
      const inv = await api<StaffRowDto>('POST', '/api/staff/invite', {
        email,
        role: 'accountant',
        name: `Acct ${run}`,
      });
      expectOk(inv.status === 201, inv);
      acctCookie = (await mintDevSession(email, { activate: true })).cookie;
      const found = await acct<{ families: { family_id: string; due: number }[] }>(
        'GET',
        `/api/fees/search?q=${encodeURIComponent(`Sara ${run}`)}`,
      );
      expectOk(found.body.families[0]?.family_id === family, found);
      const due = found.body.families[0]?.due ?? 0;
      const p1 = await acct<CollectResultDto>('POST', '/api/receipts', {
        idempotency_key: newId(),
        payer_id: family,
        amount: RS(5000),
        method: 'cash',
      });
      expectOk(p1.status === 201 && p1.body.receipt.allocated === RS(5000), p1);
      partialReceipt = p1.body.receipt.id;
      const key = newId();
      const rest = due - RS(5000) + RS(500);
      const p2 = await acct<CollectResultDto>('POST', '/api/receipts', {
        idempotency_key: key,
        payer_id: family,
        amount: rest,
        method: 'cash',
      });
      expectOk(
        p2.status === 201 &&
          p2.body.receipt.payer_due === 0 &&
          p2.body.receipt.payer_credit === RS(500),
        p2,
      );
      const replay = await acct<CollectResultDto>('POST', '/api/receipts', {
        idempotency_key: key,
        payer_id: family,
        amount: rest,
        method: 'cash',
      });
      expectOk(
        replay.status === 200 &&
          replay.body.replayed &&
          replay.body.receipt.id === p2.body.receipt.id,
        replay,
      );
      return `${p1.body.receipt.receipt_no}, ${p2.body.receipt.receipt_no}; Rs 500 credit`;
    },
  );

  await step('print JSON has the school header, Urdu labels and one block per child', async () => {
    const p = await acct<ReceiptPrintDto>('GET', `/api/receipts/${partialReceipt}?format=print`);
    expectOk(
      p.status === 200 && p.body.labels.ur.title === 'فیس رسید' && p.body.students.length >= 1,
      p,
    );
    expectOk(
      p.body.students.some((s) => s.lines.some((l) => l.head_name_ur === 'ٹیوشن فیس')),
      p.body.students,
    );
  });

  await step('the owner reverses the partial receipt (the accountant may not)', async () => {
    const no = await acct('POST', `/api/receipts/${partialReceipt}/reverse`, { reason: 'test' });
    expectOk(no.status === 403, no);
    const r = await api<{ reversal: { amount: number } }>(
      'POST',
      `/api/receipts/${partialReceipt}/reverse`,
      { reason: 'smoke: wrong amount' },
    );
    expectOk(r.status === 201 && r.body.reversal.amount === -RS(5000), r);
    const st = await api<FamilyStatementDto>('GET', `/api/fees/family/${family}`);
    return `family due now Rs ${st.body.totals.due / 100}, credit Rs ${st.body.credit / 100}`;
  });

  await step(`late fines for ${prevPeriod} (after the grace day), then waive one`, async () => {
    const f = await api<{ applied: number }>('POST', '/api/fees/fines/apply', {
      period: prevPeriod,
      as_of: today,
    });
    expectOk(f.status === 200, f);
    const st = await api<FamilyStatementDto>('GET', `/api/fees/family/${zaraFamily}`);
    const fined = st.body.charges.find((c) => c.fine > 0);
    expectOk(fined, st.body.charges);
    const rows = localQuery<{ id: string }>(
      `SELECT id FROM charge WHERE kind = 'fine' AND parent_charge_id = '${fined?.id}'`,
    );
    const w = await api('POST', `/api/fees/fines/${rows[0]?.id}/waive`, {
      reason: 'smoke: first time',
    });
    expectOk(w.status === 201, w);
    return `${f.body.applied} fine(s) applied`;
  });

  await step('the accountant closes the drawer with a Rs 100 shortfall', async () => {
    const s = await acct<{
      sessions: { id: string; expected: number; closed_at: string | null }[];
    }>('GET', '/api/cash/sessions');
    const open = s.body.sessions.find((x) => !x.closed_at);
    expectOk(open, s);
    const c = await acct<{ session: { variance: number; expected: number } }>(
      'POST',
      `/api/cash/sessions/${open?.id}/close`,
      { counted: (open?.expected ?? 0) - RS(100) },
    );
    expectOk(c.status === 200 && c.body.session.variance === -RS(100), c);
    const refused = await acct('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: family,
      amount: RS(1),
      method: 'cash',
    });
    expectOk(refused.status === 409, refused);
    return `expected Rs ${(c.body.session.expected ?? 0) / 100}`;
  });

  await step('ledger_consistency is empty (local D1 file)', async () => {
    const rows = localQuery('SELECT * FROM ledger_consistency');
    expectOk(rows.length === 0, rows);
  });

  await step(
    'cron via /__scheduled finishes the month (wrangler dev --test-scheduled)',
    async () => {
      // A group billed by nobody yet, so the cron has a chunk to do.
      const progs = await api<{ items: ProgrammeDto[] }>('GET', '/api/programmes');
      const g = await api<GroupDto>('POST', '/api/groups', {
        programme_id: progs.body.items.find((p) => p.name === 'Class 7')?.id,
        name: `7c-${run}`,
      });
      expectOk(g.status === 201, g);
      const tuition = heads[0];
      const rate = await api('POST', '/api/fees/rates', {
        fee_head_id: tuition?.id,
        grp_id: g.body.id,
        amount: RS(2500),
        effective_from: `${prevPeriod}-01`,
      });
      expectOk(rate.status === 201, rate);
      const k = await api<AdmissionResult>('POST', '/api/admissions', {
        family: { name: `Cron ${run}` },
        guardians: [{ name: 'Cron Sr', phone: phone() }],
        student: { name: `Cron ${run}`, admission_date: `${prevPeriod}-01` },
        enrolment: { grp_id: g.body.id, start_date: `${prevPeriod}-01` },
        fees: { charge: false },
      });
      expectOk(k.status === 201, k);
      let complete = false;
      for (let i = 0; i < 40 && !complete; i++) {
        // wrangler.toml routes /__scheduled to the Worker (run_worker_first), not the SPA fallback.
        const res = await fetch(`${BASE}/__scheduled?cron=${encodeURIComponent('*/30 * * * *')}`);
        expectOk(
          res.ok,
          `/__scheduled answered ${res.status}; start wrangler dev with --test-scheduled`,
        );
        await new Promise((r) => setTimeout(r, 300));
        const runs = await api<{ complete: boolean }>('GET', `/api/fees/runs?period=${period}`);
        complete = runs.body.complete;
      }
      expectOk(complete, 'generation cursor still open after 40 cron runs');
      const byCron = localQuery<{ n: number }>(
        `SELECT count(*) AS n FROM billing_chunk k JOIN billing_run r ON r.id = k.run_id WHERE r.period_key = '${period}' AND k.created_by IS NULL`,
      );
      expectOk((byCron[0]?.n ?? 0) > 0, 'the cron logged no chunk');
      const st = await api<FamilyStatementDto>('GET', `/api/fees/family/${k.body.family_id}`);
      expectOk(
        st.body.charges.some((c) => c.period_key === period && c.gross === RS(2500)),
        st.body.charges,
      );
      return `${byCron[0]?.n ?? 0} chunk(s) logged by the cron; the new group's family billed`;
    },
  );

  await always('cleanup: archive the run’s fee heads, restore fee settings', async () => {
    for (const h of heads) await api('PATCH', `/api/fees/heads/${h.id}`, { archived: true });
    if (restoreFees)
      await api('PUT', '/api/school/fees', {
        fine_rule: restoreFees.fine_rule,
        sibling_rule: restoreFees.sibling_rule,
        reminder_cooldown_days: restoreFees.reminder_cooldown_days,
      });
  });

  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

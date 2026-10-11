/**
 * Milestone 5 definition of done, over HTTP against `wrangler dev --local`: absence rows from
 * registers (M2 path) → the office corrects one child to present → opening that row skips it
 * (no_longer_absent); opening the other merges a sibling absent in another group, carries the parent
 * link alone on the last line and a wa.me URL that decodes to the text → explicit Sent → a notice
 * composed to the class (cursor loop) → the guardian's parent link (`/p#<token>`; the queue and the
 * stored row carry only `{link}`) → birth-year gate → GET /api/p (token in X-Parent-Token) as a
 * whitelist (no ids, CNIC / B-form / DOB / phones) with noindex headers → the receipt whitelist →
 * /p shell headers → revoke → 404.
 *
 *   npm run db:migrate:local && npm run dev -w @maktab/api      # terminal 1
 *   npm run smoke:m5 -w @maktab/api                              # terminal 2
 *
 * Self-contained (own groups, teacher, families, random suffix); restores the weekly day off.
 */
import type {
  AdmissionResult,
  AttendanceSubmission,
  AttendanceSyncResult,
  ComposeResultDto,
  GroupDto,
  MessageListDto,
  MessageOpenDto,
  ParentLinkCreatedDto,
  ParentPageDto,
  ParentReceiptDto,
  ProgrammeDto,
  SchoolResponse,
  SessionDto,
  StaffRowDto,
} from '@maktab/shared';
import { newId } from '@maktab/shared';
import { mintDevSession } from './dev-session';
import {
  always,
  BASE,
  EMAIL,
  expectOk,
  finish,
  makeApi,
  ORIGIN,
  runId as run,
  step,
} from './smoke-lib';

const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;

let ownerCookie = '';
let teacherCookie = '';
const api = makeApi(() => ownerCookie);
const teacher = makeApi(() => teacherCookie);

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const daysAgo = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const phone = () => `0300${String(Math.floor(1_000_000 + Math.random() * 8_999_999))}`;

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

async function main() {
  let g1 = '';
  let g2 = '';
  let restore: { attendance_mode: string; weekly_off: number[] } | null = null;
  let khan: AdmissionResult | null = null;
  let zain: AdmissionResult | null = null;
  let bilal: AdmissionResult | null = null;
  let token = '';

  const register = (grp: string, marks: [string, 'P' | 'A'][]): AttendanceSubmission => ({
    client_id: newId(),
    grp_id: grp,
    date: today,
    taken_at: new Date(Date.now() - 60_000).toISOString(),
    marks: marks.map(([student_id, status]) => ({ student_id, status })),
  });

  await step('API reachable', async () => {
    const r = await api<{ status: string }>('GET', '/api/health');
    expectOk(r.status === 200, r);
  });

  await step(`owner session for ${EMAIL}; school, session, weekly off cleared`, async () => {
    ownerCookie = (await mintDevSession(EMAIL)).cookie;
    const s = await api<SchoolResponse>('GET', '/api/school');
    if (!s.body.school)
      await api('PUT', '/api/school', { name: 'Smoke Test School', mode: 'both' });
    const sessions = await api<{ items: SessionDto[] }>('GET', '/api/sessions');
    if (!sessions.body.items.some((x) => x.is_current))
      await api('POST', '/api/sessions', {
        name: '2026-27',
        start_date: '2026-04-01',
        end_date: '2027-03-31',
      });
    await api('POST', '/api/programmes/seed-pk');
    const sc = (await api<SchoolResponse>('GET', '/api/school')).body.school;
    restore = {
      attendance_mode: sc?.attendance_mode ?? 'daily',
      weekly_off: sc?.weekly_off ?? [0],
    };
    const r = await api('PUT', '/api/school/attendance', {
      attendance_mode: 'daily',
      weekly_off: [],
    });
    expectOk(r.status === 200, r);
  });

  await step(
    'two groups, a class teacher for the first, three children in two families',
    async () => {
      const progs = await api<{ items: ProgrammeDto[] }>('GET', '/api/programmes');
      const c4 = progs.body.items.find((p) => p.name === 'Class 4');
      expectOk(c4, 'Class 4 missing');
      const inv = await api<StaffRowDto>('POST', '/api/staff/invite', {
        email: `m5-teacher-${run}@example.com`,
        role: 'teacher',
        name: `Ms Rabia ${run}`,
        with_profile: true,
      });
      expectOk(inv.status === 201, inv);
      const mk = async (name: string, t: string | null) => {
        const g = await api<GroupDto>('POST', '/api/groups', {
          programme_id: c4?.id,
          name,
          class_teacher_id: t,
        });
        expectOk(g.status === 201, g);
        return g.body.id;
      };
      g1 = await mk(`4-${run}`, inv.body.staff_id);
      g2 = await mk(`4x-${run}`, null);
      teacherCookie = (await mintDevSession(`m5-teacher-${run}@example.com`, { activate: true }))
        .cookie;
      const admit = async (body: Record<string, unknown>) => {
        const r = await api<AdmissionResult>('POST', '/api/admissions', body);
        expectOk(r.status === 201, r);
        return r.body;
      };
      khan = await admit({
        family: { name: `Khan ${run}` },
        guardians: [
          {
            name: `Imran Khan ${run}`,
            phone: phone(),
            cnic: '35202-1234567-1',
            consent_whatsapp: true,
            lang: 'ur',
          },
        ],
        student: { name: `Ali ${run}`, admission_date: daysAgo(30), dob: '2016-05-04' },
        enrolment: { grp_id: g1 },
      });
      zain = await admit({
        family_id: khan.family_id,
        student: { name: `Zain ${run}`, admission_date: daysAgo(30) },
        enrolment: { grp_id: g2 },
      });
      bilal = await admit({
        family: { name: `Ahmed ${run}` },
        guardians: [{ name: `Tariq ${run}`, phone: phone(), consent_whatsapp: true, lang: 'en' }],
        student: { name: `Bilal ${run}`, admission_date: daysAgo(30) },
        enrolment: { grp_id: g1 },
      });
    },
  );

  await step(
    'registers: Ali + Bilal absent (teacher), Zain absent in the other group → 2 rows',
    async () => {
      const [a] = (
        await teacher<{ results: AttendanceSyncResult[] }>('POST', '/api/attendance/sync', [
          register(g1, [
            [khan?.student_id ?? '', 'A'],
            [bilal?.student_id ?? '', 'A'],
          ]),
        ])
      ).body.results;
      expectOk(a?.status === 'applied' && a.queued_messages === 2, a);
      const [b] = (
        await api<{ results: AttendanceSyncResult[] }>('POST', '/api/attendance/sync', [
          register(g2, [[zain?.student_id ?? '', 'A']]),
        ])
      ).body.results;
      // Khan already has today's absence row (one per family per day): Zain is merged at send time.
      expectOk(b?.status === 'applied' && b.queued_messages === 0, b);
    },
  );

  await step('office corrects Bilal to present', async () => {
    const r = await api('POST', '/api/attendance/correct', {
      ...register(g1, [
        [khan?.student_id ?? '', 'A'],
        [bilal?.student_id ?? '', 'P'],
      ]),
      reason: 'came late; smoke m5',
    });
    expectOk(r.status === 200, r);
  });

  let queue: MessageListDto | null = null;
  await step("teacher's queue: both absence rows of the group", async () => {
    const r = await teacher<MessageListDto>('GET', `/api/messages?status=queued&grp_id=${g1}`);
    expectOk(r.status === 200 && r.body.items.length === 2, r);
    queue = r.body;
    return `pending ${r.body.counts.queued}`;
  });

  await step('open Bilal → skipped (no_longer_absent)', async () => {
    const row = queue?.items.find((m) => m.family_id === bilal?.family_id);
    const r = await teacher<MessageOpenDto>('POST', `/api/messages/${row?.id}/open`);
    expectOk(r.body.status === 'skipped' && r.body.skipped_reason === 'no_longer_absent', r);
  });

  await step(
    'open Khan → Ali + Zain merged, Urdu, link alone on last line, wa.me decodes',
    async () => {
      const row = queue?.items.find((m) => m.family_id === khan?.family_id);
      const r = await teacher<MessageOpenDto>('POST', `/api/messages/${row?.id}/open`);
      expectOk(r.status === 200 && r.body.status === 'queued', r);
      expectOk(r.body.children.length === 2 && r.body.text.includes(' اور '), r.body);
      const last = r.body.text.split('\n').at(-1) ?? '';
      expectOk(/\/p#[A-Za-z0-9_-]{43}$/.test(last), last);
      token = last.split('/p#')[1] ?? '';
      const u = new URL(r.body.wa_url ?? 'x:');
      expectOk(u.host === 'wa.me' && u.searchParams.get('text') === r.body.text, r.body.wa_url);
      // The queue (and so the stored row) holds only the {link} stub, never the live link.
      const listed = await teacher<{ message: { preview: string } }>(
        'GET',
        `/api/messages/${row?.id}`,
      );
      expectOk(
        listed.body.message.preview.endsWith('\n{link}') && !listed.text.includes(token),
        listed.body.message.preview,
      );
      const sent = await teacher<{ status: string }>('POST', `/api/messages/${row?.id}/sent`);
      expectOk(sent.body.status === 'sent', sent);
    },
  );

  await step('compose a notice to the first group (cursor loop until next = null)', async () => {
    const notice_id = newId();
    let after: string | null = null;
    let queued = 0;
    do {
      const r: { status: number; body: ComposeResultDto } = await api<ComposeResultDto>(
        'POST',
        '/api/messages/compose',
        {
          notice_id,
          audience: { kind: 'group', grp_id: g1 },
          body_en: 'Parents meeting on Saturday for {children}.',
          body_ur: 'ہفتہ کو {children} کے والدین کی میٹنگ ہے۔',
          ...(after ? { after } : {}),
        },
      );
      expectOk(r.status === 201 || r.status === 200, r);
      queued += r.body.queued;
      after = r.body.next;
    } while (after);
    expectOk(queued === 2, `queued ${queued}`);
    const teacherSees = await teacher<MessageListDto>('GET', '/api/messages?template_key=notice');
    expectOk(teacherSees.body.items.length === 0, 'teacher sees notices');
  });

  let gateToken = '';
  let receiptNo = '';
  await step('a payment for the Khan family (credit), for the receipt whitelist', async () => {
    const r = await api<{ receipt: { receipt_no: string } }>('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: khan?.family_id,
      amount: 10000,
      method: 'cash',
    });
    expectOk(r.status === 201, r);
    receiptNo = r.body.receipt.receipt_no;
  });

  await step('birth-year gate (auto link follows the school gate) → gate token', async () => {
    const pre = await fetch(`${BASE}/api/p`, { headers: { 'x-parent-token': token } });
    const body = (await pre.json()) as ParentPageDto;
    expectOk(pre.status === 200, body);
    if (body.gate.kind === 'none') return 'school gate is none';
    expectOk(body.dues === null && body.receipts === null, 'dues before the gate');
    const g = await fetch(`${BASE}/api/p/gate`, {
      method: 'POST',
      headers: { 'x-parent-token': token, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ birth_year: 2016 }),
    });
    const gb = (await g.json()) as { gate_token: string };
    expectOk(g.status === 200, gb);
    gateToken = gb.gate_token;
    return body.gate.kind;
  });

  const parentHeaders = () => ({
    'x-parent-token': token,
    ...(gateToken ? { 'x-parent-gate': gateToken } : {}),
  });

  await step(
    'GET /api/p (header token): whitelist — first names, child index, no ids/CNIC/DOB, noindex',
    async () => {
      const res = await fetch(`${BASE}/api/p`, { headers: parentHeaders() });
      const text = await res.text();
      expectOk(res.status === 200, text);
      expectOk(res.headers.get('x-robots-tag')?.includes('noindex'), 'x-robots-tag');
      expectOk(res.headers.get('cache-control') === 'no-store', 'cache-control');
      expectOk(res.headers.get('referrer-policy') === 'no-referrer', 'referrer-policy');
      const body = JSON.parse(text) as ParentPageDto;
      expectOk(body.guardian.first_name === 'Imran' && body.children.length === 2, body);
      expectOk(body.children.find((c) => c.first_name === 'Ali')?.today === 'A', body.children);
      expectOk(body.notices.length === 1 && body.dues, body);
      const keys = keysOf(body);
      for (const k of ['cnic', 'b_form_no', 'dob', 'whatsapp', 'admission_no', 'family_id', 'id'])
        expectOk(!keys.has(k), `leaks ${k}`);
      expectOk(!/35202|2016-05-04/.test(text), 'leaks CNIC or DOB');
      expectOk(!ULID.test(text), 'leaks a database id');
      expectOk(
        body.children.map((c) => c.index).join() === '1,2',
        body.children.map((c) => c.index),
      );
      expectOk(
        body.receipts?.some((r) => r.receipt_no === receiptNo),
        body.receipts,
      );
    },
  );

  await step('GET /api/p/receipt/:no: whitelist — no ids, no staff, first names', async () => {
    const res = await fetch(`${BASE}/api/p/receipt/${encodeURIComponent(receiptNo)}`, {
      headers: parentHeaders(),
    });
    const text = await res.text();
    expectOk(res.status === 200, text);
    const body = JSON.parse(text) as ParentReceiptDto;
    expectOk(body.receipt.payer_name === 'Imran' && body.receipt.receipt_no === receiptNo, body);
    const bare = JSON.stringify({ ...body, labels: null });
    expectOk(!ULID.test(bare), 'receipt leaks a database id');
    expectOk(!/collector|account_id|cash_session|admission_no/.test(bare), 'receipt leaks staff');
  });

  await step('GET /api/p without a token → JSON 404 with noindex', async () => {
    const res = await fetch(`${BASE}/api/p`);
    expectOk(res.status === 404, res.status);
    expectOk(res.headers.get('x-robots-tag')?.includes('noindex'), 'x-robots-tag');
    expectOk(res.headers.get('content-type')?.includes('json'), 'json');
  });

  await step('GET /p (SPA shell) carries noindex / no-store / Permissions-Policy', async () => {
    const res = await fetch(`${BASE}/p`);
    expectOk(res.headers.get('x-robots-tag')?.includes('noindex'), [...res.headers]);
    expectOk(res.headers.get('cache-control') === 'no-store', 'cache-control');
    expectOk(res.headers.get('permissions-policy')?.includes('microphone=()'), 'permissions');
    expectOk(res.headers.get('content-security-policy')?.includes('frame-ancestors'), 'csp');
    return `status ${res.status}`;
  });

  await step('revoke the link → GET /api/p is 404', async () => {
    const r = await api<ParentLinkCreatedDto>(
      'POST',
      `/api/guardians/${khan?.guardian_ids[0]}/parent-link/revoke`,
    );
    expectOk(r.status === 200 && r.body.link?.status === 'revoked', r);
    const p = await fetch(`${BASE}/api/p`, { headers: { 'x-parent-token': token } });
    expectOk(p.status === 404, p.status);
  });

  await always('cleanup: restore weekly off', async () => {
    if (restore) await api('PUT', '/api/school/attendance', restore);
  });
  finish();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

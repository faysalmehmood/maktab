import { enrolment, family, guardian, staff, student } from '@maktab/db';
import {
  type AdmissionResult,
  type AttendanceSubmission,
  type BulkTextDto,
  type CollectResultDto,
  type ComposeResultDto,
  DEFAULT_TEMPLATES,
  type GroupDto,
  type MessageListDto,
  type MessageOpenDto,
  type MessageTemplateDto,
  newId,
  type ParentGateResultDto,
  type ParentLinkCreatedDto,
  type ParentLinkStatusDto,
  type ParentPageDto,
  type ProgrammeDto,
  type ReceiptPrintDto,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { todayPk } from '../src/lib/http';
import { sha256Hex } from '../src/lib/messaging';
import { signedInAs, testApp } from './helpers';

type Res<T> = { status: number; body: T; text: string; headers: Headers };
type Err = { error: { code: string; message: string } };

function client(request: ReturnType<typeof testApp>['request'], cookie: string | null) {
  return async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Res<T>> => {
    const res = await request(path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed as T, text, headers: res.headers };
  };
}

const today = todayPk();
const daysAgo = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

/**
 * Al-Noor: 5-A (class teacher Ms Sana) and 5-B. Khan family (Urdu-speaking guardian with WhatsApp
 * consent): Ali in 5-A, Zain in 5-B. Ahmed family (English, no consent → "call"): Bilal in 5-A.
 */
async function setup() {
  const t = testApp();
  const owner = await signedInAs(t.db, ['owner']);
  const api = client(t.request, owner.cookie);
  expect((await api('PUT', '/api/school', { name: 'Al-Noor', mode: 'school' })).status).toBe(200);
  await api('PUT', '/api/school/attendance', { attendance_mode: 'daily', weekly_off: [] });
  await api('POST', '/api/sessions', {
    name: '2026-27',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  const progs = await api<{ items: ProgrammeDto[] }>('POST', '/api/programmes/seed-pk');
  const c5 = progs.body.items.find((p) => p.name === 'Class 5')?.id;
  const g5a = (await api<GroupDto>('POST', '/api/groups', { programme_id: c5, name: 'A' })).body;
  const g5b = (await api<GroupDto>('POST', '/api/groups', { programme_id: c5, name: 'B' })).body;
  const teacher = await signedInAs(t.db, ['teacher']);
  const staffId = newId();
  await t.db.insert(staff).values({ id: staffId, userId: teacher.userId, name: 'Ms Sana' });
  await api('PATCH', `/api/groups/${g5a.id}`, { class_teacher_id: staffId });
  const accountant = await signedInAs(t.db, ['accountant']);
  const admit = async (body: Record<string, unknown>) => {
    const r = await api<AdmissionResult>('POST', '/api/admissions', body);
    expect(r.status, r.text).toBe(201);
    return r.body;
  };
  const start = daysAgo(40);
  const ali = await admit({
    family: { name: 'Khan' },
    guardians: [
      {
        name: 'Imran Khan',
        relation: 'father',
        phone: '0300-1234567',
        cnic: '35202-1234567-1',
        consent_whatsapp: true,
        lang: 'ur',
      },
    ],
    student: {
      name: 'Ali Khan',
      admission_date: start,
      dob: '2016-05-04',
      b_form_no: '3520212345671',
    },
    enrolment: { grp_id: g5a.id },
  });
  const zain = await admit({
    family_id: ali.family_id,
    student: { name: 'Zain Khan', admission_date: start },
    enrolment: { grp_id: g5b.id },
  });
  const bilal = await admit({
    family: { name: 'Ahmed' },
    guardians: [{ name: 'Tariq', phone: '0301-7654321', consent_whatsapp: false, lang: 'en' }],
    student: { name: 'Bilal', admission_date: start },
    enrolment: { grp_id: g5a.id },
  });
  const [khanG] = await t.db.all<{ id: string }>(
    sql`SELECT id FROM guardian WHERE family_id = ${ali.family_id}`,
  );
  return {
    ...t,
    api,
    teacher: client(t.request, teacher.cookie),
    acct: client(t.request, accountant.cookie),
    anon: client(t.request, null),
    g5a,
    g5b,
    ali,
    zain,
    bilal,
    khanGuardian: khanG?.id ?? '',
  };
}
type S = Awaited<ReturnType<typeof setup>>;

async function register(s: S, grpId: string, marks: [string, 'P' | 'A'][]) {
  const sub: AttendanceSubmission = {
    client_id: newId(),
    grp_id: grpId,
    date: today,
    taken_at: new Date(Date.now() - 60_000).toISOString(),
    marks: marks.map(([student_id, status]) => ({ student_id, status })),
  };
  const r = await s.api('POST', '/api/attendance/sync', [sub]);
  expect(r.status, r.text).toBe(200);
}

async function correct(s: S, grpId: string, marks: [string, 'P' | 'A'][]) {
  const r = await s.api('POST', '/api/attendance/correct', {
    client_id: newId(),
    grp_id: grpId,
    date: today,
    marks: marks.map(([student_id, status]) => ({ student_id, status })),
    reason: 'came late, marked by mistake',
  });
  expect(r.status, r.text).toBe(200);
}

async function queue(s: S, q = 'status=queued') {
  const r = await s.api<MessageListDto>('GET', `/api/messages?${q}`);
  expect(r.status, r.text).toBe(200);
  return r.body;
}

/** The innermost cause's message (drizzle wraps SQLite's text). */
async function dbError(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (err) {
    let e: unknown = err;
    let msg = '';
    while (e instanceof Error) {
      msg = e.message;
      e = e.cause;
    }
    return msg;
  }
  return '(no error)';
}

const lastLine = (t: string) => t.split('\n').at(-1) ?? '';

/** Every key anywhere in a JSON value. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

describe('send queue: absence rebuilt at open time', () => {
  it('merges a sibling absent in another group, puts the parent link alone on the last line, Urdu wa.me round-trips', async () => {
    const s = await setup();
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'P'],
    ]);
    await register(s, s.g5b.id, [[s.zain.student_id, 'A']]);
    const q = await queue(s);
    const khan = q.items.filter((m) => m.family_id === s.ali.family_id);
    expect(khan).toHaveLength(1); // one message per family per day
    expect(khan[0]).toMatchObject({ channel: 'wa_manual', lang: 'ur', wa_number: '923001234567' });
    expect(q.counts.queued).toBe(1);

    const open = await s.api<MessageOpenDto>('POST', `/api/messages/${khan[0]?.id}/open`);
    expect(open.status, open.text).toBe(200);
    expect(open.body.status).toBe('queued'); // opening never marks sent
    expect(open.body.children.sort()).toEqual(['Ali Khan', 'Zain Khan']);
    expect(open.body.text).toContain('Ali Khan اور Zain Khan');
    expect(open.body.text).toContain('السلام علیکم');
    expect(lastLine(open.body.text)).toMatch(/^http:\/\/localhost:5173\/p\/[A-Za-z0-9_-]{43}$/);
    const url = new URL(open.body.wa_url ?? '');
    expect(url.origin + url.pathname).toBe('https://wa.me/923001234567');
    expect(url.searchParams.get('text')).toBe(open.body.text);
    expect(decodeURIComponent((open.body.wa_url ?? '').split('?text=')[1] ?? '')).toBe(
      open.body.text,
    );
    // The link it carries is the guardian's live link (stored hashed on the message).
    const token = lastLine(open.body.text).split('/p/')[1] ?? '';
    const [m] = await s.db.all<{
      link_token_hash: string;
      rendered_text: string;
      opened_at: string;
    }>(
      sql`SELECT link_token_hash, rendered_text, opened_at FROM message WHERE id = ${khan[0]?.id}`,
    );
    expect(m?.link_token_hash).toBe(await sha256Hex(token));
    expect(m?.rendered_text).toBe(open.body.text);
    expect(m?.opened_at).toBeTruthy();
    // Opening again reuses the same link (no rotation per message).
    const again = await s.api<MessageOpenDto>('POST', `/api/messages/${khan[0]?.id}/open`);
    expect(lastLine(again.body.text)).toBe(lastLine(open.body.text));
    const page = await s.anon<ParentPageDto>('GET', `/api/p/${token}`);
    expect(page.status).toBe(200);
  });

  it('a child corrected to present before sending → the row is skipped (no_longer_absent)', async () => {
    const s = await setup();
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'P'],
      [s.bilal.student_id, 'A'],
    ]);
    const [row] = (await queue(s)).items;
    expect(row).toMatchObject({ family_id: s.bilal.family_id, channel: 'call' });
    await correct(s, s.g5a.id, [
      [s.ali.student_id, 'P'],
      [s.bilal.student_id, 'P'],
    ]);
    const open = await s.api<MessageOpenDto>('POST', `/api/messages/${row?.id}/open`);
    expect(open.body).toMatchObject({ status: 'skipped', skipped_reason: 'no_longer_absent' });
    const after = await s.api<MessageListDto>('GET', `/api/messages/${row?.id}`);
    expect(after.status).toBe(200);
    const [db] = await s.db.all<{ status: string; skipped_reason: string }>(
      sql`SELECT status, skipped_reason FROM message WHERE id = ${row?.id}`,
    );
    expect(db).toEqual({ status: 'skipped', skipped_reason: 'no_longer_absent' });
    expect((await queue(s)).counts).toMatchObject({ queued: 0, skipped_today: 1 });
  });

  it('a call row: English text, tel: link, no wa.me', async () => {
    const s = await setup();
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'P'],
      [s.bilal.student_id, 'A'],
    ]);
    const [row] = (await queue(s)).items;
    const open = await s.api<MessageOpenDto>('POST', `/api/messages/${row?.id}/open`);
    expect(open.body).toMatchObject({
      channel: 'call',
      wa_url: null,
      tel_url: 'tel:+923017654321',
    });
    expect(open.body.text).toMatch(/^Assalamu alaikum\. Bilal was absent/);
  });
});

describe('send queue: explicit sent and skip', () => {
  it('sent records who and when, only on the tap; repeat is harmless; skip after sent is refused', async () => {
    const s = await setup();
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'A'],
    ]);
    const items = (await queue(s)).items;
    const khan = items.find((m) => m.family_id === s.ali.family_id);
    const ahmed = items.find((m) => m.family_id === s.bilal.family_id);
    await s.api('POST', `/api/messages/${khan?.id}/open`);
    const [mid] = await s.db.all<{ status: string }>(
      sql`SELECT status FROM message WHERE id = ${khan?.id}`,
    );
    expect(mid?.status).toBe('queued');
    const sent = await s.api('POST', `/api/messages/${khan?.id}/sent`);
    expect(sent.body).toMatchObject({ status: 'sent', replayed: false });
    expect((await s.api('POST', `/api/messages/${khan?.id}/sent`)).body).toMatchObject({
      replayed: true,
    });
    const [row] = await s.db.all<{ sent_by: string; sent_at: string; status: string }>(
      sql`SELECT sent_by, sent_at, status FROM message WHERE id = ${khan?.id}`,
    );
    expect(row?.status).toBe('sent');
    expect(row?.sent_by).toBeTruthy();
    expect(row?.sent_at).toBeTruthy();
    const late = await s.api<Err>('POST', `/api/messages/${khan?.id}/skip`, {
      reason: 'duplicate',
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('not_queued');
    expect((await s.api<Err>('POST', `/api/messages/${khan?.id}/open`)).status).toBe(409);

    expect(
      (await s.api('POST', `/api/messages/${ahmed?.id}/skip`, { reason: 'made up' })).status,
    ).toBe(400);
    const skip = await s.api('POST', `/api/messages/${ahmed?.id}/skip`, {
      reason: 'informed_in_person',
    });
    expect(skip.body).toMatchObject({ status: 'skipped' });
    expect((await s.api('POST', `/api/messages/${ahmed?.id}/sent`)).status).toBe(409);
    // The database refuses a skipped row going back to the queue (trigger), whatever the caller.
    expect(
      await dbError(() =>
        s.db.run(sql`UPDATE message SET status = 'queued' WHERE id = ${ahmed?.id}`),
      ),
    ).toMatch(/no longer queued/);
    const c = (await queue(s)).counts;
    expect(c).toMatchObject({ queued: 0, sent_today: 1, skipped_today: 1 });
  });
});

describe('send queue: teacher scope', () => {
  it("a class teacher sees and sends only their groups' absence rows", async () => {
    const s = await setup();
    await register(s, s.g5b.id, [[s.zain.student_id, 'A']]);
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'P'],
      [s.bilal.student_id, 'A'],
    ]);
    const notice = await s.api<ComposeResultDto>('POST', '/api/messages/compose', {
      notice_id: newId(),
      audience: { kind: 'group', grp_id: s.g5a.id },
      body_en: 'School closed on Friday.',
    });
    expect(notice.status, notice.text).toBe(201);
    const mine = await s.teacher<MessageListDto>('GET', '/api/messages?status=queued');
    expect(mine.body.items.map((m) => [m.template_key, m.family_id])).toEqual([
      ['absence', s.bilal.family_id],
    ]);
    const all = (await queue(s)).items;
    const zainRow = all.find(
      (m) => m.template_key === 'absence' && m.family_id === s.ali.family_id,
    );
    const noticeRow = all.find((m) => m.template_key === 'notice');
    expect((await s.teacher('POST', `/api/messages/${zainRow?.id}/open`)).status).toBe(404);
    expect((await s.teacher('POST', `/api/messages/${noticeRow?.id}/sent`)).status).toBe(404);
    expect((await s.teacher('GET', `/api/messages/${zainRow?.id}`)).status).toBe(404);
    const ok = await s.teacher<MessageOpenDto>(
      'POST',
      `/api/messages/${mine.body.items[0]?.id}/open`,
    );
    expect(ok.status).toBe(200);
    expect((await s.teacher('POST', '/api/messages/compose', {})).status).toBe(403);
    expect((await s.teacher('POST', `/api/messages/bulk-text?grp_id=${s.g5b.id}`)).status).toBe(
      404,
    );
  });
});

describe('bulk text for a class announcement group', () => {
  it('is formula-safe, carries no phone numbers and no parent links, and drops children no longer absent', async () => {
    const s = await setup();
    await s.db.run(
      sql`UPDATE student SET name = '=HYPERLINK("http://x")' WHERE id = ${s.bilal.student_id}`,
    );
    // A template that starts with the name, so a formula would sit at the start of a line.
    const put = await s.api('PUT', '/api/messages/templates/absence/en', {
      body: '{children} absent today {date}.\nDetails:\n{link}',
    });
    expect(put.status, put.text).toBe(200);
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'A'],
    ]);
    const r = await s.api<BulkTextDto>('POST', `/api/messages/bulk-text?grp_id=${s.g5a.id}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.grp_name).toBe('Class 5 A');
    const lines = r.body.text.split('\n');
    expect(lines).toContain(
      `'=HYPERLINK("http://x") absent today ${today.split('-').reverse().join('/')}.`,
    );
    for (const l of lines) expect(l).not.toMatch(/^[=+\-@]/);
    expect(r.body.text).not.toMatch(/0300|92300|1234567|7654321/);
    expect(r.body.text).not.toContain('/p/');
    expect(r.body.text).not.toContain('Details:');
    await correct(s, s.g5a.id, [
      [s.ali.student_id, 'P'],
      [s.bilal.student_id, 'A'],
    ]);
    const after = await s.api<BulkTextDto>('POST', `/api/messages/bulk-text?grp_id=${s.g5a.id}`);
    expect(after.body.count).toBe(1);
    expect(after.body.text).not.toContain('Ali');
  });
});

describe('compose a notice', () => {
  it('queues one row per family in batches of 200 with a cursor; a retried call queues nothing twice', async () => {
    const s = await setup();
    // 210 more families with one child each in 5-B (direct inserts: setup data, not under test).
    const fams = Array.from({ length: 210 }, (_, i) => ({
      f: newId(),
      g: newId(),
      st: newId(),
      i,
    }));
    for (const x of fams) {
      await s.db.insert(family).values({ id: x.f, name: `Fam ${x.i}` });
      await s.db.insert(guardian).values({
        id: x.g,
        familyId: x.f,
        name: `G ${x.i}`,
        phone: `92300${String(1000000 + x.i)}`,
        consentWhatsapp: x.i % 2 === 0,
      });
      await s.db.insert(student).values({
        id: x.st,
        familyId: x.f,
        admissionNo: `X${x.i}`,
        name: `Kid ${x.i}`,
        admissionDate: daysAgo(10),
      });
      await s.db.insert(enrolment).values({
        id: newId(),
        studentId: x.st,
        grpId: s.g5b.id,
        isPrimary: true,
        startDate: daysAgo(10),
      });
    }
    const notice_id = newId();
    const body = {
      notice_id,
      audience: { kind: 'all' },
      body_en: 'Parents meeting on Saturday at 10 for {children}.',
      body_ur: 'ہفتہ کو 10 بجے {children} کے والدین کی میٹنگ ہے۔',
    };
    const first = await s.api<ComposeResultDto>('POST', '/api/messages/compose', body);
    expect(first.status, first.text).toBe(201);
    expect(first.body).toMatchObject({ queued: 200, skipped: 0, total: 212 });
    expect(first.body.next).toBeTruthy();
    const second = await s.api<ComposeResultDto>('POST', '/api/messages/compose', {
      ...body,
      after: first.body.next,
    });
    expect(second.body).toMatchObject({ queued: 12, next: null });
    const retry = await s.api<ComposeResultDto>('POST', '/api/messages/compose', body);
    expect(retry.body).toMatchObject({ queued: 0, skipped: 200 });
    const [n] = await s.db.all<{ n: number; call: number }>(
      sql`SELECT count(*) AS n, sum(channel = 'call') AS call FROM message WHERE template_key = 'notice'`,
    );
    expect(n?.n).toBe(212);
    expect(Number(n?.call)).toBeGreaterThan(100); // no consent → call
    const list = await s.api<MessageListDto>('GET', '/api/messages?template_key=notice');
    const khan = list.body.items.find((m) => m.family_id === s.ali.family_id);
    expect(khan?.preview).toContain('ہفتہ کو 10 بجے Ali Khan اور Zain Khan کے والدین');
    expect(
      (await s.api('POST', '/api/messages/compose', { ...body, body_en: 'Hi {nope}' })).status,
    ).toBe(400);
    expect((await s.acct('POST', '/api/messages/compose', body)).status).toBe(403);
  });
});

describe('templates', () => {
  it('migration seeds exactly the shared defaults; edit, preview and reset', async () => {
    const s = await setup();
    const rows = await s.db.all<{ key: string; lang: 'en' | 'ur'; body: string }>(
      sql`SELECT key, lang, body FROM message_template ORDER BY key, lang`,
    );
    expect(rows.length).toBe(12);
    for (const r of rows)
      expect(r.body).toBe(DEFAULT_TEMPLATES[r.key as keyof typeof DEFAULT_TEMPLATES][r.lang]);
    const bad = await s.api<Err>('PUT', '/api/messages/templates/fee_due/en', {
      body: 'Pay {cash}',
    });
    expect(bad.status).toBe(400);
    const ok = await s.api<{ item: MessageTemplateDto }>(
      'PUT',
      '/api/messages/templates/fee_due/en',
      {
        body: 'Please pay {amount}. {link} Thanks — {school}',
      },
    );
    expect(ok.body.item).toMatchObject({ is_default: false });
    const pv = await s.api<{ text: string; wa_url: string }>(
      'POST',
      '/api/messages/templates/preview',
      { key: 'fee_due', lang: 'en', body: ok.body.item.body },
    );
    expect(pv.body.text.split('\n')).toEqual([
      'Please pay Rs 8,000. Thanks — Al-Noor',
      expect.stringMatching(/\/p\//),
    ]);
    const reset = await s.api<{ item: MessageTemplateDto }>(
      'PUT',
      '/api/messages/templates/fee_due/en',
      { body: null },
    );
    expect(reset.body.item.is_default).toBe(true);
    const settings = await s.api('PUT', '/api/school/messages', {
      reminder_cooldown_days: 5,
      parent_gate: 'birth_year',
      announcement_groups_note: 'One group per class; admins only can post.',
    });
    expect(settings.body).toMatchObject({ reminder_cooldown_days: 5, parent_gate: 'birth_year' });
  });
});

describe('fee reminders are re-checked at open', () => {
  it('a family that paid since the reminder was queued is skipped (already_paid)', async () => {
    const s = await setup();
    // A queued fee_overdue reminder with nothing owed: the family settled up in the meantime.
    const id = newId();
    await s.db.run(sql`INSERT INTO message (id, family_id, guardian_id, channel, template_key, lang, payload, status)
      VALUES (${id}, ${s.ali.family_id}, ${s.khanGuardian}, 'wa_manual', 'fee_overdue', 'en',
              ${JSON.stringify({ student_names: ['Ali Khan'], overdue: 500000, as_of: today })}, 'queued')`);
    const open = await s.api<MessageOpenDto>('POST', `/api/messages/${id}/open`);
    expect(open.body).toMatchObject({ status: 'skipped', skipped_reason: 'already_paid' });
  });
});

describe('parent links and the public parent page', () => {
  async function linked(s: S, body: Record<string, unknown> = {}) {
    const r = await s.api<ParentLinkCreatedDto>(
      'POST',
      `/api/guardians/${s.khanGuardian}/parent-link`,
      body,
    );
    expect(r.status, r.text).toBe(201);
    const token = r.body.url.split('/p/')[1] ?? '';
    return { ...r.body, token };
  }

  it('create stores only a hash; rotate kills the old link; revoke → 404; expiry → 404', async () => {
    const s = await setup();
    const a = await linked(s);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.link).toMatchObject({ status: 'active', gate: 'none' });
    expect(a.link?.expires_at?.slice(0, 4)).toBe(String(Number(today.slice(0, 4)) + 1));
    const rows = await s.db.all<Record<string, unknown>>(sql`SELECT * FROM parent_link`);
    for (const r of rows) for (const v of Object.values(r)) expect(v).not.toBe(a.token);
    expect(rows[0]?.token_hash).toBe(await sha256Hex(a.token));
    // The status endpoint never returns the URL again.
    const st = await s.api<ParentLinkStatusDto>(
      'GET',
      `/api/guardians/${s.khanGuardian}/parent-link`,
    );
    expect(st.text).not.toContain(a.token);
    expect((await s.anon('GET', `/api/p/${a.token}`)).status).toBe(200);

    const b = await linked(s);
    expect(b.token).not.toBe(a.token);
    expect((await s.anon('GET', `/api/p/${a.token}`)).status).toBe(404);
    expect((await s.anon('GET', `/api/p/${b.token}`)).status).toBe(200);

    expect(
      (await s.api('POST', `/api/guardians/${s.khanGuardian}/parent-link/revoke`)).status,
    ).toBe(200);
    expect((await s.anon('GET', `/api/p/${b.token}`)).status).toBe(404);
    expect(
      (await s.api('POST', `/api/guardians/${s.khanGuardian}/parent-link/revoke`)).status,
    ).toBe(404);

    const c = await linked(s);
    await s.db.run(
      sql`UPDATE parent_link SET expires_at = '2020-01-01T00:00:00.000Z' WHERE revoked_at IS NULL`,
    );
    expect((await s.anon('GET', `/api/p/${c.token}`)).status).toBe(404);
    // Tokens are never edited, links never deleted (triggers).
    expect(await dbError(() => s.db.run(sql`UPDATE parent_link SET token_hash = 'x'`))).toMatch(
      /never edited/,
    );
    expect(await dbError(() => s.db.run(sql`DELETE FROM parent_link`))).toMatch(
      /cannot be deleted/,
    );
    expect(
      (await s.teacher('POST', `/api/guardians/${s.khanGuardian}/parent-link`, {})).status,
    ).toBe(403);
  });

  it('page shape: first names, class, today, month %, dues, receipts, notices — never CNIC, B-form, DOB, phones, staff', async () => {
    const s = await setup();
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'P'],
    ]);
    const pay = await s.api<CollectResultDto>('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: s.ali.family_id,
      amount: 250000,
      method: 'cash',
    });
    expect(pay.status, pay.text).toBe(201);
    await s.api('POST', '/api/messages/compose', {
      notice_id: newId(),
      audience: { kind: 'families', family_ids: [s.ali.family_id] },
      body_en: 'Holiday on Monday for {children}.',
      body_ur: 'پیر کو چھٹی ہے۔',
    });
    const { token } = await linked(s);
    const r = await s.anon<ParentPageDto>('GET', `/api/p/${token}`, undefined, {
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'TestPhone/1.0',
    });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body.guardian).toEqual({ first_name: 'Imran', lang: 'ur' });
    expect(r.body.children.map((c) => [c.first_name, c.group, c.today])).toEqual([
      ['Ali', 'Class 5 A', 'A'],
      ['Zain', 'Class 5 B', null],
    ]);
    expect(r.body.children[0]?.month).toMatchObject({ absent: 1, pct: 0 });
    expect(r.body.dues).toMatchObject({ credit: 250000, total: 0 });
    expect(r.body.receipts?.map((x) => x.amount)).toEqual([250000]);
    expect(r.body.notices.map((n) => n.body_ur)).toEqual(['پیر کو چھٹی ہے۔']);
    expect(r.body.notices[0]?.body_en).toBe('Holiday on Monday for Ali and Zain.');
    const keys = keysOf(r.body);
    for (const k of [
      'cnic',
      'b_form_no',
      'dob',
      'phone',
      'whatsapp',
      'salary',
      'base_salary',
      'admission_no',
      'family_id',
      'guardian_id',
      'student_id',
      'staff',
      'collector_name',
    ])
      if (k !== 'phone') expect(keys.has(k), k).toBe(false);
    // The only phone is the school's own (school.phone), never a guardian's.
    expect(r.text).not.toMatch(/1234567|35202|3520212345671|2016-05-04|Imran Khan|Ali Khan/);
    // Receipt print JSON, internal fields blanked.
    const rc = await s.anon<ReceiptPrintDto>(
      'GET',
      `/api/p/${token}/receipt/${pay.body.receipt.id}`,
    );
    expect(rc.status, rc.text).toBe(200);
    expect(rc.body.receipt).toMatchObject({ collector_id: '', note: null, cash_session_id: null });
    // Another family's receipt: not found.
    const other = await s.api<CollectResultDto>('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: s.bilal.family_id,
      amount: 10000,
      method: 'cash',
    });
    expect((await s.anon('GET', `/api/p/${token}/receipt/${other.body.receipt.id}`)).status).toBe(
      404,
    );
    // Access log: a repeat visit from the same IP is one row; another IP is another.
    await s.anon('GET', `/api/p/${token}`, undefined, { 'cf-connecting-ip': '203.0.113.9' });
    await s.anon('GET', `/api/p/${token}`, undefined, { 'cf-connecting-ip': '198.51.100.7' });
    const st = await s.api<ParentLinkStatusDto>(
      'GET',
      `/api/guardians/${s.khanGuardian}/parent-link`,
    );
    expect(st.body.access).toHaveLength(2);
    expect(st.body.access[1]?.ua).toBe('TestPhone/1.0');
    expect(st.body.access[0]?.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(st.text).not.toContain('203.0.113.9');
    expect(st.body.link?.last_seen_at).toBeTruthy();
  });

  it('birth-year gate hides dues and receipts until answered; 5 wrong answers lock it', async () => {
    const s = await setup();
    const { token } = await linked(s, { gate: 'birth_year' });
    const before = await s.anon<ParentPageDto>('GET', `/api/p/${token}`);
    expect(before.body.gate).toEqual({ kind: 'birth_year', passed: false });
    expect(before.body.dues).toBeNull();
    expect(before.body.receipts).toBeNull();
    expect(before.body.children).toHaveLength(2); // attendance stays visible
    const wrong = await s.anon<Err>('POST', `/api/p/${token}/gate`, { birth_year: 2015 });
    expect(wrong.status).toBe(400);
    const ok = await s.anon<ParentGateResultDto>('POST', `/api/p/${token}/gate`, {
      birth_year: 2016,
    });
    expect(ok.status, ok.text).toBe(200);
    const after = await s.anon<ParentPageDto>('GET', `/api/p/${token}`, undefined, {
      'x-parent-gate': ok.body.gate_token,
    });
    expect(after.body.gate.passed).toBe(true);
    expect(after.body.dues).not.toBeNull();
    for (let i = 0; i < 5; i++) await s.anon('POST', `/api/p/${token}/gate`, { birth_year: 1999 });
    const locked = await s.anon<Err>('POST', `/api/p/${token}/gate`, { birth_year: 2016 });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('gate_locked');
    // A gate token for one link does not open another.
    const other = await s.api<ParentLinkCreatedDto>(
      'POST',
      `/api/guardians/${(await s.db.all<{ id: string }>(sql`SELECT id FROM guardian WHERE family_id = ${s.bilal.family_id}`))[0]?.id}/parent-link`,
      { gate: 'birth_year' },
    );
    const t2 = other.body.url.split('/p/')[1];
    const cross = await s.anon<ParentPageDto>('GET', `/api/p/${t2}`, undefined, {
      'x-parent-gate': ok.body.gate_token,
    });
    expect(cross.body.gate.passed).toBe(false);
  });

  it('PIN gate; a PIN is required to create one', async () => {
    const s = await setup();
    expect(
      (await s.api<Err>('POST', `/api/guardians/${s.khanGuardian}/parent-link`, { gate: 'pin' }))
        .body.error.code,
    ).toBe('pin_required');
    const { token } = await linked(s, { gate: 'pin', pin: '4821' });
    expect((await s.anon('POST', `/api/p/${token}/gate`, { pin: '1111' })).status).toBe(400);
    expect((await s.anon('POST', `/api/p/${token}/gate`, { pin: '4821' })).status).toBe(200);
    const [row] = await s.db.all<{ pin_hash: string }>(
      sql`SELECT pin_hash FROM parent_link WHERE revoked_at IS NULL`,
    );
    expect(row?.pin_hash).not.toContain('4821');
  });

  it('rate limit: 60 requests a minute per token, then 429', async () => {
    const s = await setup();
    const { token } = await linked(s);
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++)
      statuses.push(
        (await s.anon('GET', `/api/p/${token}`, undefined, { 'cf-connecting-ip': '192.0.2.1' }))
          .status,
      );
    expect(statuses.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Garbage tokens are just 404s (and also counted).
    expect((await s.anon('GET', '/api/p/not-a-token')).status).toBe(404);
  });

  it('/p/:token serves the SPA shell with noindex and no-store', async () => {
    const s = await setup();
    const res = await s.request('/p/abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

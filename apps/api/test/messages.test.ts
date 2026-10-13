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
  type ParentReceiptDto,
  type ProgrammeDto,
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
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;
/** The parent page sends its link token in a header, never in the URL. */
const P = (token: string | undefined, extra: Record<string, string> = {}) => ({
  'x-parent-token': token ?? '',
  ...extra,
});

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
    expect(open.body.text).toContain('غیر حاضر تھے۔');
    expect(lastLine(open.body.text)).toMatch(/^http:\/\/localhost:5173\/p#[A-Za-z0-9_-]{43}$/);
    const url = new URL(open.body.wa_url ?? '');
    expect(url.origin + url.pathname).toBe('https://wa.me/923001234567');
    expect(url.searchParams.get('text')).toBe(open.body.text);
    expect(decodeURIComponent((open.body.wa_url ?? '').split('?text=')[1] ?? '')).toBe(
      open.body.text,
    );
    // The link it carries is the guardian's live link (stored hashed on the message).
    const token = lastLine(open.body.text).split('/p#')[1] ?? '';
    const [m] = await s.db.all<{
      link_token_hash: string;
      rendered_text: string;
      opened_at: string;
    }>(
      sql`SELECT link_token_hash, rendered_text, opened_at FROM message WHERE id = ${khan[0]?.id}`,
    );
    expect(m?.link_token_hash).toBe(await sha256Hex(token));
    // The row keeps the text with a stub in place of the link: no working link is ever stored.
    expect(m?.rendered_text).toBe(open.body.text.replace(lastLine(open.body.text), '{link}'));
    expect(m?.rendered_text).not.toContain(token);
    expect(m?.opened_at).toBeTruthy();
    // Opening again reuses the same link (no rotation per message).
    const again = await s.api<MessageOpenDto>('POST', `/api/messages/${khan[0]?.id}/open`);
    expect(lastLine(again.body.text)).toBe(lastLine(open.body.text));
    const page = await s.anon<ParentPageDto>('GET', '/api/p', undefined, P(token));
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
    expect(r.body.text).not.toMatch(/\/p[#/]/);
    expect(r.body.text).not.toContain('{link}');
    expect(r.body.text).not.toContain('Details:');
    // Fee texts are private to a family: never offered for a class group.
    expect(
      (await s.api('POST', `/api/messages/bulk-text?grp_id=${s.g5a.id}&template_key=fee_due`))
        .status,
    ).toBe(400);
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
    // The notice sits in the template's {body} slot: greeting first, link stub alone on the last line.
    expect(khan?.preview.split('\n')).toEqual([
      'السلام علیکم۔',
      'ہفتہ کو 10 بجے Ali Khan اور Zain Khan کے والدین کی میٹنگ ہے۔',
      '— Al-Noor',
      '{link}',
    ]);
    const open = await s.api<MessageOpenDto>('POST', `/api/messages/${khan?.id}/open`);
    expect(lastLine(open.body.text)).toMatch(/\/p#[A-Za-z0-9_-]{43}$/);
    expect(open.body.text.split('\n')).toHaveLength(4);
    expect(
      (await s.api('POST', '/api/messages/compose', { ...body, body_en: 'See {link}' })).status,
    ).toBe(400);
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
      expect.stringMatching(/\/p#/),
    ]);
    // Every text keeps {link}; the notice also keeps {body}; {body} belongs to the notice only.
    for (const [key, body] of [
      ['fee_due', 'Please pay {amount}.'],
      ['notice', 'Salaam. — {school}\n{link}'],
      ['absence', '{body} {children}\n{link}'],
    ] as const) {
      const r = await s.api<Err>('PUT', `/api/messages/templates/${key}/en`, { body });
      expect(r.status, `${key}: ${r.text}`).toBe(400);
    }
    const notice = await s.api<{ item: MessageTemplateDto }>(
      'PUT',
      '/api/messages/templates/notice/en',
      { body: 'Salaam.\n{body}\n{link}\n— {school}' },
    );
    expect(notice.status, notice.text).toBe(200);
    const npv = await s.api<{ text: string }>('POST', '/api/messages/templates/preview', {
      key: 'notice',
      lang: 'en',
      body: notice.body.item.body,
    });
    expect(npv.body.text.split('\n')).toEqual([
      'Salaam.',
      'School is closed on Monday.',
      '— Al-Noor',
      expect.stringMatching(/\/p#/),
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
    const token = r.body.url.split('/p#')[1] ?? '';
    return { ...r.body, token };
  }

  it('create stores only a hash; rotate kills the old link; revoke → 404; expiry → 404', async () => {
    const s = await setup();
    const a = await linked(s);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.url).toBe(`http://localhost:5173/p#${a.token}`);
    // The school default (and so a link's default) is the birth-year gate (M5 fix pass).
    expect(a.link).toMatchObject({ status: 'active', gate: 'birth_year' });
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
    expect((await s.anon('GET', '/api/p', undefined, P(a.token))).status).toBe(200);

    const b = await linked(s);
    expect(b.token).not.toBe(a.token);
    expect((await s.anon('GET', '/api/p', undefined, P(a.token))).status).toBe(404);
    expect((await s.anon('GET', '/api/p', undefined, P(b.token))).status).toBe(200);

    expect(
      (await s.api('POST', `/api/guardians/${s.khanGuardian}/parent-link/revoke`)).status,
    ).toBe(200);
    expect((await s.anon('GET', '/api/p', undefined, P(b.token))).status).toBe(404);
    expect(
      (await s.api('POST', `/api/guardians/${s.khanGuardian}/parent-link/revoke`)).status,
    ).toBe(404);

    const c = await linked(s);
    await s.db.run(
      sql`UPDATE parent_link SET expires_at = '2020-01-01T00:00:00.000Z' WHERE revoked_at IS NULL`,
    );
    expect((await s.anon('GET', '/api/p', undefined, P(c.token))).status).toBe(404);
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
    const { token } = await linked(s, { gate: 'none' });
    const r = await s.anon<ParentPageDto>('GET', '/api/p', undefined, {
      'x-parent-token': token,
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'TestPhone/1.0',
    });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body.guardian).toEqual({ first_name: 'Imran', lang: 'ur' });
    expect(r.body.children.map((c) => [c.index, c.first_name, c.group, c.today])).toEqual([
      [1, 'Ali', 'Class 5 A', 'A'],
      [2, 'Zain', 'Class 5 B', null],
    ]);
    // Whitelist: exactly these keys, and no database id (ULID) anywhere in the body.
    expect([...keysOf(r.body)].sort()).toEqual(
      [
        ...['school', 'name', 'name_ur', 'phone', 'guardian', 'first_name', 'lang', 'date'],
        ...['gate', 'kind', 'passed', 'children', 'index', 'group', 'today', 'month'],
        ...['present', 'absent', 'late', 'excused', 'pct', 'dues', 'lines'],
        ...[
          'total_before_credit',
          'credit',
          'total',
          'overdue',
          'receipts',
          'receipt_no',
          'turnstile_site_key',
        ],
        ...['amount', 'business_date', 'notices', 'at', 'body_en', 'body_ur'],
        // M7b: cache keys of the school's logo / generated badge (hashes, no ids).
        ...['logo_v', 'badge_v'],
      ].sort(),
    );
    expect(r.text).not.toMatch(ULID);
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
    // The receipt by its number, as a whitelist: no ids, no staff names, first names only.
    const no = pay.body.receipt.receipt_no;
    expect(r.body.receipts?.map((x) => x.receipt_no)).toEqual([no]);
    const rc = await s.anon<ParentReceiptDto>(
      'GET',
      `/api/p/receipt/${encodeURIComponent(no)}`,
      undefined,
      P(token),
    );
    expect(rc.status, rc.text).toBe(200);
    expect(rc.body.receipt).toEqual({
      receipt_no: no,
      business_date: pay.body.receipt.business_date,
      amount: 250000,
      method: 'cash',
      payer_name: 'Imran',
    });
    expect(Object.keys(rc.body).sort()).toEqual(
      ['school', 'labels', 'lang', 'receipt', 'students', 'totals', 'reversed'].sort(),
    );
    expect(Object.keys(rc.body.school).sort()).toEqual([
      'address',
      'badge_v',
      'logo_v',
      'name',
      'name_ur',
      'phone',
    ]);
    const rcBody = JSON.stringify({ ...rc.body, labels: null });
    expect(rcBody).not.toMatch(ULID);
    expect(rcBody).not.toMatch(
      /collector|account_id|cash_session|admission_no|Ali Khan|Imran Khan/,
    );
    for (const st of rc.body.students) expect(st.first_name).not.toContain(' ');
    // Another family's receipt: not found.
    const other = await s.api<CollectResultDto>('POST', '/api/receipts', {
      idempotency_key: newId(),
      payer_id: s.bilal.family_id,
      amount: 10000,
      method: 'cash',
    });
    expect(
      (
        await s.anon(
          'GET',
          `/api/p/receipt/${encodeURIComponent(other.body.receipt.receipt_no)}`,
          undefined,
          P(token),
        )
      ).status,
    ).toBe(404);
    // Access log: a repeat visit from the same IP is one row; another IP is another.
    await s.anon('GET', '/api/p', undefined, {
      'x-parent-token': token,
      'cf-connecting-ip': '203.0.113.9',
    });
    await s.anon('GET', '/api/p', undefined, {
      'x-parent-token': token,
      'cf-connecting-ip': '198.51.100.7',
    });
    const st = await s.api<ParentLinkStatusDto>(
      'GET',
      `/api/guardians/${s.khanGuardian}/parent-link`,
    );
    expect(st.body.access).toHaveLength(2);
    expect(st.body.access[1]?.ua).toBe('TestPhone/1.0');
    // HMAC(PARENT_LINK_SECRET, ip), full length.
    expect(st.body.access[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(st.text).not.toContain('203.0.113.9');
    expect(st.body.link?.last_seen_at).toBeTruthy();
  });

  it('birth-year gate hides dues and receipts until answered; 5 wrong answers lock it', async () => {
    const s = await setup();
    const { token } = await linked(s, { gate: 'birth_year' });
    const before = await s.anon<ParentPageDto>('GET', '/api/p', undefined, P(token));
    expect(before.body.gate).toEqual({ kind: 'birth_year', passed: false });
    expect(before.body.dues).toBeNull();
    expect(before.body.receipts).toBeNull();
    expect(before.body.children).toHaveLength(2); // attendance stays visible
    const wrong = await s.anon<Err>('POST', '/api/p/gate', { birth_year: 2015 }, P(token));
    expect(wrong.status).toBe(400);
    const ok = await s.anon<ParentGateResultDto>(
      'POST',
      '/api/p/gate',
      {
        birth_year: 2016,
      },
      P(token),
    );
    expect(ok.status, ok.text).toBe(200);
    const after = await s.anon<ParentPageDto>('GET', '/api/p', undefined, {
      'x-parent-token': token,
      'x-parent-gate': ok.body.gate_token,
    });
    expect(after.body.gate.passed).toBe(true);
    expect(after.body.dues).not.toBeNull();
    for (let i = 0; i < 5; i++) await s.anon('POST', '/api/p/gate', { birth_year: 1999 }, P(token));
    const locked = await s.anon<Err>('POST', '/api/p/gate', { birth_year: 2016 }, P(token));
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('gate_locked');
    // A gate token for one link does not open another.
    const other = await s.api<ParentLinkCreatedDto>(
      'POST',
      `/api/guardians/${(await s.db.all<{ id: string }>(sql`SELECT id FROM guardian WHERE family_id = ${s.bilal.family_id}`))[0]?.id}/parent-link`,
      { gate: 'birth_year' },
    );
    const t2 = other.body.url.split('/p#')[1] ?? '';
    const cross = await s.anon<ParentPageDto>('GET', '/api/p', undefined, {
      'x-parent-token': t2,
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
    expect((await s.anon('POST', '/api/p/gate', { pin: '1111' }, P(token))).status).toBe(400);
    expect((await s.anon('POST', '/api/p/gate', { pin: '4821' }, P(token))).status).toBe(200);
    const [row] = await s.db.all<{ pin_hash: string }>(
      sql`SELECT pin_hash FROM parent_link WHERE revoked_at IS NULL`,
    );
    expect(row?.pin_hash).not.toContain('4821');
  });

  it('rate limit: 60 requests a minute per token, then 429', async () => {
    const s = await setup();
    const { token } = await linked(s, { gate: 'none' });
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++)
      statuses.push(
        (
          await s.anon('GET', '/api/p', undefined, {
            'x-parent-token': token,
            'cf-connecting-ip': '192.0.2.1',
          })
        ).status,
      );
    expect(statuses.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Garbage or missing tokens are just JSON 404s with the noindex headers; a token in the path
    // is not a route at all.
    expect((await s.anon('GET', '/api/p', undefined, P('not-a-token'))).status).toBe(404);
    const none = await s.anon<Err>('GET', '/api/p');
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('not_found');
    expect(none.headers.get('x-robots-tag')).toContain('noindex');
    expect((await s.anon('GET', `/api/p/${token}`)).status).toBe(404);
  });

  it('/p serves the SPA shell with noindex, no-store and the SPA security headers', async () => {
    const s = await setup();
    for (const path of ['/p', '/p/abc']) {
      const res = await s.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('permissions-policy')).toBe(
        'camera=(self), microphone=(), geolocation=()',
      );
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
  });
});

describe('M5 fix pass: no live link at rest, routing, guards', () => {
  const LIVE = /\/p[#/][A-Za-z0-9_-]{43}/;

  it('no staff API response holds a live parent link except /open and POST parent-link; no message row does', async () => {
    const s = await setup();
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'A'],
    ]);
    const rows = (await queue(s)).items;
    const tokens: string[] = [];
    for (const r of rows) {
      const o = await s.api<MessageOpenDto>('POST', `/api/messages/${r.id}/open`);
      expect(o.status, o.text).toBe(200);
      const t = lastLine(o.body.text).split('/p#')[1];
      if (t) tokens.push(t);
    }
    expect(tokens.length).toBeGreaterThan(0);
    await s.api('POST', `/api/messages/${rows[0]?.id}/sent`);
    const ids: Record<string, string[]> = {
      id: [...rows.map((r) => r.id), s.khanGuardian, s.ali.family_id, s.ali.student_id, s.g5a.id],
    };
    const { routes } = s;
    let checked = 0;
    for (const r of routes.list()) {
      if (r.method !== 'GET' || r.path.startsWith('/api/p')) continue;
      const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? '');
      if (params.some((p) => !ids[p])) continue;
      const paths = params.length
        ? (ids.id ?? []).map((v) => r.path.replace(/:id\b/, v))
        : [r.path];
      for (const path of paths) {
        const res = await s.api('GET', path);
        checked++;
        for (const t of tokens) expect(res.text, path).not.toContain(t);
        expect(res.text, path).not.toMatch(LIVE);
      }
    }
    expect(checked).toBeGreaterThan(40);
    const bulk = await s.api('POST', `/api/messages/bulk-text?grp_id=${s.g5a.id}`);
    expect(bulk.text).not.toMatch(LIVE);
    // No message row (any column) and no audit row holds a link.
    for (const table of ['message', 'audit', 'parent_link', 'parent_link_access']) {
      const all = await s.db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM ${table}`));
      const text = JSON.stringify(all);
      for (const t of tokens) expect(text, table).not.toContain(t);
      expect(text, table).not.toMatch(LIVE);
    }
  });

  it('landline / non-mobile numbers route to call at enqueue and at open', async () => {
    const s = await setup();
    // The Ahmed guardian consents, but has only a landline: a call row at enqueue.
    await s.db.run(
      sql`UPDATE guardian SET consent_whatsapp = 1, phone = '924235761234', whatsapp = NULL
          WHERE family_id = ${s.bilal.family_id}`,
    );
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'A'],
    ]);
    const items = (await queue(s)).items;
    const ahmed = items.find((m) => m.family_id === s.bilal.family_id);
    const khan = items.find((m) => m.family_id === s.ali.family_id);
    expect(ahmed).toMatchObject({ channel: 'call', number: '924235761234', wa_number: null });
    expect(khan).toMatchObject({ channel: 'wa_manual', number: '923001234567' });
    // A WhatsApp row whose number became a landline before it was opened: a call row at open.
    await s.db.run(
      sql`UPDATE guardian SET phone = '924235761234', whatsapp = NULL WHERE id = ${s.khanGuardian}`,
    );
    const o = await s.api<MessageOpenDto>('POST', `/api/messages/${khan?.id}/open`);
    expect(o.body).toMatchObject({ channel: 'call', wa_url: null, tel_url: 'tel:+924235761234' });
    const [row] = await s.db.all<{ channel: string }>(
      sql`SELECT channel FROM message WHERE id = ${khan?.id}`,
    );
    expect(row?.channel).toBe('call');
  });

  it('a WhatsApp row cannot be marked sent before it was opened; a call row can', async () => {
    const s = await setup();
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'A'],
    ]);
    const items = (await queue(s)).items;
    const wa = items.find((m) => m.channel === 'wa_manual');
    const call = items.find((m) => m.channel === 'call');
    const early = await s.api<Err>('POST', `/api/messages/${wa?.id}/sent`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('not_opened');
    await s.api('POST', `/api/messages/${wa?.id}/open`);
    expect((await s.api('POST', `/api/messages/${wa?.id}/sent`)).status).toBe(200);
    expect((await s.api('POST', `/api/messages/${call?.id}/sent`)).status).toBe(200);
  });

  it('English absence text says "were" for several children, "was" for one', async () => {
    const s = await setup();
    await s.db.run(sql`UPDATE guardian SET lang = 'en' WHERE id = ${s.khanGuardian}`);
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'P'],
    ]);
    await register(s, s.g5b.id, [[s.zain.student_id, 'A']]);
    const [row] = (await queue(s)).items;
    const o = await s.api<MessageOpenDto>('POST', `/api/messages/${row?.id}/open`);
    expect(o.body.text).toContain('Ali Khan and Zain Khan were absent from school today');
  });

  it('a guardian with a parent link cannot be deleted (409 has_parent_link)', async () => {
    const s = await setup();
    // A second guardian, so "last guardian" is not what refuses.
    const g2 = await s.api<{ id: string }>('POST', '/api/guardians', {
      family_id: s.ali.family_id,
      name: 'Amna Khan',
      phone: '0300-7654321',
    });
    expect(g2.status, g2.text).toBe(201);
    const id = g2.body.id;
    await s.api('POST', `/api/guardians/${id}/parent-link`, {});
    await s.api('POST', `/api/guardians/${id}/parent-link/revoke`);
    const del = await s.api<Err>('DELETE', `/api/guardians/${id}`);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('has_parent_link');
    expect(del.body.error.message).toMatch(/[Rr]evoke/);
  });

  it('rotate-all (owner only) revokes every live link; a rotated secret makes /open mint a new one', async () => {
    const s = await setup();
    await register(s, s.g5a.id, [
      [s.ali.student_id, 'A'],
      [s.bilal.student_id, 'P'],
    ]);
    const [row] = (await queue(s)).items;
    const first = await s.api<MessageOpenDto>('POST', `/api/messages/${row?.id}/open`);
    const t1 = lastLine(first.body.text).split('/p#')[1] ?? '';
    // Same app, new PARENT_LINK_SECRET: the old link is not recomputable, so /open replaces it.
    const rotated = testApp({ db: s.db, env: { PARENT_LINK_SECRET: 'x'.repeat(40) } });
    const owner2 = await signedInAs(s.db, ['owner']);
    const api2 = client(rotated.request, owner2.cookie);
    const second = await api2<MessageOpenDto>('POST', `/api/messages/${row?.id}/open`);
    const t2 = lastLine(second.body.text).split('/p#')[1] ?? '';
    expect(t2).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t2).not.toBe(t1);
    expect((await s.anon('GET', '/api/p', undefined, P(t1))).status).toBe(404);
    expect((await s.acct('POST', '/api/parent-links/rotate-all')).status).toBe(403);
    const all = await api2<{ revoked: number }>('POST', '/api/parent-links/rotate-all');
    expect(all.status, all.text).toBe(200);
    expect(all.body.revoked).toBe(1);
    expect((await rotated.request('/api/p', { headers: { 'x-parent-token': t2 } })).status).toBe(
      404,
    );
    const [n] = await s.db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM parent_link WHERE revoked_at IS NULL`,
    );
    expect(n?.n).toBe(0);
  });

  it('parent links answer 503 misconfigured without PARENT_LINK_SECRET', async () => {
    const s = await setup();
    const bare = testApp({ db: s.db, env: { PARENT_LINK_SECRET: '' } });
    const owner2 = await signedInAs(s.db, ['owner']);
    const r = await client(bare.request, owner2.cookie)<Err>(
      'POST',
      `/api/guardians/${s.khanGuardian}/parent-link`,
      {},
    );
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('misconfigured');
  });
});

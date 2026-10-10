import { staff } from '@maktab/db';
import {
  type AdmissionResult,
  type AttendanceReport,
  type AttendanceSubmission,
  type AttendanceSyncResult,
  type DashboardTodayResponse,
  type GroupDto,
  type MessageDto,
  newId,
  type ProgrammeDto,
  type RegisterResponse,
  type StudentAttendanceResponse,
  type TodayResponse,
} from '@maktab/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { todayPk } from '../src/lib/http';
import { signedInAs, testApp } from './helpers';

type Res<T> = { status: number; body: T; text: string };
type Err = { error: { code: string; message: string } };

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
      // CSV
    }
    return { status: res.status, body: parsed as T, text };
  };
}

const today = todayPk();
const daysAgo = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 8, minutes)).toISOString();

/**
 * School with two groups, a teacher who is class teacher of 5-A only, and students:
 * Ali + Sara (siblings, Khan family, consenting guardian) in 5-A, Bilal (Ahmed family, no consent)
 * in 5-A, and Zain (Khan family too) in 5-B. Weekly off is cleared so "today" is always a school day.
 */
async function setup() {
  const t = testApp();
  const owner = await signedInAs(t.db, ['owner']);
  const api = client(t.request, owner.cookie);
  expect((await api('PUT', '/api/school', { name: 'Al-Noor', mode: 'school' })).status).toBe(200);
  expect(
    (await api('PUT', '/api/school/attendance', { attendance_mode: 'daily', weekly_off: [] }))
      .status,
  ).toBe(200);
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
  expect((await api('PATCH', `/api/groups/${g5a.id}`, { class_teacher_id: staffId })).status).toBe(
    200,
  );
  const admin = await signedInAs(t.db, ['admin']);

  const admit = async (body: Record<string, unknown>) => {
    const r = await api<AdmissionResult>('POST', '/api/admissions', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const start = daysAgo(40);
  const ali = await admit({
    family: { name: 'Khan' },
    guardians: [
      { name: 'Imran', relation: 'father', phone: '0300-1234567', consent_whatsapp: true },
    ],
    student: { name: 'Ali', admission_date: start },
    enrolment: { grp_id: g5a.id },
  });
  const sara = await admit({
    family_id: ali.family_id,
    student: { name: 'Sara', admission_date: start },
    enrolment: { grp_id: g5a.id },
  });
  const bilal = await admit({
    family: { name: 'Ahmed' },
    guardians: [{ name: 'Tariq', phone: '0301-7654321', consent_whatsapp: false }],
    student: { name: 'Bilal', admission_date: start },
    enrolment: { grp_id: g5a.id },
  });
  const zain = await admit({
    family_id: ali.family_id,
    student: { name: 'Zain', admission_date: start },
    enrolment: { grp_id: g5b.id },
  });
  const tApi = client(t.request, teacher.cookie);
  const aApi = client(t.request, admin.cookie);
  return { ...t, api, tApi, aApi, g5a, g5b, ali, sara, bilal, zain, start };
}

type S = Awaited<ReturnType<typeof setup>>;

const submission = (
  s: S,
  over: Partial<AttendanceSubmission> & { absent?: string[] } = {},
): AttendanceSubmission => {
  const { absent = [], ...rest } = over;
  return {
    client_id: newId(),
    grp_id: s.g5a.id,
    date: today,
    taken_at: at(0),
    marks: [s.ali, s.sara, s.bilal].map((st) => ({
      student_id: st.student_id,
      status: absent.includes(st.student_id) ? 'A' : 'P',
    })),
    ...rest,
  };
};

async function sync(api: S['api'], subs: unknown[]) {
  const r = await api<{ results: AttendanceSyncResult[] }>('POST', '/api/attendance/sync', subs);
  expect(r.status, r.text).toBe(200);
  return r.body.results;
}

const queuedAbsence = async (s: S) =>
  (
    await s.db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM message WHERE template_key = 'absence' AND status = 'queued'`,
    )
  )[0]?.n;

describe('POST /api/attendance/sync', () => {
  it('applies, then answers a replay as duplicate without writing again', async () => {
    const s = await setup();
    const sub = submission(s, { absent: [s.bilal.student_id] });
    const [first] = await sync(s.tApi, [sub]);
    expect(first).toMatchObject({ client_id: sub.client_id, status: 'applied' });
    const [again] = await sync(s.tApi, [sub]);
    expect(again).toEqual({
      client_id: sub.client_id,
      status: 'duplicate',
      register_id: first?.register_id,
    });
    const [regs] = await s.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM att_register`);
    expect(regs?.n).toBe(1);
    const [marks] = await s.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM att_mark`);
    expect(marks?.n).toBe(3);
    const audits = await s.db.all<{ action: string }>(
      sql`SELECT action FROM audit WHERE entity = 'att_register'`,
    );
    expect(audits).toEqual([{ action: 'sync' }]);
  });

  it('a later taken_at replaces; an older one arriving later is stale and changes nothing', async () => {
    const s = await setup();
    const first = submission(s, { taken_at: at(10) });
    const later = submission(s, { taken_at: at(20), absent: [s.ali.student_id] });
    const older = submission(s, { taken_at: at(15), absent: [s.sara.student_id] });
    const [r1, r2, r3] = await sync(s.tApi, [first, later, older]);
    expect(r1?.status).toBe('applied');
    expect(r2?.status).toBe('replaced');
    expect(r3?.status).toBe('stale');
    const reg = await s.tApi<RegisterResponse>(
      'GET',
      `/api/attendance/register?grp_id=${s.g5a.id}&date=${today}`,
    );
    expect(reg.body.current?.register_id).toBe(r2?.register_id);
    expect(reg.body.rows.find((r) => r.student_id === s.ali.student_id)?.status).toBe('A');
    expect(reg.body.rows.find((r) => r.student_id === s.sara.student_id)?.status).toBe('P');
    // History keeps all three registers.
    expect(reg.body.history.map((h) => h.register_id).sort()).toEqual(
      [r1, r2, r3].map((r) => r?.register_id).sort(),
    );
  });

  it('compares taken_at by instant, whatever the precision the phone sent', async () => {
    const s = await setup();
    const [a] = await sync(s.tApi, [submission(s, { taken_at: '2026-01-01T08:00:00.500Z' })]);
    const [b] = await sync(s.tApi, [submission(s, { taken_at: '2026-01-01T08:00:00Z' })]);
    expect(a?.status).toBe('applied');
    expect(b?.status).toBe('stale');
  });

  it('rejects with a clear code: holiday, weekly off, future, not enrolled, before enrolment, 61 marks', async () => {
    const s = await setup();
    const hol = daysAgo(1);
    expect(
      (await s.api('POST', '/api/holidays', { date: hol, name_en: 'Eid', name_ur: 'عید' })).status,
    ).toBe(201);
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const stranger = newId();
    const results = await sync(s.tApi, [
      submission(s, { date: hol }),
      submission(s, { date: tomorrow.toISOString().slice(0, 10) }),
      submission(s, {
        marks: [{ student_id: s.zain.student_id, status: 'P' }],
      }),
    ]);
    expect(results.map((r) => [r.status, r.error])).toEqual([
      ['rejected', 'holiday'],
      ['rejected', 'future_date'],
      ['rejected', 'not_enrolled'],
    ]);
    expect(results[0]?.message).toMatch(/Eid/);
    const more = await sync(s.tApi, [
      submission(s, { date: daysAgo(41) }),
      submission(s, {
        marks: Array.from({ length: 61 }, () => ({ student_id: newId(), status: 'P' as const })),
      }),
      { client_id: stranger, grp_id: 'nope' },
    ]);
    expect(more.map((r) => [r.status, r.error])).toEqual([
      ['rejected', 'before_enrolment'],
      ['rejected', 'invalid'],
      ['rejected', 'invalid'],
    ]);
    expect(more[2]?.client_id).toBe(stranger);
    // Weekly off: make today's weekday a day off.
    const wd = new Date(`${today}T00:00:00Z`).getUTCDay();
    await s.api('PUT', '/api/school/attendance', { attendance_mode: 'daily', weekly_off: [wd] });
    const [off] = await sync(s.tApi, [submission(s)]);
    expect([off?.status, off?.error]).toEqual(['rejected', 'weekly_off']);
    const [regs] = await s.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM att_register`);
    expect(regs?.n).toBe(0);
  });

  it('refuses more than 3 registers per request (budget)', async () => {
    const s = await setup();
    const r = await s.tApi<Err>('POST', '/api/attendance/sync', [
      submission(s),
      submission(s),
      submission(s),
      submission(s),
    ]);
    expect(r.status).toBe(400);
  });

  it('a teacher cannot sync for a group that is not theirs', async () => {
    const s = await setup();
    const [r] = await sync(s.tApi, [
      submission(s, { grp_id: s.g5b.id, marks: [{ student_id: s.zain.student_id, status: 'A' }] }),
    ]);
    expect([r?.status, r?.error]).toEqual(['rejected', 'forbidden']);
    // The office can.
    const [o] = await sync(s.aApi, [
      submission(s, { grp_id: s.g5b.id, marks: [{ student_id: s.zain.student_id, status: 'A' }] }),
    ]);
    expect(o?.status).toBe('applied');
    // And the teacher cannot read that register either.
    const reg = await s.tApi('GET', `/api/attendance/register?grp_id=${s.g5b.id}&date=${today}`);
    expect(reg.status).toBe(404);
  });

  it('per-subject mode needs a subject of that group; daily mode refuses one', async () => {
    const s = await setup();
    const subs = await s.db.all<{ id: string }>(sql`SELECT id FROM subject LIMIT 1`);
    let subjId = subs[0]?.id;
    if (!subjId) {
      await s.api('POST', '/api/subjects/seed-pk');
      subjId = (await s.db.all<{ id: string }>(sql`SELECT id FROM subject LIMIT 1`))[0]?.id;
    }
    await s.api('PUT', `/api/groups/${s.g5a.id}/subjects`, {
      subjects: [{ subject_id: subjId }],
    });
    const gsId = (
      await s.db.all<{ id: string }>(sql`SELECT id FROM grp_subject WHERE grp_id = ${s.g5a.id}`)
    )[0]?.id;
    const [daily] = await sync(s.tApi, [submission(s, { grp_subject_id: gsId })]);
    expect(daily?.error).toBe('wrong_mode');
    await s.api('PUT', '/api/school/attendance', {
      attendance_mode: 'per_subject',
      weekly_off: [],
    });
    const [whole, perSubject] = await sync(s.tApi, [
      submission(s),
      submission(s, { grp_subject_id: gsId }),
    ]);
    expect(whole?.error).toBe('wrong_mode');
    expect(perSubject?.status).toBe('applied');
    const todayList = await s.tApi<TodayResponse>('GET', '/api/attendance/today');
    expect(todayList.body.items.map((i) => [i.grp_subject_id, i.status])).toEqual([
      [gsId, 'taken'],
    ]);
  });
});

describe('absence messages', () => {
  it('queues one message per family per day, across registers, and respects consent', async () => {
    const s = await setup();
    // Ali + Sara (same family, consent) and Bilal (no consent) absent.
    const [r1] = await sync(s.tApi, [
      submission(s, {
        taken_at: at(1),
        absent: [s.ali.student_id, s.sara.student_id, s.bilal.student_id],
      }),
    ]);
    expect(r1).toMatchObject({ status: 'applied', queued_messages: 1 });
    const msgs = await s.api<{ items: MessageDto[]; total: number }>(
      'GET',
      '/api/messages?status=queued&template_key=absence',
    );
    expect(msgs.body.total).toBe(1);
    const m = msgs.body.items[0];
    expect(m).toMatchObject({
      family_id: s.ali.family_id,
      channel: 'wa_manual',
      status: 'queued',
      guardian_name: 'Imran',
      guardian_phone: '923001234567',
    });
    expect([...((m?.payload?.student_names ?? []) as string[])].sort()).toEqual(['Ali', 'Sara']);
    expect(m?.payload).toMatchObject({ date: today, grp_id: s.g5a.id, grp_name: 'Class 5 A' });

    // A replacement register, and the sibling's other group, add nothing for the same day.
    const [r2] = await sync(s.tApi, [
      submission(s, { taken_at: at(2), absent: [s.ali.student_id] }),
    ]);
    expect(r2).toMatchObject({ status: 'replaced', queued_messages: 0 });
    const [r3] = await sync(s.aApi, [
      submission(s, { grp_id: s.g5b.id, marks: [{ student_id: s.zain.student_id, status: 'A' }] }),
    ]);
    expect(r3).toMatchObject({ status: 'applied', queued_messages: 0 });
    expect(await queuedAbsence(s)).toBe(1);

    // Past dates never queue (only today's register alerts parents).
    const [past] = await sync(s.tApi, [
      submission(s, { date: daysAgo(2), absent: [s.ali.student_id] }),
    ]);
    expect(past).toMatchObject({ status: 'applied', queued_messages: 0 });
    // Stale registers do not queue either.
    expect(await queuedAbsence(s)).toBe(1);
  });

  it('a teacher sees only messages about their own groups', async () => {
    const s = await setup();
    await sync(s.aApi, [
      submission(s, { grp_id: s.g5b.id, marks: [{ student_id: s.zain.student_id, status: 'A' }] }),
    ]);
    const mine = await s.tApi<{ total: number }>('GET', '/api/messages?status=queued');
    expect(mine.body.total).toBe(0);
    const office = await s.api<{ total: number }>('GET', '/api/messages?status=queued');
    expect(office.body.total).toBe(1);
  });
});

describe('POST /api/attendance/correct', () => {
  it('needs attendance.correct and a reason, then becomes current with the reason in history', async () => {
    const s = await setup();
    // A phone with a fast clock: its taken_at is far in the future.
    const [orig] = await sync(s.tApi, [
      submission(s, { taken_at: '2099-01-01T00:00:00.000Z', absent: [s.ali.student_id] }),
    ]);
    expect(orig?.status).toBe('applied');
    const body = {
      client_id: newId(),
      grp_id: s.g5a.id,
      date: today,
      marks: [s.ali, s.sara, s.bilal].map((st) => ({ student_id: st.student_id, status: 'P' })),
    };
    expect(
      (await s.tApi('POST', '/api/attendance/correct', { ...body, reason: 'x late' })).status,
    ).toBe(403);
    const noReason = await s.aApi<Err>('POST', '/api/attendance/correct', body);
    expect(noReason.status).toBe(400);
    const ok = await s.aApi<AttendanceSyncResult>('POST', '/api/attendance/correct', {
      ...body,
      reason: 'Ali came late; marked present',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('replaced');
    const again = await s.aApi<AttendanceSyncResult>('POST', '/api/attendance/correct', {
      ...body,
      reason: 'Ali came late; marked present',
    });
    expect(again.body.status).toBe('duplicate');
    const reg = await s.aApi<RegisterResponse>(
      'GET',
      `/api/attendance/register?grp_id=${s.g5a.id}&date=${today}`,
    );
    expect(reg.body.current?.register_id).toBe(ok.body.register_id);
    expect(reg.body.rows.every((r) => r.status === 'P')).toBe(true);
    const corr = reg.body.history.find((h) => h.kind === 'correct');
    expect(corr).toMatchObject({ reason: 'Ali came late; marked present', is_current: true });
    // A holiday cannot be corrected into existence.
    await s.api('POST', '/api/holidays', { date: daysAgo(3), name_en: 'Strike' });
    const hol = await s.aApi<Err>('POST', '/api/attendance/correct', {
      ...body,
      client_id: newId(),
      date: daysAgo(3),
      reason: 'test',
    });
    expect([hol.status, hol.body.error.code]).toEqual([400, 'holiday']);
  });
});

describe('reads', () => {
  it('today lists my groups with taken / not taken and counts', async () => {
    const s = await setup();
    const before = await s.tApi<TodayResponse>('GET', '/api/attendance/today');
    expect(before.body.items.map((i) => [i.grp_id, i.status])).toEqual([[s.g5a.id, 'not_taken']]);
    await sync(s.tApi, [submission(s, { absent: [s.ali.student_id] })]);
    const after = await s.tApi<TodayResponse>('GET', '/api/attendance/today');
    expect(after.body.items[0]).toMatchObject({
      status: 'taken',
      counts: { P: 2, A: 1, L: 0, E: 0 },
      student_count: 3,
    });
    expect(after.body.items[0]?.taken_by_name).toBeTruthy();
    const office = await s.api<TodayResponse>('GET', '/api/attendance/today');
    expect(office.body.items.map((i) => i.status).sort()).toEqual(['not_taken', 'taken']);
  });

  it('dashboard: registers not taken, absentees with guardian phone, queued count', async () => {
    const s = await setup();
    await sync(s.tApi, [submission(s, { absent: [s.ali.student_id, s.bilal.student_id] })]);
    const d = await s.api<DashboardTodayResponse>('GET', '/api/dashboard/today');
    expect(d.status).toBe(200);
    expect(d.body.registers).toMatchObject({ total: 2, taken: 1 });
    expect(d.body.registers.not_taken.map((i) => i.grp_id)).toEqual([s.g5b.id]);
    expect(d.body.absentees.map((a) => [a.name, a.guardian_phone]).sort()).toEqual([
      ['Ali', '923001234567'],
      ['Bilal', '923017654321'],
    ]);
    expect(d.body.queued_absence_messages).toBe(1);
    const acct = await signedInAs(s.db, ['accountant']);
    expect((await client(s.request, acct.cookie)('GET', '/api/dashboard/today')).status).toBe(403);
  });

  it('student attendance: per-day statuses and a derived %', async () => {
    const s = await setup();
    await sync(s.tApi, [
      submission(s, { date: daysAgo(3) }),
      submission(s, { date: daysAgo(2), absent: [s.ali.student_id] }),
      submission(s, {
        date: daysAgo(1),
        marks: [{ student_id: s.ali.student_id, status: 'L' }],
      }),
    ]);
    const r = await s.tApi<StudentAttendanceResponse>(
      'GET',
      `/api/attendance/student/${s.ali.student_id}?from=${daysAgo(10)}&to=${today}`,
    );
    expect(r.body.days.map((d) => d.status)).toEqual(['P', 'A', 'L']);
    expect(r.body.counts).toEqual({ P: 1, A: 1, L: 1, E: 0 });
    expect(r.body.pct).toBe(66.7);
    // Out of the teacher's scope → 404.
    expect((await s.tApi('GET', `/api/attendance/student/${s.zain.student_id}`)).status).toBe(404);
  });

  it('monthly report: matrix with totals, and a formula-safe CSV', async () => {
    const s = await setup();
    await s.db.run(
      sql`UPDATE student SET name = '=HYPERLINK("http://x","y")' WHERE id = ${s.bilal.student_id}`,
    );
    const d = daysAgo(1);
    await sync(s.tApi, [submission(s, { date: d, absent: [s.bilal.student_id] })]);
    const month = d.slice(0, 7);
    const r = await s.tApi<AttendanceReport>(
      'GET',
      `/api/attendance/report?grp_id=${s.g5a.id}&month=${month}`,
    );
    expect(r.status).toBe(200);
    const dayIdx = Number(d.slice(8)) - 1;
    expect(r.body.days[dayIdx]).toMatchObject({ date: d, taken: true });
    const bilal = r.body.rows.find((x) => x.student_id === s.bilal.student_id);
    expect(bilal?.cells[dayIdx]).toBe('A');
    expect(bilal?.counts.A).toBe(1);
    expect(bilal?.cells.filter((c) => c === '–').length).toBe(r.body.days.length - 1);
    const csv = await s.tApi(
      'GET',
      `/api/attendance/report?grp_id=${s.g5a.id}&month=${month}&format=csv`,
    );
    expect(csv.status).toBe(200);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[1]?.startsWith('Roll,Name,01,02')).toBe(true);
    const bilalLine = lines.find((l) => l.includes('HYPERLINK')) ?? '';
    expect(bilalLine).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(bilalLine.split(',').at(-4)).toBe('1'); // columns end P,A,L,E,%
    const aliLine = lines.find((l) => l.includes(',Ali,')) ?? '';
    expect(aliLine.split(',')[2 + dayIdx]).toBe('P');
  });

  it('holidays CRUD and the weekly-off setting', async () => {
    const s = await setup();
    expect(
      (await s.api('POST', '/api/holidays', { date: '2026-08-14', name_en: 'Independence' }))
        .status,
    ).toBe(201);
    expect(
      (await s.api('POST', '/api/holidays', { date: '2026-08-14', name_en: 'Azadi' })).status,
    ).toBe(200);
    const list = await s.tApi<{ items: { date: string; name_en: string }[] }>(
      'GET',
      '/api/holidays',
    );
    expect(list.body.items).toEqual([{ date: '2026-08-14', name_en: 'Azadi', name_ur: null }]);
    expect(
      (await s.tApi('POST', '/api/holidays', { date: '2026-08-15', name_en: 'x' })).status,
    ).toBe(403);
    expect((await s.api('DELETE', '/api/holidays/2026-08-14')).status).toBe(200);
    expect((await s.api('DELETE', '/api/holidays/2026-08-14')).status).toBe(404);
    const w = await s.api<{ school: { weekly_off: number[]; attendance_mode: string } }>(
      'PUT',
      '/api/school/attendance',
      { attendance_mode: 'daily', weekly_off: [0, 5, 5] },
    );
    expect(w.body.school).toMatchObject({ weekly_off: [0, 5], attendance_mode: 'daily' });
  });
});

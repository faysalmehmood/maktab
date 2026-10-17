import { staff } from '@maktab/db';
import {
  type AdmissionResult,
  type AttendanceReport,
  type AttendanceSyncResult,
  type GroupDto,
  newId,
  type ProgrammeDto,
} from '@maktab/shared';
import { describe, expect, it } from 'vitest';
import { todayPk } from '../src/lib/http';
import { signedInAs, testApp } from './helpers';

/*
 * Owner feedback of 2026-10-17: the monthly register's non-school days, working days and class
 * teacher; CSV codes P/A/Lt/Lv with blank cells for no mark; and "Your role" in the group list
 * (`my_role`), which must never show more than the row itself does.
 */

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

/**
 * Class 5 A (class teacher Ms Sana, who also teaches English there), 5 B (Ms Sana teaches Maths),
 * 5 C (nothing to do with her; Mr Bilal teaches Maths). Ali and Sara in 5 A.
 */
async function setup() {
  const t = testApp();
  const owner = await signedInAs(t.db, ['owner']);
  const api = client(t.request, owner.cookie);
  expect((await api('PUT', '/api/school', { name: 'Al-Noor', mode: 'school' })).status).toBe(200);
  await api('POST', '/api/sessions', {
    name: '2026-27',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  const progs = await api<{ items: ProgrammeDto[] }>('POST', '/api/programmes/seed-pk');
  const c5 = progs.body.items.find((p) => p.name === 'Class 5')?.id;
  const mk = async (name: string) =>
    (await api<GroupDto>('POST', '/api/groups', { programme_id: c5, name })).body;
  const [g5a, g5b, g5c] = [await mk('A'), await mk('B'), await mk('C')];
  const subj = async (name: string) =>
    (await api<{ id: string }>('POST', '/api/subjects', { name })).body.id;
  const [maths, english] = [await subj('Maths'), await subj('English')];

  const teacher = await signedInAs(t.db, ['teacher']);
  const sana = newId();
  await t.db.insert(staff).values({ id: sana, userId: teacher.userId, name: 'Ms Sana' });
  const other = await signedInAs(t.db, ['teacher']);
  const bilal = newId();
  await t.db.insert(staff).values({ id: bilal, userId: other.userId, name: 'Mr Bilal' });
  const put = async (id: string, subjects: { subject_id: string; teacher_id: string }[]) =>
    expect((await api('PUT', `/api/groups/${id}/subjects`, { subjects })).status).toBe(200);
  expect((await api('PATCH', `/api/groups/${g5a.id}`, { class_teacher_id: sana })).status).toBe(
    200,
  );
  await put(g5a.id, [
    { subject_id: english, teacher_id: sana },
    { subject_id: maths, teacher_id: bilal },
  ]);
  await put(g5b.id, [{ subject_id: maths, teacher_id: sana }]);
  await put(g5c.id, [{ subject_id: maths, teacher_id: bilal }]);

  const admit = async (name: string) => {
    const r = await api<AdmissionResult>('POST', '/api/admissions', {
      family: { name: `${name} family` },
      guardians: [{ name: `${name}'s father`, phone: '0300-1234567' }],
      student: { name, admission_date: daysAgo(40) },
      enrolment: { grp_id: g5a.id },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const ali = await admit('Ali');
  const sara = await admit('Sara');
  return {
    ...t,
    api,
    tApi: client(t.request, teacher.cookie),
    bApi: client(t.request, other.cookie),
    g5a,
    g5b,
    g5c,
    sana,
    bilal,
    ali,
    sara,
  };
}

type Role = GroupDto['my_role'];
const roles = (items: GroupDto[]) =>
  Object.fromEntries(items.map((g) => [g.name, g.my_role])) as Record<string, Role>;

describe('GET /api/groups: my_role', () => {
  it('class teacher and subject teacher; only the groups the teacher already sees', async () => {
    const s = await setup();
    const r = await s.tApi<{ items: GroupDto[] }>('GET', '/api/groups');
    expect(r.status).toBe(200);
    expect(roles(r.body.items)).toEqual({
      A: { class_teacher: true, subjects: ['English'] },
      B: { class_teacher: false, subjects: ['Maths'] },
    });
  });

  it('a subject-only teacher: subjects, never class teacher', async () => {
    const s = await setup();
    const r = await s.bApi<{ items: GroupDto[] }>('GET', '/api/groups');
    expect(roles(r.body.items)).toEqual({
      A: { class_teacher: false, subjects: ['Maths'] },
      C: { class_teacher: false, subjects: ['Maths'] },
    });
  });

  it('an accountant with a staff row: null on every row (not a teacher)', async () => {
    const s = await setup();
    const acct = await signedInAs(s.db, ['accountant']);
    await s.db.insert(staff).values({ id: newId(), userId: acct.userId, name: 'Mr Accounts' });
    const r = await client(s.request, acct.cookie)<{ items: GroupDto[] }>('GET', '/api/groups');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(3);
    expect(r.body.items.every((g) => g.my_role === null)).toBe(true);
  });

  it('a user with no staff row (owner, or a teacher not yet linked): null', async () => {
    const s = await setup();
    const owner = await s.api<{ items: GroupDto[] }>('GET', '/api/groups');
    expect(owner.body.items.length).toBe(3);
    expect(owner.body.items.every((g) => g.my_role === null)).toBe(true);
    const unlinked = await signedInAs(s.db, ['owner', 'teacher']);
    const r = await client(s.request, unlinked.cookie)<{ items: GroupDto[] }>('GET', '/api/groups');
    expect(r.body.items.every((g) => g.my_role === null)).toBe(true);
  });

  it('teacher + accountant sees every group; my_role only says what the row already shows', async () => {
    const s = await setup();
    const both = await signedInAs(s.db, ['teacher', 'accountant']);
    const me = newId();
    await s.db.insert(staff).values({ id: me, userId: both.userId, name: 'Ms Both' });
    await s.api('PATCH', `/api/groups/${s.g5c.id}`, { class_teacher_id: me });
    const r = await client(s.request, both.cookie)<{ items: GroupDto[] }>('GET', '/api/groups');
    expect(roles(r.body.items)).toEqual({
      A: { class_teacher: false, subjects: [] },
      B: { class_teacher: false, subjects: [] },
      C: { class_teacher: true, subjects: [] },
    });
    for (const g of r.body.items) {
      expect(g.my_role?.class_teacher).toBe(g.class_teacher_id === me);
      expect(g.my_role?.subjects).toEqual(
        g.subjects.filter((x) => x.teacher_id === me).map((x) => x.subject_name),
      );
    }
  });
});

describe('GET /api/attendance/report: register print data and CSV', () => {
  it('non_school_days = holidays + weekly off; working days; class teacher name', async () => {
    const s = await setup();
    expect(
      (await s.api('PUT', '/api/school/attendance', { attendance_mode: 'daily', weekly_off: [0] }))
        .status,
    ).toBe(200);
    expect(
      (await s.api('POST', '/api/holidays', { date: '2026-02-05', name_en: 'Kashmir Day' })).status,
    ).toBe(201);
    const r = await s.tApi<AttendanceReport>(
      'GET',
      `/api/attendance/report?grp_id=${s.g5a.id}&month=2026-02`,
    );
    expect(r.status).toBe(200);
    expect(r.body.class_teacher_name).toBe('Ms Sana');
    // Feb 2026: Sundays 1, 8, 15, 22 and the 5th (holiday).
    expect(r.body.non_school_days).toEqual([
      '2026-02-01',
      '2026-02-05',
      '2026-02-08',
      '2026-02-15',
      '2026-02-22',
    ]);
    expect(r.body.working_days).toBe(28 - 5);
    // A month still to come has no working days yet.
    const future = await s.tApi<AttendanceReport>(
      'GET',
      `/api/attendance/report?grp_id=${s.g5a.id}&month=2099-01`,
    );
    expect(future.body.working_days).toBe(0);
    // The current month counts only days up to today.
    const now = await s.tApi<AttendanceReport>(
      'GET',
      `/api/attendance/report?grp_id=${s.g5a.id}&month=${today.slice(0, 7)}`,
    );
    const off = new Set(now.body.non_school_days);
    expect(now.body.working_days).toBe(
      now.body.days.filter((d) => d.date <= today && !off.has(d.date)).length,
    );
  });

  it('CSV: codes P, A, Lt, Lv and a blank cell where there is no mark', async () => {
    const s = await setup();
    await s.api('PUT', '/api/school/attendance', { attendance_mode: 'daily', weekly_off: [] });
    const d = daysAgo(1);
    const sync = await s.tApi<{ results: AttendanceSyncResult[] }>('POST', '/api/attendance/sync', [
      {
        client_id: newId(),
        grp_id: s.g5a.id,
        date: d,
        taken_at: new Date().toISOString(),
        marks: [
          { student_id: s.ali.student_id, status: 'L' },
          { student_id: s.sara.student_id, status: 'E' },
        ],
      },
    ]);
    expect(sync.body.results[0]?.status, sync.text).toBe('applied');
    const month = d.slice(0, 7);
    const json = await s.tApi<AttendanceReport>(
      'GET',
      `/api/attendance/report?grp_id=${s.g5a.id}&month=${month}`,
    );
    const idx = Number(d.slice(8)) - 1;
    // JSON keeps the stored enum; only paper and CSV say Lt/Lv.
    expect(json.body.rows.map((r) => r.cells[idx])).toEqual(['L', 'E']);
    const csv = await s.tApi(
      'GET',
      `/api/attendance/report?grp_id=${s.g5a.id}&month=${month}&format=csv`,
    );
    expect(csv.status).toBe(200);
    expect(csv.text).not.toContain('–');
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[1]?.endsWith(',P,A,Lt,Lv,%')).toBe(true);
    const cellsOf = (name: string) => {
      const cols = (lines.find((l) => l.includes(`,${name},`)) ?? '').split(',');
      return cols.slice(2, 2 + json.body.days.length);
    };
    const ali = cellsOf('Ali');
    expect(ali[idx]).toBe('Lt');
    expect(ali.filter((c) => c === '').length).toBe(json.body.days.length - 1);
    expect(cellsOf('Sara')[idx]).toBe('Lv');
    expect(csv.text.split('\r\n')[0]).toContain('Class 5');
  });
});

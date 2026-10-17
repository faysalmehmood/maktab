import type {
  GroupDto,
  ProgrammeDto,
  SessionDto,
  StaffRowDto,
  SubjectDto,
  TeachersDto,
} from '@maktab/shared';
import { describe, expect, it } from 'vitest';
import { signedInAs, testApp } from './helpers';

// GET /api/teachers (Teachers page, 2026-10-17): one row per teacher with their class-teacher
// groups and subjects in a session, plus the gaps (no class teacher, subject without a teacher,
// class teacher of two groups). Owner/admin only (settings.manage).

async function fixture() {
  const t = testApp();
  const owner = await signedInAs(t.db, ['owner']);
  const call = async <T>(method: string, path: string, body?: unknown, cookie = owner.cookie) => {
    const res = await t.request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text ? JSON.parse(text) : null) as T };
  };
  const ok = async <T>(method: string, path: string, body?: unknown) => {
    const r = await call<T>(method, path, body);
    expect(r.status, `${method} ${path}: ${r.text}`).toBeLessThan(300);
    return r.body;
  };
  const cur = await ok<SessionDto>('POST', '/api/sessions', {
    name: '2026-27',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  const old = await ok<SessionDto>('POST', '/api/sessions', {
    name: '2025-26',
    start_date: '2025-04-01',
    end_date: '2026-03-31',
  });
  const progs = (await ok<{ items: ProgrammeDto[] }>('POST', '/api/programmes/seed-pk')).items;
  const prog = (n: number) => progs.find((p) => p.name === `Class ${n}`)?.id as string;
  const subject = async (name: string) =>
    (await ok<SubjectDto>('POST', '/api/subjects', { name })).id;
  const maths = await subject('Maths');
  const english = await subject('English');
  const urdu = await subject('Urdu');

  const staff = async (
    name: string,
    roles: ('teacher' | 'accountant')[] | null,
    status?: 'left',
  ) => {
    const u = roles ? await signedInAs(t.db, roles) : null;
    const row = await ok<StaffRowDto>('POST', '/api/staff', {
      name,
      ...(u ? { user_id: u.userId } : {}),
      ...(status ? { status } : {}),
    });
    return { id: row.staff_id as string, cookie: u?.cookie };
  };
  const amina = await staff('Amina', ['teacher']);
  const bilal = await staff('Bilal', ['teacher']);
  const idle = await staff('Idle Teacher', ['teacher']);
  const acct = await staff('Accounts Clerk', ['accountant']);
  const gone = await staff('Former Teacher', null, 'left');
  // A teacher with a staff profile but no login yet: listed, so the owner can give a first class.
  const fresh = await staff('New Teacher', null);

  const group = async (n: number, name: string, extra: Record<string, unknown> = {}) =>
    ok<GroupDto>('POST', '/api/groups', {
      programme_id: prog(n),
      name,
      session_id: cur.id,
      ...extra,
    });
  // Amina: class teacher of 5 A, and Maths in 6 A and 7 A. Bilal: class teacher of 6 A and 7 A.
  const g5 = await group(5, 'A', {
    class_teacher_id: amina.id,
    subjects: [{ subject_id: urdu, teacher_id: gone.id }],
  });
  const g6 = await group(6, 'A', {
    class_teacher_id: bilal.id,
    subjects: [
      { subject_id: maths, teacher_id: amina.id },
      { subject_id: english, teacher_id: null },
    ],
  });
  const g7 = await group(7, 'A', {
    class_teacher_id: bilal.id,
    subjects: [{ subject_id: maths, teacher_id: amina.id }],
  });
  const g8 = await group(8, 'A');
  // A closed group needs no teacher; an archived one is out of the page; last year's too.
  const g9 = await group(9, 'A', { status: 'closed', subjects: [{ subject_id: maths }] });
  const g10 = await group(10, 'A', { class_teacher_id: idle.id });
  await ok('POST', `/api/groups/${g10.id}/archive`);
  const gOld = await ok<GroupDto>('POST', '/api/groups', {
    programme_id: prog(5),
    name: 'B',
    session_id: old.id,
    class_teacher_id: idle.id,
  });
  return {
    ...t,
    owner,
    call,
    cur,
    old,
    amina,
    bilal,
    idle,
    acct,
    gone,
    fresh,
    g5,
    g6,
    g7,
    g8,
    g9,
    gOld,
  };
}

describe('GET /api/teachers', () => {
  it('lists each teacher with class-teacher groups, subjects and load for the current session', async () => {
    const f = await fixture();
    const r = await f.call<TeachersDto>('GET', '/api/teachers');
    expect(r.status, r.text).toBe(200);
    expect(r.body.session_id).toBe(f.cur.id);
    const names = r.body.items.map((i) => i.name);
    // By name; the accountant (office only, no work) is not listed, the no-login profile is.
    expect(names).toEqual(['Amina', 'Bilal', 'Former Teacher', 'Idle Teacher', 'New Teacher']);
    expect(r.body.items.find((i) => i.staff_id === f.fresh.id)).toMatchObject({
      roles: [],
      staff_status: 'active',
      load: { groups: 0, subjects: 0 },
    });
    const amina = r.body.items.find((i) => i.staff_id === f.amina.id);
    expect(amina).toMatchObject({
      roles: ['teacher'],
      staff_status: 'active',
      class_teacher_of: [{ grp_id: f.g5.id, name: 'Class 5 A' }],
      // Maths in two classes: 3 classes, 1 distinct subject.
      load: { groups: 3, subjects: 1 },
    });
    expect(amina?.subjects.map((s) => `${s.grp_name} ${s.subject_name}`).sort()).toEqual([
      'Class 6 A Maths',
      'Class 7 A Maths',
    ]);
    const six = f.g6.subjects.find((s) => s.subject_name === 'Maths');
    expect(amina?.subjects).toContainEqual({
      grp_id: f.g6.id,
      grp_name: 'Class 6 A',
      programme_name: 'Class 6',
      group_name: 'A',
      grp_subject_id: six?.id,
      subject_name: 'Maths',
    });
    // Archived and other-session groups do not count.
    const idle = r.body.items.find((i) => i.staff_id === f.idle.id);
    expect(idle).toMatchObject({ class_teacher_of: [], subjects: [], load: { groups: 0 } });
    // Someone who left but still teaches Urdu in 5 A is listed so the owner can replace them.
    expect(r.body.items.find((i) => i.staff_id === f.gone.id)).toMatchObject({
      staff_status: 'left',
      roles: [],
      load: { groups: 1, subjects: 1 },
    });
  });

  it('computes the warnings over open groups only', async () => {
    const f = await fixture();
    // Leading two academy batches (not primary groups) is normal, not a double class teacher.
    for (const name of ['Eve-1', 'Eve-2'])
      expect(
        (
          await f.call('POST', '/api/groups', {
            programme_id: f.g8.programme_id,
            name,
            session_id: f.cur.id,
            is_primary: false,
            class_teacher_id: f.idle.id,
          })
        ).status,
      ).toBe(201);
    const { warnings } = (await f.call<TeachersDto>('GET', '/api/teachers')).body;
    expect(warnings.groups_without_class_teacher).toEqual([{ grp_id: f.g8.id, name: 'Class 8 A' }]);
    const english = f.g6.subjects.find((s) => s.subject_name === 'English');
    expect(warnings.subjects_without_teacher).toEqual([
      {
        grp_id: f.g6.id,
        grp_name: 'Class 6 A',
        programme_name: 'Class 6',
        group_name: 'A',
        grp_subject_id: english?.id,
        subject_name: 'English',
      },
    ]);
    expect(warnings.double_class_teachers).toEqual([
      {
        staff_id: f.bilal.id,
        name: 'Bilal',
        groups: [
          { grp_id: f.g6.id, name: 'Class 6 A' },
          { grp_id: f.g7.id, name: 'Class 7 A' },
        ],
      },
    ]);
  });

  it('?session_id= shows another session', async () => {
    const f = await fixture();
    const r = await f.call<TeachersDto>('GET', `/api/teachers?session_id=${f.old.id}`);
    expect(r.body.session_id).toBe(f.old.id);
    // Active teachers are listed in every session (load 0 where they had no work); the one who
    // left had nothing that year, so is not.
    expect(r.body.items.map((i) => [i.name, i.class_teacher_of.map((g) => g.grp_id)])).toEqual([
      ['Amina', []],
      ['Bilal', []],
      ['Idle Teacher', [f.gOld.id]],
      ['New Teacher', []],
    ]);
    expect(r.body.warnings.groups_without_class_teacher).toEqual([]);
    // An unknown session is a 404, not an empty page.
    const bad = await f.call<{ error: { code: string } }>('GET', '/api/teachers?session_id=nope');
    expect(bad.status).toBe(404);
    expect(bad.body.error.code).toBe('not_found');
  });

  it('a no-login teacher can be given a first class through the group endpoint', async () => {
    const f = await fixture();
    expect(
      (await f.call('PATCH', `/api/groups/${f.g8.id}`, { class_teacher_id: f.fresh.id })).status,
    ).toBe(200);
    const r = (await f.call<TeachersDto>('GET', '/api/teachers')).body;
    expect(r.items.find((i) => i.staff_id === f.fresh.id)?.class_teacher_of).toEqual([
      { grp_id: f.g8.id, name: 'Class 8 A' },
    ]);
  });

  it('follows writes made through the group endpoints', async () => {
    const f = await fixture();
    const english = f.g6.subjects.find((s) => s.subject_name === 'English');
    const maths = f.g6.subjects.find((s) => s.subject_name === 'Maths');
    expect(
      (
        await f.call('PUT', `/api/groups/${f.g6.id}/subjects`, {
          subjects: [
            { subject_id: maths?.subject_id, teacher_id: f.amina.id },
            { subject_id: english?.subject_id, teacher_id: f.idle.id },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call('PATCH', `/api/groups/${f.g8.id}`, { class_teacher_id: f.idle.id })).status,
    ).toBe(200);
    const r = (await f.call<TeachersDto>('GET', '/api/teachers')).body;
    expect(r.items.find((i) => i.staff_id === f.idle.id)?.load).toEqual({ groups: 2, subjects: 1 });
    expect(r.warnings.groups_without_class_teacher).toEqual([]);
    expect(r.warnings.subjects_without_teacher).toEqual([]);
  });

  it('is owner/admin only: accountant and teacher 403, no session 401', async () => {
    const f = await fixture();
    const admin = await signedInAs(f.db, ['admin']);
    expect((await f.call('GET', '/api/teachers', undefined, admin.cookie)).status).toBe(200);
    expect((await f.call('GET', '/api/teachers', undefined, f.acct.cookie)).status).toBe(403);
    expect((await f.call('GET', '/api/teachers', undefined, f.amina.cookie)).status).toBe(403);
    const none = await signedInAs(f.db, []);
    expect((await f.call('GET', '/api/teachers', undefined, none.cookie)).status).toBe(403);
    // Parents have no staff session: a request without one is 401.
    expect((await f.request('/api/teachers')).status).toBe(401);
  });
});

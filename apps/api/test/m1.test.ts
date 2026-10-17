import { audit, enrolment, importRun, role, staff, student, user } from '@maktab/db';
import {
  type AdmissionResult,
  type FamilySearchHit,
  type GroupDetailDto,
  type GroupDto,
  type ImportCommitResult,
  type ImportReport,
  newId,
  type Paged,
  type ProgrammeDto,
  type SessionDto,
  type StaffRowDto,
  type StudentDetailDto,
  type StudentListItem,
  type SubjectDto,
} from '@maktab/shared';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { fakeR2, signedInAs, testApp } from './helpers';

type Res<T> = { status: number; body: T };
type ErrorBody = { error: { code: string; message: string } };

/** A tiny JSON client bound to one session cookie. */
function client(request: ReturnType<typeof testApp>['request'], cookie: string) {
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await request(path, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  };
}

/** Wizard essentials: school, current session, PK ladder + subjects, three groups. */
async function setup() {
  const r2 = fakeR2();
  const t = testApp({ env: { FILES: r2.bucket } });
  const owner = await signedInAs(t.db, ['owner']);
  const api = client(t.request, owner.cookie);
  expect((await api('PUT', '/api/school', { name: 'Al-Noor', mode: 'both' })).status).toBe(200);
  const s = await api<SessionDto>('POST', '/api/sessions', {
    name: '2026-27',
    start_date: '2026-04-01',
    end_date: '2027-03-31',
  });
  expect(s.status).toBe(201);
  expect(s.body.is_current).toBe(true);
  const progs = await api<{ items: ProgrammeDto[] }>('POST', '/api/programmes/seed-pk');
  const subs = await api<{ items: SubjectDto[] }>('POST', '/api/subjects/seed-pk');
  const prog = (name: string) => {
    const p = progs.body.items.find((x) => x.name === name);
    if (!p) throw new Error(name);
    return p.id;
  };
  const mkGroup = async (body: Record<string, unknown>) => {
    const g = await api<GroupDto>('POST', '/api/groups', body);
    expect(g.status).toBe(201);
    return g.body;
  };
  const g5a = await mkGroup({ programme_id: prog('Class 5'), name: '5-A', capacity: 30 });
  const g5b = await mkGroup({ programme_id: prog('Class 5'), name: '5-B' });
  const batch = await mkGroup({ programme_id: prog('FSc Pre-Medical'), name: 'Morning batch' });
  return {
    ...t,
    r2,
    owner,
    api,
    session: s.body,
    progs: progs.body.items,
    subs: subs.body.items,
    g5a,
    g5b,
    batch,
    prog,
  };
}

const guardianIn = (phone = '0300-1234567') => ({
  name: 'Imran Khan',
  relation: 'father',
  phone,
  consent_whatsapp: true,
});

async function admit(
  api: ReturnType<typeof client>,
  grpId: string,
  extra: Record<string, unknown> = {},
  name = 'Ali',
) {
  return api<AdmissionResult & ErrorBody>('POST', '/api/admissions', {
    family: { name: 'Khan family', area: 'Gulberg' },
    guardians: [guardianIn()],
    student: { name, father_name: 'Imran Khan', admission_date: '2026-04-05', gender: 'm' },
    enrolment: { grp_id: grpId },
    ...extra,
  });
}

describe('setup wizard data', () => {
  it('seeds the PK ladder idempotently with a next-programme chain', async () => {
    const { api, progs } = await setup();
    expect(progs.filter((p) => p.kind === 'grade').map((p) => p.name)).toEqual([
      'Nursery',
      'KG',
      ...Array.from({ length: 10 }, (_, i) => `Class ${i + 1}`),
    ]);
    expect(progs.filter((p) => p.kind === 'course')).toHaveLength(5);
    const byName = new Map(progs.map((p) => [p.name, p]));
    expect(byName.get('Nursery')?.next_programme_id).toBe(byName.get('KG')?.id);
    expect(byName.get('Class 9')?.next_programme_id).toBe(byName.get('Class 10')?.id);
    expect(byName.get('Class 10')?.next_programme_id).toBeNull();
    const again = await api<{ created: number; items: ProgrammeDto[] }>(
      'POST',
      '/api/programmes/seed-pk',
    );
    expect(again.body.created).toBe(0);
    expect(again.body.items).toHaveLength(progs.length);
    const subs = await api<{ created: number }>('POST', '/api/subjects/seed-pk');
    expect(subs.body.created).toBe(0);
  });

  it('keeps one current session and audits every change', async () => {
    const { api, db, session } = await setup();
    const next = await api<SessionDto>('POST', '/api/sessions', {
      name: '2027-28',
      start_date: '2027-04-01',
      end_date: '2028-03-31',
    });
    expect(next.body.is_current).toBe(false);
    const flip = await api<{ items: SessionDto[] }>(
      'POST',
      `/api/sessions/${next.body.id}/current`,
    );
    expect(flip.body.items.filter((s) => s.is_current).map((s) => s.id)).toEqual([next.body.id]);
    expect(
      (await api('PATCH', `/api/sessions/${session.id}`, { end_date: '2026-01-01' })).status,
    ).toBe(400);
    const rows = await db.select().from(audit).where(eq(audit.entity, 'session'));
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'create', 'set_current']);
    // set-current records what was current before.
    expect(rows.find((r) => r.action === 'set_current')?.diff).toEqual({
      before: { is_current: false, current_session_id: session.id },
      after: { is_current: true, current_session_id: next.body.id },
    });
  });

  it('finishing setup is an explicit owner action, never a side effect of PUT /api/school', async () => {
    const t = await setup();
    // A profile save that still says "setup_completed" is refused, not silently accepted.
    const put = await t.api<ErrorBody>('PUT', '/api/school', {
      name: 'Al-Noor',
      mode: 'both',
      setup_completed: true,
    });
    expect(put.status).toBe(400);
    expect(put.body.error.message).toMatch(/complete-setup/);
    const admin = client(t.request, (await signedInAs(t.db, ['admin'])).cookie);
    expect((await admin('POST', '/api/school/complete-setup')).status).toBe(403);
    const done = await t.api<{ school: { setup_completed_at: string | null } }>(
      'POST',
      '/api/school/complete-setup',
    );
    expect(done.status).toBe(200);
    const at = done.body.school.setup_completed_at;
    expect(at).toBeTruthy();
    // Saving the profile afterwards keeps it complete; completing again keeps the first time.
    expect((await t.api('PUT', '/api/school', { name: 'Al-Noor 2', mode: 'both' })).status).toBe(
      200,
    );
    const again = await t.api<{ school: { setup_completed_at: string | null } }>(
      'POST',
      '/api/school/complete-setup',
    );
    expect(again.body.school.setup_completed_at).toBe(at);
    const audits = await t.db.select().from(audit).where(eq(audit.action, 'complete_setup'));
    expect(audits).toHaveLength(1);
  });

  it('groups: primary by programme kind, seats left, subject teachers', async () => {
    const { api, g5a, batch, subs, owner, db } = await setup();
    expect(g5a.is_primary).toBe(true);
    expect(batch.is_primary).toBe(false);
    expect(g5a.seats_left).toBe(30);
    const tStaff = newId();
    await db.insert(staff).values({ id: tStaff, name: 'Ms Sana', userId: owner.userId });
    const maths = subs.find((s) => s.name === 'Maths');
    const res = await api<GroupDto>('PUT', `/api/groups/${g5a.id}/subjects`, {
      subjects: [{ subject_id: maths?.id, teacher_id: tStaff }],
    });
    expect(res.status).toBe(200);
    expect(res.body.subjects).toEqual([
      expect.objectContaining({ subject_name: 'Maths', teacher_name: 'Ms Sana' }),
    ]);
    const bad = await api<ErrorBody>('PATCH', `/api/groups/${g5a.id}`, {
      class_teacher_id: newId(),
    });
    expect(bad.status).toBe(400);
  });
});

describe('staff and roles', () => {
  it('invites a teacher (user invited + role + profile), refuses duplicates', async () => {
    const { api, db } = await setup();
    const inv = await api<StaffRowDto>('POST', '/api/staff/invite', {
      email: 'Teacher@School.pk',
      role: 'teacher',
      name: 'Ms Sana',
    });
    expect(inv.status).toBe(201);
    expect(inv.body).toMatchObject({
      email: 'teacher@school.pk',
      user_status: 'invited',
      roles: ['teacher'],
    });
    expect(inv.body.staff_id).toBeTruthy();
    const [u] = await db.select().from(user).where(eq(user.email, 'teacher@school.pk'));
    expect(u?.status).toBe('invited');
    const dupe = await api<ErrorBody>('POST', '/api/staff/invite', {
      email: 'teacher@school.pk',
      role: 'admin',
    });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('email_taken');
  });

  it('an owner cannot drop their own owner role, and the last active owner always remains', async () => {
    const { api, db, owner, request } = await setup();
    const self = await api<ErrorBody>('PUT', `/api/users/${owner.userId}/roles`, {
      roles: ['admin'],
    });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe('cannot_remove_self_owner');
    expect(
      (await api<ErrorBody>('POST', `/api/users/${owner.userId}/disable`)).body.error.code,
    ).toBe('cannot_disable_self');
    // Two owners demote each other at the same time: one wins, the other is refused (the DB
    // trigger catches what the per-request check cannot see).
    const other = await signedInAs(db, ['owner']);
    const api2 = client(request, other.cookie);
    const [a, b] = await Promise.all([
      api<ErrorBody>('PUT', `/api/users/${other.userId}/roles`, { roles: ['teacher'] }),
      api2<ErrorBody>('PUT', `/api/users/${owner.userId}/roles`, { roles: ['teacher'] }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    const loser = a.status === 200 ? b : a;
    expect([403, 409]).toContain(loser.status);
    const owners = await db
      .select()
      .from(role)
      .innerJoin(user, eq(user.id, role.userId))
      .where(and(eq(role.role, 'owner'), eq(user.status, 'active')));
    expect(owners).toHaveLength(1);
  });

  it('disable ends sessions; role changes are owner-only', async () => {
    const { api, db, request } = await setup();
    const admin = await signedInAs(db, ['admin']);
    expect((await api('POST', `/api/users/${admin.userId}/disable`)).status).toBe(200);
    expect((await client(request, admin.cookie)('GET', '/api/me')).status).toBe(401);
    expect(
      (await api<StaffRowDto>('POST', `/api/users/${admin.userId}/enable`)).body.user_status,
    ).toBe('invited');
    const admin2 = await signedInAs(db, ['admin']);
    const res = await client(request, admin2.cookie)('PUT', `/api/users/${admin.userId}/roles`, {
      roles: ['owner'],
    });
    expect(res.status).toBe(403);
  });
});

describe('admission (PLAN §14.2)', () => {
  it('new family, sibling found by any phone spelling, numbered per session', async () => {
    const { api, g5a, db } = await setup();
    const first = await admit(api, g5a.id);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      admission_no: '2026-0001',
      roll_no: '1',
      readmitted: false,
    });

    const hit = await api<{ items: FamilySearchHit[] }>(
      'GET',
      `/api/families?phone=${encodeURIComponent('+92 300 1234567')}`,
    );
    expect(hit.body.items).toHaveLength(1);
    expect(hit.body.items[0]?.id).toBe(first.body.family_id);
    expect(hit.body.items[0]?.students.map((s) => s.name)).toEqual(['Ali']);

    const sibling = await api<AdmissionResult>('POST', '/api/admissions', {
      family_id: hit.body.items[0]?.id,
      student: { name: 'Sara', admission_date: '2026-04-06', gender: 'f' },
      enrolment: { grp_id: g5a.id },
    });
    expect(sibling.status).toBe(201);
    expect(sibling.body).toMatchObject({
      family_id: first.body.family_id,
      admission_no: '2026-0002',
      roll_no: '2',
    });

    const list = await api<Paged<StudentListItem>>('GET', '/api/students');
    expect(
      list.body.items.map((s) => [
        s.name,
        s.family_id,
        s.programme_name,
        s.group_name,
        s.guardian_phone,
      ]),
    ).toEqual([
      ['Ali', first.body.family_id, 'Class 5', '5-A', '923001234567'],
      ['Sara', first.body.family_id, 'Class 5', '5-A', '923001234567'],
    ]);
    const byPhone = await api<Paged<StudentListItem>>('GET', '/api/students?q=03001234567');
    expect(byPhone.body.total).toBe(2);
    const audits = await db.select().from(audit).where(eq(audit.entity, 'student'));
    expect(audits.map((a) => a.action)).toEqual(['admit', 'admit']);
    // The audit holds the numbers actually allocated inside the batch, not "auto".
    expect(audits.map((a) => (a.diff as { after: Record<string, unknown> }).after)).toEqual([
      expect.objectContaining({ admission_no: '2026-0001', roll_no: '1' }),
      expect.objectContaining({ admission_no: '2026-0002', roll_no: '2' }),
    ]);
  });

  it('refuses a second active primary enrolment with a clean 409; non-primary is fine', async () => {
    const { api, g5a, g5b, batch } = await setup();
    const a = await admit(api, g5a.id);
    const second = await api<ErrorBody>('POST', '/api/enrolments', {
      student_id: a.body.student_id,
      grp_id: g5b.id,
      start_date: '2026-05-01',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_enrolled');
    const course = await api('POST', '/api/enrolments', {
      student_id: a.body.student_id,
      grp_id: batch.id,
      start_date: '2026-05-01',
    });
    expect(course.status).toBe(201);
  });

  it('capacity is a planning number: a full group still admits', async () => {
    const { api, prog } = await setup();
    const tiny = await api<GroupDto>('POST', '/api/groups', {
      programme_id: prog('Class 7'),
      name: '7-A',
      capacity: 1,
    });
    expect((await admit(api, tiny.body.id)).status).toBe(201);
    const over = await admit(
      api,
      tiny.body.id,
      { guardians: [guardianIn('0345-1234567')] },
      'Zain',
    );
    expect(over.status).toBe(201);
    const g = await api<GroupDto>('GET', `/api/groups/${tiny.body.id}`);
    expect(g.body.seats_left).toBe(-1);
  });

  it('transfer marks the old enrolment transferred and links the new one in one step', async () => {
    const { api, g5a, g5b, db } = await setup();
    const a = await admit(api, g5a.id);
    const moved = await api<{ id: string; prev_enrolment_id: string; grp_id: string }>(
      'POST',
      `/api/enrolments/${a.body.enrolment_id}/transfer`,
      { grp_id: g5b.id, date: '2026-06-01', reason: 'section change' },
    );
    expect(moved.status).toBe(201);
    expect(moved.body).toMatchObject({ grp_id: g5b.id, prev_enrolment_id: a.body.enrolment_id });
    const detail = await api<StudentDetailDto>('GET', `/api/students/${a.body.student_id}`);
    expect(detail.body.enrolments.map((e) => [e.grp_name, e.status])).toEqual([
      ['5-B', 'active'],
      ['5-A', 'transferred'],
    ]);
    const [a1] = await db.select().from(audit).where(eq(audit.action, 'transfer'));
    expect(a1?.diff).toMatchObject({
      before: { grp_id: g5a.id, status: 'active' },
      after: { status: 'transferred', grp_id: g5b.id, roll_no: '1' },
    });
  });

  it('left → re-admission reactivates the student in the same family', async () => {
    const { api, g5a, g5b, db } = await setup();
    const a = await admit(api, g5a.id);
    const left = await api<StudentDetailDto>('POST', `/api/students/${a.body.student_id}/status`, {
      status: 'left',
      date: '2026-09-30',
      reason: 'moved city',
    });
    expect(left.body.status).toBe('left');
    expect(left.body.enrolments[0]?.status).toBe('withdrawn');
    const [leftAudit] = await db.select().from(audit).where(eq(audit.action, 'status'));
    expect(leftAudit?.diff).toMatchObject({
      after: { status: 'left', ended_enrolment_ids: [a.body.enrolment_id] },
    });
    const back = await api<AdmissionResult>('POST', '/api/admissions', {
      readmit_student_id: a.body.student_id,
      enrolment: { grp_id: g5b.id, start_date: '2027-01-10' },
    });
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({
      readmitted: true,
      family_id: a.body.family_id,
      admission_no: '2026-0001',
    });
    const again = await api<ErrorBody>('POST', '/api/admissions', {
      readmit_student_id: a.body.student_id,
      enrolment: { grp_id: g5b.id },
    });
    expect(again.body.error.code).toBe('not_readmittable');
  });

  it('a retried admission (same client ids) is answered, not duplicated', async () => {
    const { api, g5a, db } = await setup();
    const ids = { student_id: newId(), enrolment: { id: newId(), grp_id: g5a.id } };
    const one = await admit(api, g5a.id, ids);
    const two = await admit(api, g5a.id, ids);
    expect(one.status).toBe(201);
    expect(two.status).toBe(200);
    expect(two.body.student_id).toBe(one.body.student_id);
    expect(await db.select().from(student)).toHaveLength(1);
  });

  it('two concurrent admissions in one session get distinct numbers and rolls', async () => {
    const { api, g5a, db } = await setup();
    const results = await Promise.all(
      ['Ali', 'Bilal', 'Hamza', 'Usman'].map((n, i) =>
        admit(api, g5a.id, { guardians: [guardianIn(`0300-123456${i}`)] }, n),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.admission_no)).size).toBe(4);
    expect(new Set(results.map((r) => r.body.roll_no)).size).toBe(4);
    // A hand-typed number ahead of the series is skipped, never collided with.
    const manual = await admit(api, g5a.id, {
      student: { name: 'Zain', admission_date: '2026-04-07', admission_no: '2026-0010' },
      guardians: [guardianIn('0300-7654321')],
    });
    expect(manual.body.admission_no).toBe('2026-0010');
    const next = await admit(api, g5a.id, { guardians: [guardianIn('0301-7654321')] }, 'Omar');
    expect(next.body.admission_no).toBe('2026-0011');
    const taken = await admit(api, g5a.id, {
      student: { name: 'X', admission_date: '2026-04-07', admission_no: '2026-0010' },
      guardians: [guardianIn('0302-7654321')],
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('admission_no_taken');
    expect(await db.select().from(enrolment)).toHaveLength(6);
  });

  it('validates input and custom fields', async () => {
    const { api, g5a } = await setup();
    const badPhone = await admit(api, g5a.id, { guardians: [guardianIn('12345')] });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error.message).toMatch(/invalid_phone/);
    const noFamily = await api<ErrorBody>('POST', '/api/admissions', {
      student: { name: 'A', admission_date: '2026-04-05' },
      enrolment: { grp_id: g5a.id },
    });
    expect(noFamily.status).toBe(400);
    await api('POST', '/api/custom-fields', {
      key: 'blood_group',
      label_en: 'Blood group',
      type: 'text',
    });
    const unknown = await admit(api, g5a.id, {
      student: { name: 'A', admission_date: '2026-04-05', extra: { shoe_size: 4 } },
    });
    expect(unknown.body.error.message).toMatch(/unknown_field/);
    const ok = await admit(api, g5a.id, {
      student: { name: 'A', admission_date: '2026-04-05', extra: { blood_group: 'B+' } },
    });
    expect(ok.status).toBe(201);
    const detail = await api<StudentDetailDto>('GET', `/api/students/${ok.body.student_id}`);
    expect(detail.body.extra).toEqual({ blood_group: 'B+' });
  });
});

describe('teacher row scope', () => {
  it('teacher A cannot read students of group B', async () => {
    const t = await setup();
    const { api, db, request, g5a, g5b, batch, subs } = t;
    const ta = await signedInAs(db, ['teacher']);
    const tb = await signedInAs(db, ['teacher']);
    const [sa, sb] = [newId(), newId()];
    await db.insert(staff).values([
      { id: sa, userId: ta.userId, name: 'A' },
      { id: sb, userId: tb.userId, name: 'B' },
    ]);
    await api('PATCH', `/api/groups/${g5a.id}`, { class_teacher_id: sa });
    await api('PATCH', `/api/groups/${g5b.id}`, { class_teacher_id: sb });
    // Teacher A also teaches one subject in the academy batch.
    await api('PUT', `/api/groups/${batch.id}/subjects`, {
      subjects: [{ subject_id: subs[0]?.id, teacher_id: sa }],
    });
    const inA = await admit(api, g5a.id, {}, 'Ali');
    const inB = await admit(api, g5b.id, { guardians: [guardianIn('0333-1111111')] }, 'Bilal');
    const inBatch = await admit(
      api,
      batch.id,
      { guardians: [guardianIn('0333-2222222')] },
      'Cyrus',
    );
    const teacherA = client(request, ta.cookie);

    const list = await teacherA<Paged<StudentListItem>>('GET', '/api/students');
    expect(list.body.items.map((s) => s.name).sort()).toEqual(['Ali', 'Cyrus']);
    expect((await teacherA('GET', `/api/students/${inB.body.student_id}`)).status).toBe(404);
    expect((await teacherA('GET', `/api/students/${inA.body.student_id}`)).status).toBe(200);
    expect((await teacherA('GET', `/api/students/${inBatch.body.student_id}`)).status).toBe(200);
    expect((await teacherA('GET', `/api/groups/${g5b.id}`)).status).toBe(404);
    expect((await teacherA('GET', `/api/families/${inB.body.family_id}`)).status).toBe(404);
    const fam = await teacherA<{ items: FamilySearchHit[] }>(
      'GET',
      '/api/families?phone=03331111111',
    );
    expect(fam.body.items).toEqual([]);
    const groups = await teacherA<{ items: GroupDto[] }>('GET', '/api/groups');
    expect(groups.body.items.map((g) => g.name).sort()).toEqual(['5-A', 'Morning batch']);
    // mine=1: own groups even for a role that sees every group; none for a non-teacher.
    const accTeacher = await signedInAs(db, ['teacher', 'accountant']);
    const sc = newId();
    await db.insert(staff).values({ id: sc, userId: accTeacher.userId, name: 'C' });
    await api('PATCH', `/api/groups/${g5b.id}`, { class_teacher_id: sc });
    const acc = client(request, accTeacher.cookie);
    expect((await acc<{ items: GroupDto[] }>('GET', '/api/groups')).body.items.length).toBe(3);
    const accMine = await acc<{ items: GroupDto[] }>('GET', '/api/groups?mine=1');
    expect(accMine.body.items.map((g) => g.name)).toEqual(['5-B']);
    const mineA = await teacherA<{ items: GroupDto[] }>('GET', '/api/groups?mine=1');
    expect(mineA.body.items.map((g) => g.name).sort()).toEqual(['5-A', 'Morning batch']);
    expect((await api<{ items: GroupDto[] }>('GET', '/api/groups?mine=1')).body.items).toEqual([]);
    const roster = await teacherA<GroupDetailDto>('GET', `/api/groups/${g5a.id}`);
    expect(roster.body.roster.map((r) => r.name)).toEqual(['Ali']);
    // Teachers read, never write, and see identity numbers masked.
    expect((await teacherA('POST', '/api/admissions', {})).status).toBe(403);
  });
});

describe('student photo (≤ 200 KB, server-side)', () => {
  const jpeg = (size: number) => {
    const b = new Uint8Array(size);
    b.set([0xff, 0xd8, 0xff, 0xe0]);
    return b;
  };
  const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  /** A multipart body with the Content-Length a browser sends (app.request does not add one). */
  const multipart = async (bytes: Uint8Array, type: string, name = 'p.jpg') => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(bytes)], name, type ? { type } : {}));
    const req = new Request('http://x/', { method: 'POST', body: form });
    const body = await req.arrayBuffer();
    return {
      body,
      headers: {
        'content-type': req.headers.get('content-type') ?? '',
        'content-length': String(body.byteLength),
      },
    };
  };
  const upload = async (
    t: Awaited<ReturnType<typeof setup>>,
    path: string,
    bytes: Uint8Array,
    type = 'image/jpeg',
    opts: { length?: boolean } = {},
  ) => {
    const m = await multipart(bytes, type);
    const headers: Record<string, string> = { cookie: t.owner.cookie, ...m.headers };
    if (opts.length === false) delete headers['content-length'];
    return t.request(path, { method: 'POST', body: m.body, headers });
  };

  it('stores a small JPEG, refuses oversize and non-images, serves it back', async () => {
    const t = await setup();
    const a = await admit(t.api, t.g5a.id);
    const path = `/api/students/${a.body.student_id}/photo`;
    expect((await upload(t, path, jpeg(200 * 1024 + 1))).status).toBe(413);
    expect((await upload(t, path, new TextEncoder().encode('<script>'))).status).toBe(415);
    const ok = await upload(t, path, jpeg(90 * 1024));
    expect(ok.status).toBe(200);
    expect(t.r2.objects.size).toBe(1);
    const got = await t.request(path, { headers: { cookie: t.owner.cookie } });
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect((await got.arrayBuffer()).byteLength).toBe(90 * 1024);
  });

  it('requires a declared image type matching the bytes, and a content-length', async () => {
    const t = await setup();
    const a = await admit(t.api, t.g5a.id);
    const path = `/api/students/${a.body.student_id}/photo`;
    // Real JPEG bytes, but declared as something else / not declared.
    expect((await upload(t, path, jpeg(1024), 'text/html')).status).toBe(415);
    expect((await upload(t, path, jpeg(1024), '')).status).toBe(415);
    // Declared PNG, bytes are JPEG (and the other way round).
    expect((await upload(t, path, jpeg(1024), 'image/png')).status).toBe(415);
    expect((await upload(t, path, png(), 'image/jpeg')).status).toBe(415);
    const chunked = await upload(t, path, jpeg(1024), 'image/jpeg', { length: false });
    expect(chunked.status).toBe(411);
    expect((await upload(t, path, png(), 'image/png')).status).toBe(200);
    expect(t.r2.objects.size).toBe(1);
  });

  it('deletes the replaced object after a successful replace (photo and logo)', async () => {
    const t = await setup();
    const a = await admit(t.api, t.g5a.id);
    const path = `/api/students/${a.body.student_id}/photo`;
    expect((await upload(t, path, jpeg(1024))).status).toBe(200);
    const [firstKey] = [...t.r2.objects.keys()];
    expect((await upload(t, path, jpeg(2048))).status).toBe(200);
    expect([...t.r2.objects.keys()]).not.toContain(firstKey);
    expect(t.r2.objects.size).toBe(1);

    expect((await upload(t, '/api/school/logo', png(), 'image/png')).status).toBe(200);
    expect((await upload(t, '/api/school/logo', png(), 'image/png')).status).toBe(200);
    expect([...t.r2.objects.keys()].filter((k) => k.startsWith('school/'))).toHaveLength(1);
  });

  it('answers 501 when no R2 bucket is bound', async () => {
    const t = testApp();
    const owner = await signedInAs(t.db, ['owner']);
    const form = new FormData();
    form.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'p.jpg'));
    const res = await t.request('/api/school/logo', {
      method: 'POST',
      body: form,
      headers: { cookie: owner.cookie },
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as ErrorBody).error.code).toBe('no_storage');
  });
});

describe('CSV import', () => {
  const csv = (rows: string[][]) =>
    `﻿student_name (طالب علم کا نام),father_name,gender,group,guardian_name,guardian_phone,consent_whatsapp\r\n${rows
      .map((r) => r.join(','))
      .join('\r\n')}\r\n`;
  const post = (t: Awaited<ReturnType<typeof setup>>, body: string, dry: boolean) =>
    t.request(`/api/imports/students${dry ? '?dry_run=1' : ''}`, {
      method: 'POST',
      body,
      headers: { cookie: t.owner.cookie, 'content-type': 'text/csv' },
    });

  it('template has the Urdu + English header line', async () => {
    const t = await setup();
    const res = await t.request('/api/imports/students/template.csv', {
      headers: { cookie: t.owner.cookie },
    });
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text.split('\r\n')[0]).toContain('student_name (طالب علم کا نام)');
    expect(text.split('\r\n')[0]).toContain('guardian_phone (سرپرست کا فون)');
  });

  it('dry run reports and writes nothing; commit creates; re-commit is a no-op', async () => {
    const t = await setup();
    const file = csv([
      ['Ali', 'Imran', 'm', '5-A', 'Imran', '0300-1234567', 'yes'],
      ['Sara', 'Imran', 'f', 'Class 5 / 5-A', 'Imran', '+92 300 1234567', 'yes'],
      ['Omar', 'Tariq', 'm', '5-Z', 'Tariq', '0301-7654321', 'no'],
      ['Hina', 'Tariq', 'f', '5-B', 'Tariq', '12345', 'no'],
      ['Zara', '', 'f', 'Morning batch', 'Asma', '042-35761234', ''],
    ]);
    const dry = await post(t, file, true);
    expect(dry.status).toBe(200);
    const report = (await dry.json()) as ImportReport;
    expect(report.rows.map((r) => r.action)).toEqual([
      'create',
      'create',
      'error',
      'error',
      'create',
    ]);
    expect(report.rows[1]?.family).toBe('csv');
    expect(report.rows[2]?.errors.join()).toMatch(/group/);
    expect(report.rows[3]?.errors.join()).toMatch(/guardian_phone/);
    expect(report.rows[4]?.warnings.join()).toMatch(/landline/);
    expect(report.summary).toMatchObject({ families: 2, students: 3, errors: 2 });
    expect(await t.db.select().from(student)).toHaveLength(0);

    const commit = await post(t, file, false);
    expect(commit.status).toBe(201);
    const students = await t.db.select().from(student);
    expect(students.map((s) => s.admissionNo).sort()).toEqual([
      '2026-0001',
      '2026-0002',
      '2026-0003',
    ]);
    const ali = students.find((s) => s.name === 'Ali');
    const sara = students.find((s) => s.name === 'Sara');
    expect(ali?.familyId).toBe(sara?.familyId);
    const rolls = await t.db
      .select({ roll: enrolment.rollNo })
      .from(enrolment)
      .where(eq(enrolment.grpId, t.g5a.id));
    expect(rolls.map((r) => r.roll).sort()).toEqual(['1', '2']);

    const again = (await (await post(t, file, false)).json()) as ImportReport;
    expect(again.rows.map((r) => r.action)).toEqual(['skip', 'skip', 'error', 'error', 'skip']);
    expect(await t.db.select().from(student)).toHaveLength(3);
    // Rows of a sibling admitted by hand later join the same family by phone.
    const later = (await (
      await post(t, csv([['Bilal', 'Imran', 'm', '5-B', 'Imran', '03001234567', 'yes']]), true)
    ).json()) as ImportReport;
    expect(later.rows[0]?.family).toBe('existing');
  });

  it('an archived group (recycle bin) is not in the import pool', async () => {
    const t = await setup();
    await t.db.run(sql`UPDATE grp SET archived_at = '2026-10-01T00:00:00Z' WHERE id = ${t.g5a.id}`);
    const res = await post(
      t,
      csv([['Ali', 'Imran', 'm', '5-A', 'Imran', '0300-1234567', 'yes']]),
      true,
    );
    const report = (await res.json()) as ImportReport;
    expect(report.rows[0]?.action).toBe('error');
    expect(report.rows[0]?.errors.join()).toMatch(/group/);
  });

  it('a commit request takes at most 200 rows; a big file goes in resumable chunks', async () => {
    const t = await setup();
    const rows = Array.from({ length: 450 }, (_, i) => [
      `Student ${i}`,
      'F',
      'm',
      'Morning batch',
      `Guardian ${i}`,
      `0300-${String(1000000 + i)}`,
      'yes',
    ]);
    // The whole file in one commit request is refused (free-tier per-request budget).
    const tooBig = await post(t, csv(rows.slice(0, 201)), false);
    expect(tooBig.status).toBe(413);
    expect(await t.db.select().from(student)).toHaveLength(0);
    // The dry run still reads the whole file.
    const dry = (await (await post(t, csv(rows), true)).json()) as ImportReport;
    expect(dry.summary.students).toBe(450);

    // What the web page does: chunks of 200 in order, carrying offset/total/run_id.
    const commitChunk = async (from: number, runId: string | null) => {
      const q = new URLSearchParams({ offset: String(from), total: '450' });
      if (runId) q.set('run_id', runId);
      const res = await t.request(`/api/imports/students?${q}`, {
        method: 'POST',
        body: csv(rows.slice(from, from + 200)),
        headers: { cookie: t.owner.cookie, 'content-type': 'text/csv' },
      });
      expect(res.status).toBe(201);
      return (await res.json()) as ImportCommitResult;
    };
    const first = await commitChunk(0, null);
    expect([first.applied, first.remaining]).toEqual([200, 250]);
    expect(first.rows[0]?.row).toBe(1);
    // A retried chunk (lost response) applies nothing twice.
    const replay = await commitChunk(0, first.run_id);
    expect([replay.applied, replay.remaining]).toEqual([0, 250]);
    const second = await commitChunk(200, first.run_id);
    expect(second.rows[0]?.row).toBe(201);
    const third = await commitChunk(400, first.run_id);
    expect([second.remaining, third.applied, third.remaining]).toEqual([50, 50, 0]);

    const students = await t.db.select().from(student);
    expect(students).toHaveLength(450);
    expect(new Set(students.map((s) => s.admissionNo)).size).toBe(450);
    const [run] = await t.db.select().from(importRun).where(eq(importRun.id, first.run_id));
    expect(run).toMatchObject({ status: 'committed', created: 450, total: 450 });
    // Families and guardians are audited too, not only students.
    const audits = await t.db.select().from(audit).where(eq(audit.action, 'import'));
    const by = (e: string) => audits.filter((a) => a.entity === e).length;
    expect([by('family'), by('guardian'), by('student')]).toEqual([450, 450, 450]);
    const studentAudit = audits.find((a) => a.entity === 'student');
    expect(studentAudit?.diff).toMatchObject({
      after: { admission_no: expect.stringMatching(/^2026-\d{4}$/), roll_no: expect.any(String) },
    });
  });

  it('re-uploading the same file on another day creates nothing', async () => {
    const t = await setup();
    // No admission_date column: it defaults to "today", which must not change the row's identity.
    const file = csv([['Ali', 'Imran', 'm', '5-B', 'Imran', '0300-1234567', 'yes']]);
    expect((await post(t, file, false)).status).toBe(201);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const again = (await (await post(t, file, false)).json()) as ImportReport;
      expect(again.rows[0]).toMatchObject({ action: 'skip', warnings: ['already imported'] });
    } finally {
      vi.useRealTimers();
    }
    expect(await t.db.select().from(student)).toHaveLength(1);
  });

  it('skips a row whose student already exists (name + father + guardian phone)', async () => {
    const t = await setup();
    await admit(t.api, t.g5a.id); // Ali, father Imran Khan, guardian 0300-1234567
    const file = csv([
      ['ali ', 'Imran  Khan', 'm', '5-B', 'Imran', '+92 300 1234567', 'yes'],
      ['Ali', 'Imran Khan', 'm', '5-B', 'Imran', '0301-7654321', 'yes'],
    ]);
    const dry = (await (await post(t, file, true)).json()) as ImportReport;
    expect(dry.rows.map((r) => r.action)).toEqual(['skip', 'create']);
    expect(dry.rows[0]?.warnings.join()).toMatch(/already a student/);
    // Same name and father but another phone: probably a different child, so only a warning.
    expect(dry.rows[1]?.warnings.join()).toMatch(/name and father name exists/);
    const commit = (await (await post(t, file, false)).json()) as ImportReport;
    expect(commit.rows.map((r) => r.action)).toEqual(['skip', 'create']);
    expect(await t.db.select().from(student)).toHaveLength(2);
  });

  it('warns about capacity only for rows past the group capacity', async () => {
    const t = await setup();
    const small = await t.api<GroupDto>('POST', '/api/groups', {
      programme_id: t.prog('Class 6'),
      name: '6-A',
      capacity: 2,
    });
    await admit(t.api, small.body.id);
    const file = csv(
      ['Sara', 'Omar', 'Hina'].map((n, i) => [n, 'X', 'f', '6-A', 'G', `0333-100000${i}`, 'no']),
    );
    const dry = (await (await post(t, file, true)).json()) as ImportReport;
    expect(dry.rows.map((r) => r.warnings.filter((w) => /capacity/.test(w)))).toEqual([
      [],
      ['group over capacity: 3 of 2'],
      ['group over capacity: 4 of 2'],
    ]);
    // A planning number: the rows are still created.
    expect(dry.summary.students).toBe(3);
  });
});
